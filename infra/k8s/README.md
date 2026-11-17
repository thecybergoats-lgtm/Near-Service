# Near Service — Kubernetes manifests

Applies the local dev stack (`../docker-compose.yml`) to a cluster, in the
`near-service` namespace. Target Kubernetes 1.28+.

## Honesty note

There is **no cluster and no cloud account in this environment**. These
manifests were written and validated (kubeval + YAML parse — see
`../README.md`) but **never applied**. Nothing here has run anywhere.
Before applying for real, finish the checklist in `../README.md`.

## How each manifest maps to docker-compose.yml

| Manifest | Compose service | Notes |
|---|---|---|
| `00-namespace.yaml` | — | Namespace `near-service` for everything below. |
| `01-configmap.yaml` | `backend` + `admin` `environment:` | Non-secret env only. `NODE_ENV=production`, `OTP_DEV_MODE=false`, `CORS_ORIGINS=https://admin.nearservice.pk`, `NEXT_PUBLIC_API_URL=https://api.nearservice.pk/api/v1`. |
| `02-secret.yaml` | `backend` `environment:` (secrets) | **PLACEHOLDER ONLY — do not apply as-is.** See "Secrets" below. |
| `10-postgres.yaml` | `postgres` | StatefulSet, `postgis/postgis:15-3.4`, DB/user `nearservice`, `pg_isready` probes, 20 Gi PVC. Self-hosted path only — skip if using RDS. |
| `11-redis.yaml` | `redis` | StatefulSet, `redis:7-alpine`, `--appendonly yes`, `redis-cli ping` probes, 5 Gi PVC. Self-hosted path only — skip if using ElastiCache. |
| `20-backend.yaml` | `backend` | Deployment (2 replicas), port 3000, liveness `/api/v1/health`, readiness `/api/v1/ready`, resources 250m/256Mi → 500m/512Mi, ClusterIP Service. |
| `21-admin.yaml` | `admin` | Deployment (2 replicas), container port 3001, probes on `/`, resources 100m/128Mi → 250m/256Mi, ClusterIP Service. |
| `30-ingress.yaml` | `ports: 3000/3001` | `api.nearservice.pk` → backend:3000, `admin.nearservice.pk` → admin:3001, TLS via cert-manager (or ALB + ACM — see the file header). |

## Pick ONE data path

- **Managed (recommended):** apply `infra/terraform/` (RDS Postgres 15 +
  PostGIS, ElastiCache Redis 7). Then do **not** apply `10-postgres.yaml`
  or `11-redis.yaml`. `DATABASE_URL` / `REDIS_URL` come from Secrets
  Manager (Terraform writes them there).
- **Self-hosted:** apply `10-postgres.yaml` and `11-redis.yaml`, and do
  not provision RDS/ElastiCache. Single replica each — no Postgres or
  Redis HA in this item (that would be Patroni / Redis Cluster, out of
  scope).

## Secrets (production path)

1. Apply Terraform, then install the External Secrets Operator in the
   cluster and create this ExternalSecret (replace the ARN with the
   Terraform output `app_secrets_arn`):

   ```yaml
   apiVersion: external-secrets.io/v1beta1
   kind: ExternalSecret
   metadata:
     name: near-service-secrets
     namespace: near-service
   spec:
     refreshInterval: 1h
     secretStoreRef:
       name: near-service-aws # a ClusterSecretStore/SecretStore pointing at Secrets Manager
       kind: ClusterSecretStore
     target:
       name: near-service-secrets # the name the Deployments already reference
       creationPolicy: Owner
     dataFrom:
       - extract:
           key: "<terraform output app_secrets_arn>"
   ```

   The Secrets Manager secret holds exactly the keys the Deployments read:
   `DATABASE_URL`, `REDIS_URL`, `POSTGRES_PASSWORD`, `JWT_ACCESS_SECRET`,
   `JWT_REFRESH_SECRET`, `CNIC_PEPPER`, `OTP_HASH_SECRET`,
   `FIELD_ENCRYPTION_KEY`.
2. Do **not** apply `02-secret.yaml` with its placeholder values. It exists
   so the key names and the self-hosted fallback are explicit, and so a
   quick test cluster can be stood up from a filled-in copy (never commit
   the filled copy).

## Images

The Deployments use `near-service-backend:latest` /
`near-service-admin:latest` as placeholders. Replace them with the ECR
repository URLs from `terraform output`:

```bash
BACKEND_REPO=$(terraform -chdir=../terraform output -raw backend_ecr_repository_url)
ADMIN_REPO=$(terraform -chdir=../terraform output -raw admin_ecr_repository_url)
# CI builds the images from backend/Dockerfile and admin/Dockerfile
# (see .github/workflows/ci.yml, docker-build job — build only, no push
# yet); push them, then set e.g.:
#   image: ${BACKEND_REPO}:<git-sha>
```

## Ingress prerequisites

- An ingress controller: `ingress-nginx` for the default
  `ingressClassName: nginx`, or the AWS Load Balancer Controller if the
  ALB + ACM option in `30-ingress.yaml` is chosen.
- TLS: cert-manager with a `letsencrypt-prod` ClusterIssuer (default), or
  the ACM certificate Terraform creates (see the Ingress header comment).
- DNS: `api.<domain>` and `admin.<domain>` must resolve to the ingress
  load balancer. Terraform creates the ACM validation records only; the
  A/alias records for the load balancer are created when the Ingress is
  applied (external-dns) or by hand.

## Apply order

```bash
kubectl apply -f 00-namespace.yaml
kubectl apply -f 01-configmap.yaml
# secrets via ExternalSecret (see above) — NOT 02-secret.yaml as-is
kubectl apply -f 20-backend.yaml -f 21-admin.yaml
# self-hosted data path only:
kubectl apply -f 10-postgres.yaml -f 11-redis.yaml
kubectl apply -f 30-ingress.yaml
```

Then run migrations + seed once from a backend pod (the backend does not
auto-migrate):

```bash
kubectl -n near-service exec deploy/backend -- npm run migrate
kubectl -n near-service exec deploy/backend -- npm run seed
```

## Known issues / open items

1. **Admin listen port — RESOLVED (Fix C, 2026-11-17).** The admin now
   listens on port **3001 everywhere**: `admin/package.json`
   (`next start -p 3001`), `admin/Dockerfile` (`PORT=3001`),
   `docker-compose.yml` / `docker-compose.prod.yml` (`3001:3001`),
   `21-admin.yaml` (`containerPort` / Service `3001`) and the Ingress
   (`admin` service port `3001`).
2. **CI builds but does not push images yet.** The `docker-build` job in
   `.github/workflows/ci.yml` builds both images (build only, no push),
   so a broken Dockerfile fails CI; pushing to ECR is a separate step
   (needs AWS credentials in CI) and is not wired up.
3. **Redis transit encryption is off** in Terraform
   (`transit_encryption_enabled = false`) because the backend connects
   with a plain `redis://` URL. Turning it on requires a `rediss://` URL
   and TLS support in the backend Redis client — a code change, not an
   infra change.
4. **Single NAT gateway** is the Terraform default (cheap, single point of
   failure). Set `single_nat_gateway = false` and `db_multi_az = true` for
   production HA.
5. **Postgres/Redis are single-replica** in the self-hosted path. Managed
   RDS/ElastiCache is the HA path.
