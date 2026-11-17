# Near Service — Terraform variables.
#
# Every value the user must supply is marked REQUIRED below and listed again
# in terraform.tfvars.example. Values with defaults are safe to leave alone
# for a first deployment. No real secret is present anywhere in this file:
# secret variables default to "" and must be supplied at apply time
# (terraform.tfvars, -var, or CI secrets) — never committed.

variable "aws_region" {
  description = "AWS region for all resources. ap-south-1 (Mumbai) is the closest AWS region to Pakistan; change it if the team standardises on another region."
  type        = string
  default     = "ap-south-1"
}

variable "environment" {
  description = "Environment name, used in resource names and tags."
  type        = string
  default     = "production"
}

variable "project" {
  description = "Project slug, used as a prefix for resource names."
  type        = string
  default     = "near-service"
}

# ---------------------------------------------------------------------------
# Domain / DNS — REQUIRED for a public deployment.
# ---------------------------------------------------------------------------

variable "domain" {
  description = "REQUIRED. Root domain for the public deployment, e.g. nearservice.pk. The API is served at api.<domain> and the admin panel at admin.<domain>. The ACM certificate and Ingress hosts use this value."
  type        = string
  default     = ""

  validation {
    condition     = var.domain == "" || can(regex("^[a-z0-9.-]+\\.[a-z]{2,}$", var.domain))
    error_message = "domain must be a bare domain such as nearservice.pk (no scheme, no path)."
  }
}

variable "route53_zone_id" {
  description = "REQUIRED when domain is set. ID of the Route53 hosted zone for var.domain (e.g. Z0123456789ABCDEFGHIJ). Used for ACM DNS validation records. Leave empty to skip DNS/ACM provisioning (certificate must then be created another way)."
  type        = string
  default     = ""
}

# ---------------------------------------------------------------------------
# Networking
# ---------------------------------------------------------------------------

variable "vpc_cidr" {
  description = "CIDR block for the VPC."
  type        = string
  default     = "10.0.0.0/16"
}

variable "availability_zones" {
  description = "Two AZs in var.aws_region. Defaults are ap-south-1a/b; change both entries when changing region."
  type        = list(string)
  default     = ["ap-south-1a", "ap-south-1b"]
}

variable "single_nat_gateway" {
  description = "Use one shared NAT gateway (cheap, single point of failure) instead of one per AZ. Fine for launch; set false for production HA."
  type        = bool
  default     = true
}

# ---------------------------------------------------------------------------
# EKS
# ---------------------------------------------------------------------------

variable "eks_cluster_version" {
  description = "Kubernetes version for the EKS cluster. Must be a version EKS supports at apply time."
  type        = string
  default     = "1.30"
}

variable "node_instance_types" {
  description = "EC2 instance types for the managed node group."
  type        = list(string)
  default     = ["t3.small"]
}

variable "node_desired_size" {
  description = "Desired node count. 2 nodes lets backend + admin + (optional) self-hosted Postgres/Redis spread across AZs."
  type        = number
  default     = 2
}

variable "node_min_size" {
  description = "Minimum node count."
  type        = number
  default     = 1
}

variable "node_max_size" {
  description = "Maximum node count (cluster autoscaler ceiling)."
  type        = number
  default     = 4
}

variable "node_disk_size_gb" {
  description = "Root EBS size per node, in GiB."
  type        = number
  default     = 20
}

# ---------------------------------------------------------------------------
# RDS PostgreSQL — managed alternative to the Postgres StatefulSet in ../k8s/.
# ---------------------------------------------------------------------------

variable "db_engine_version" {
  description = "PostgreSQL engine version. 15.x matches the repo: docker-compose.yml runs postgis/postgis:15-3.4 and db/0001_init.sql runs CREATE EXTENSION postgis/pg_trgm/pgcrypto. RDS PostgreSQL 15 supports the PostGIS extension; the migration enables it, nothing extra to install."
  type        = string
  default     = "15.8"
}

variable "db_instance_class" {
  description = "RDS instance class. db.t4g.micro is the smallest burstable class; raise to db.t4g.small/medium when traffic grows."
  type        = string
  default     = "db.t4g.micro"
}

variable "db_allocated_storage_gb" {
  description = "Initial allocated storage for RDS, in GiB."
  type        = number
  default     = 20
}

variable "db_max_allocated_storage_gb" {
  description = "Autoscaling ceiling for RDS storage, in GiB. 0 disables autoscaling."
  type        = number
  default     = 100
}

variable "db_name" {
  description = "Database name. Must match POSTGRES_DB in the dev compose file."
  type        = string
  default     = "nearservice"
}

variable "db_username" {
  description = "Master username for RDS. Must match POSTGRES_USER in the dev compose file."
  type        = string
  default     = "nearservice"
}

variable "db_multi_az" {
  description = "Run RDS Multi-AZ (standby in the second AZ). False by default for launch cost; set true for production HA."
  type        = bool
  default     = false
}

variable "db_deletion_protection" {
  description = "Prevent accidental deletion of the RDS instance. Keep true in production."
  type        = bool
  default     = true
}

variable "db_backup_retention_days" {
  description = "Automated backup retention, in days. 0 disables automated backups (not recommended)."
  type        = number
  default     = 7
}

# ---------------------------------------------------------------------------
# ElastiCache Redis — managed alternative to the Redis StatefulSet in ../k8s/.
# ---------------------------------------------------------------------------

variable "redis_engine_version" {
  description = "Redis engine version. 7.0 matches the redis:7-alpine image in the dev compose file."
  type        = string
  default     = "7.0"
}

variable "redis_node_type" {
  description = "ElastiCache node type."
  type        = string
  default     = "cache.t4g.micro"
}

variable "redis_num_cache_nodes" {
  description = "Number of cache nodes (1 = single node, no replica). Raise to 2+ with automatic failover for HA."
  type        = number
  default     = 1
}

variable "redis_automatic_failover_enabled" {
  description = "Enable automatic failover. Requires redis_num_cache_nodes >= 2."
  type        = bool
  default     = false
}

# ---------------------------------------------------------------------------
# Container images (ECR repositories are created; images are pushed by CI)
# ---------------------------------------------------------------------------

variable "backend_image_tag" {
  description = "Image tag the backend Deployment should run (e.g. a git SHA). The ECR repository is created here; the image itself is pushed by CI — Terraform does not build images."
  type        = string
  default     = "latest"
}

variable "admin_image_tag" {
  description = "Image tag the admin Deployment should run."
  type        = string
  default     = "latest"
}

# ---------------------------------------------------------------------------
# Uploads bucket (STORAGE_UPLOAD_BASE_URL)
# ---------------------------------------------------------------------------

variable "enable_uploads_bucket" {
  description = "Create the private S3 bucket for provider-document uploads. When false, STORAGE_UPLOAD_BASE_URL stays empty and the backend keeps its local dev receiver behaviour (not suitable for production)."
  type        = bool
  default     = true
}

# ---------------------------------------------------------------------------
# App secrets — REQUIRED. Supplied at apply time only; never committed.
# These land in AWS Secrets Manager (aws_secretsmanager_secret.app_secrets)
# and are read into Kubernetes by the External Secrets Operator (see
# ../k8s/README.md). The DB master password is NOT one of these: it is
# generated by Terraform (random_password) and stored in the same secret.
#
# Generation hints (run locally, paste the output into terraform.tfvars):
#   JWT secrets / OTP hash secret / CNIC pepper:
#     node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
#   FIELD_ENCRYPTION_KEY (base64 of exactly 32 bytes):
#     node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
# ---------------------------------------------------------------------------

variable "jwt_access_secret" {
  description = "REQUIRED. JWT access-token signing secret (>= 32 chars). Must differ from jwt_refresh_secret."
  type        = string
  default     = ""
  sensitive   = true

  validation {
    condition     = var.jwt_access_secret == "" || length(var.jwt_access_secret) >= 32
    error_message = "jwt_access_secret must be at least 32 characters."
  }
}

variable "jwt_refresh_secret" {
  description = "REQUIRED. JWT refresh-token signing secret (>= 32 chars). Must differ from jwt_access_secret."
  type        = string
  default     = ""
  sensitive   = true

  validation {
    condition     = var.jwt_refresh_secret == "" || length(var.jwt_refresh_secret) >= 32
    error_message = "jwt_refresh_secret must be at least 32 characters."
  }
}

variable "cnic_pepper" {
  description = "REQUIRED. HMAC pepper for cnic_hmac (>= 32 chars). The backend refuses to boot in production without it; it is never logged or stored in the DB."
  type        = string
  default     = ""
  sensitive   = true

  validation {
    condition     = var.cnic_pepper == "" || length(var.cnic_pepper) >= 32
    error_message = "cnic_pepper must be at least 32 characters."
  }
}

variable "otp_hash_secret" {
  description = "REQUIRED. Secret used to hash OTP codes (>= 32 chars)."
  type        = string
  default     = ""
  sensitive   = true

  validation {
    condition     = var.otp_hash_secret == "" || length(var.otp_hash_secret) >= 32
    error_message = "otp_hash_secret must be at least 32 characters."
  }
}

variable "field_encryption_key" {
  description = "REQUIRED. AES-256-GCM key for cnic_encrypted / payout_account_encrypted: base64 of exactly 32 bytes."
  type        = string
  default     = ""
  sensitive   = true

  validation {
    condition     = var.field_encryption_key == "" || length(var.field_encryption_key) == 44
    error_message = "field_encryption_key must be base64 of exactly 32 bytes (44 characters including the trailing '=')."
  }
}

variable "payment_gateway_mode" {
  description = "sandbox (default) or live. Live mode refuses to boot unless the live merchant credentials are set — see backend/.env.example. Keep sandbox until merchant onboarding is complete."
  type        = string
  default     = "sandbox"

  validation {
    condition     = contains(["sandbox", "live"], var.payment_gateway_mode)
    error_message = "payment_gateway_mode must be sandbox or live."
  }
}

variable "cors_origins" {
  description = "Browser origins allowed to call the API, comma-separated. Production default is the admin origin only; empty means NO browser origin is allowed (Stage 3, FIX 12)."
  type        = string
  default     = ""
}
