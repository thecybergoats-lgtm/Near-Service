# Near Service — Terraform (AWS)
#
# Provisions the cloud infrastructure for the existing stack (see
# ../docker-compose.yml for the local dev equivalent):
#   - VPC (2 AZs, public + private subnets, 1 NAT gateway)
#   - EKS cluster + managed node group (runs the backend + admin Deployments
#     in ../k8s/)
#   - RDS PostgreSQL 15 + PostGIS (managed alternative to the Postgres
#     StatefulSet in ../k8s/ — use ONE of the two, not both)
#   - ElastiCache Redis 7 (managed alternative to the Redis StatefulSet)
#   - ECR repositories for the backend + admin images
#   - Secrets Manager secret holding every app secret (JWT keys, CNIC
#     pepper, OTP hash secret, field-encryption key, DB password)
#   - S3 bucket for provider-document uploads (STORAGE_UPLOAD_BASE_URL)
#   - ACM certificate + Route53 validation records (only when a domain is
#     supplied — see variables.tf)
#
# PROVIDER: AWS only. This is not multi-cloud; nothing here provisions any
# other cloud.
#
# NOTHING IS APPLIED FROM THIS VM. There is no AWS account, no cluster and
# no state backend configured here. To use this for real:
#   1. `terraform init` (needs AWS credentials with EKS/RDS/ElastiCache/ECR
#      permissions) and a remote state backend (see backend.tf comment below).
#   2. Copy terraform.tfvars.example to terraform.tfvars and fill in every
#      value marked REQUIRED. Never commit terraform.tfvars.
#   3. `terraform plan` / `terraform apply`.
#   4. `aws eks update-kubeconfig --name <cluster>` then apply ../k8s/.

terraform {
  required_version = ">= 1.5.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
  }

  # Remote state is REQUIRED before any real apply — local state would hold
  # secret values on disk. Uncomment and fill in after creating the bucket
  # (with versioning + encryption) and the DynamoDB lock table:
  # backend "s3" {
  #   bucket         = "REPLACE_ME-near-service-tfstate"
  #   key            = "near-service/terraform.tfstate"
  #   region         = "ap-south-1"
  #   dynamodb_table = "REPLACE_ME-near-service-tf-lock"
  #   encrypt        = true
  # }
}

provider "aws" {
  region = var.aws_region

  default_tags {
    tags = {
      Project     = "near-service"
      Environment = var.environment
      ManagedBy   = "terraform"
    }
  }
}
