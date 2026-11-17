# Near Service — Infrastructure (Phase 4, Item 6)

Formalizes the existing stack as code. Nothing here has been applied to any
cloud or cluster — there is no AWS account, no Kubernetes cluster and no
Docker in this environment. Everything was written and validated only
(see "Validation" below).

## Provider

**AWS only.** This is not multi-cloud. Terraform provisions AWS resources;
the Kubernetes manifests run on the EKS cluster Terraform creates.

## What lives here

```
infra/
├── README.md                          # this file
├── .gitignore                         # terraform state + terraform.tfvars
├── docker-compose.prod.env.example    # env vars for docker-compose.prod.yml
├── terraform/                         # AWS: VPC, EKS, RDS, ElastiCache,
│   ├── versions.tf                    #   ECR, Secrets Manager, S3, ACM
│   ├── variables.tf                   #   every variable, documented
│   ├── main.tf                        #   VPC + EKS
│   ├── data.tf                        #   RDS + ElastiCache + ECR +
│   │                                  #   Secrets Manager + S3 + ACM
│   ├── outputs.tf
│   └── terraform.tfvars.example       #   every user-supplied value
└── k8s/                               # Kubernetes manifests (1.28+)
    ├── README.md                      #   compose -> K8s mapping, apply order
    ├── 00-namespace.yaml
    ├── 01-configmap.yaml              #   non-secret config
    ├── 02-secret.yaml                 #   PLACEHOLDER ONLY — see below
    ├── 10-postgres.yaml               #   self-hosted path only
    ├── 11-redis.yaml                  #   self-hosted path only
    ├── 20-backend.yaml                #   Deployment + Service
    ├── 21-admin.yaml                  #   Deployment + Service
    └── 30-ingress.yaml                #   api/admin hosts + TLS
```

Plus, at the repo root (the one file outside `infra/` this item owns):

- `docker-compose.prod.yml` — standalone production compose file. It
  **replaces** `docker-compose.yml` in production (it does not merge with
  it): `docker compose -f docker-compose.prod.yml --env-file .env.prod up -d`.

## The stack, as formalized

Source of truth is `docker-compose.yml` + `backend/.env.example` +
`backend/src/modules/health/health.controller.ts`:

| Piece | Dev (compose) | Prod (this item) |
|---|---|---|
| Postgres | `postgis/postgis:15-3.4`, DB/user `nearservice` | RDS PostgreSQL 15 (PostGIS via `CREATE EXTENSION` in `db/0001_init.sql`) **or** StatefulSet `10-postgres.yaml` — pick one |
| Redis | `redis:7-alpine` | ElastiCache Redis 7 **or** StatefulSet `11-redis.yaml` — pick one |
| Backend | NestJS `:3000`, prefix `/api/v1` | EKS Deployment (2 replicas), liveness `/api/v1/health`, readiness `/api/v1/ready` |
| Admin | Next.js, host `:3001` | EKS Deployment (2 replicas), container port 3001, probes on `/` |
| Ingress | host ports 3000/3001 | `api.<domain>` → backend, `admin.<domain>` → admin, TLS via cert-manager or ALB + ACM |

**Version note:** the task brief for this item said "Postgres 16", but the
repo is definitively Postgres 15 (`postgis/postgis:15-3.4` in
`docker-compose.yml`, "PostgreSQL 15 + PostGIS" in `db/0001_init.sql`).
Everything here uses **15** to match the running stack. Moving to 16 is a
separate decision (RDS engine upgrade + image change), not silently done
here.

## Secrets — the rule

No real secret exists anywhere in this item. Secrets are:

1. **Declared** as Terraform variables (`variables.tf`, defaults `""`,
   validated for length at plan time) and documented in
   `terraform.tfvars.example`.
2. **Stored** by Terraform in AWS Secrets Manager (one secret, output
   `app_secrets_arn`), including the generated DB master password and the
   full `DATABASE_URL` / `REDIS_URL`.
3. **Synced into Kubernetes** by the External Secrets Operator (see
   `k8s/README.md` for the exact ExternalSecret). `k8s/02-secret.yaml`
   contains only `REPLACE_ME_*` placeholders and must not be applied as-is.

Never commit `terraform.tfvars`, `.env.prod`, or a filled-in copy of
`02-secret.yaml`.

## docker-compose.prod.yml — what changed vs dev

- Images from a registry (`BACKEND_IMAGE` / `ADMIN_IMAGE`), not `build:`.
- `restart: unless-stopped`, CPU/memory limits, JSON log rotation on every
  service.
- No dev defaults: every secret is `${VAR:?…}` — compose fails fast
  instead of booting on a placeholder.
- `NODE_ENV=production`, `OTP_DEV_MODE=false`.
- Postgres/Redis ports are **not** published to the host; backend/admin bind
  to `127.0.0.1` only (put a reverse proxy in front for public traffic).
- Named volumes `pgdata-prod` / `redisdata-prod`, separate from dev's
  `pgdata`.
- Backend healthcheck still uses `/api/v1/ready`; admin healthcheck fetches
  `/` on container port 3001.

## Before applying for real (checklist)

1. **AWS account + credentials** with permissions for EKS, RDS,
   ElastiCache, ECR, Secrets Manager, S3, ACM, Route53, VPC, IAM.
2. **Remote Terraform state**: uncomment the `s3` backend in
   `terraform/versions.tf` and create the state bucket (versioned,
   encrypted) + lock table first. Local state would hold secret values.
3. **Fill in `terraform.tfvars`** from `terraform.tfvars.example`
   (domain, Route53 zone ID, all five app secrets — generated fresh, never
   the dev values).
4. **Build the container images.** Dockerfiles now exist (Fix C,
   2026-11-17): `backend/Dockerfile` (build context = repo root) and
   `admin/Dockerfile` (build context = `admin/`). CI builds both images
   on every push/PR (`.github/workflows/ci.yml`, `docker-build` job —
   build only, no push yet). Push them to the ECR repos Terraform
   creates before applying the K8s manifests, e.g.:
   `docker build -f backend/Dockerfile -t <backend-ecr-url>:<tag> .`
   and `docker build -t <admin-ecr-url>:<tag> ./admin`.
5. **Admin listen port — RESOLVED (Fix C, 2026-11-17).** The admin
   listens on port **3001 everywhere**: `admin/package.json`,
   `admin/Dockerfile` (`PORT=3001`), both compose files (`3001:3001`),
   `k8s/21-admin.yaml` and the Ingress admin service port (`3001`).
6. **Install cluster add-ons**: an ingress controller (ingress-nginx by
   default, or AWS Load Balancer Controller for the ALB + ACM option),
   cert-manager with a `letsencrypt-prod` ClusterIssuer (or use the ACM
   certificate Terraform creates), and the External Secrets Operator with
   a SecretStore pointing at Secrets Manager.
7. **DNS**: `api.<domain>` and `admin.<domain>` must resolve to the
   ingress load balancer.
8. **Migrations**: the backend does not auto-migrate. After first deploy,
   run `npm run migrate` + `npm run seed` from a backend pod (K8s) or
   `docker compose exec backend` (compose prod).
9. **HA hardening (optional, launch defaults are single-AZ cheap)**:
   `single_nat_gateway = false`, `db_multi_az = true`, ElastiCache with
   2+ nodes + automatic failover. Redis transit encryption is off because
   the backend connects over plain `redis://` — turning it on needs a
   `rediss://` URL and TLS in the backend Redis client (a code change).

## Validation

Run in this VM on 2026-11-17 (no cluster, no cloud account, no Docker):

- **Terraform**: `apt-get install -y terraform` → "Unable to locate package
  terraform" (no HashiCorp apt repo configured; adding it was out of scope
  for a validation-only run). Instead the Terraform 1.9.8 Linux binary was
  downloaded directly from releases.hashicorp.com (27 MB, quick) and run
  from /tmp. `terraform init -backend=false` installed hashicorp/aws
  v5.100.0. `terraform fmt` fixed alignment in `data.tf`/`main.tf`, then
  `terraform fmt -check` exit 0 and `terraform validate` →
  "Success! The configuration is valid." (exit 0). `terraform plan` was
  NOT run — it needs real AWS credentials.
- **Kubernetes**: kubeval 0.16.1 (downloaded from GitHub releases) with
  `--kubernetes-version 1.28.0 --strict`, schemas from the yannh
  kubernetes-json-schema mirror (kubeval's default schema host,
  kubernetesjsonschema.dev, returns an empty reply from this VM):
  **all 8 files PASS, 12 documents, 0 errors** — Namespace, ConfigMap,
  Secret, 2× Service + StatefulSet (Postgres, Redis), 2× Deployment +
  Service (backend, admin), Ingress. A Python cross-reference check
  confirmed every `configMapKeyRef`/`secretKeyRef` resolves to a defined
  key, every Service selector matches a workload, every
  `matchLabels` is a subset of its pod labels, and both Ingress backends
  exist. `kubectl apply --dry-run=client` could NOT validate: kubectl
  downloads the OpenAPI schema from a live API server, and there is no
  server (connection refused to the dummy kubeconfig) — kubeval strict is
  the validator that passed.
- **YAML parse**: Python `yaml.safe_load_all` on all 8 manifests +
  `docker-compose.prod.yml` — all parse, 13 documents total.
- **docker compose**: `docker compose -f docker-compose.prod.yml config`
  → `docker: command not found` (Docker is not installed in this VM).
  The prod file was validated by YAML parse + the structural check above
  (4 services, all with restart/limits/healthchecks, DB ports unexposed,
  7 required `${VAR:?}` env vars on backend).

## Not verified (honest list)

- Nothing was applied to any cluster or cloud account. No EKS cluster,
  RDS instance, ElastiCache node, ECR repository, Secrets Manager secret,
  S3 bucket or ACM certificate exists as a result of this work.
- `terraform plan` was not run (it needs real AWS credentials).
- The manifests were never applied to a cluster; probes, resource limits,
  PVC provisioning and Ingress routing are validated structurally only.
- `docker compose config` could not run (no Docker in this VM).
- The backend/admin images were not built, pushed, or pulled in this VM
  (no Docker here) — the Dockerfiles exist and CI builds them, but no
  image has been built or run anywhere yet.
