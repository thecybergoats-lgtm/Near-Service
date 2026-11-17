# Near Service — data layer, registries, secrets, uploads, TLS.
#
# CHOICE TO MAKE AT DEPLOY TIME (documented in ../README.md):
#   Managed (recommended): RDS + ElastiCache from this file, and set
#   self_hosted_data = false in the K8s manifests (do not apply the
#   postgres/redis StatefulSets).
#   Self-hosted: do NOT apply this file's RDS/ElastiCache resources
#   (or apply them and leave them idle — do not do that, it costs money),
#   and instead apply the StatefulSets in ../k8s/.

# ------------------------------------------------------------- Security ----

resource "aws_security_group" "rds" {
  name        = "${local.name}-rds"
  description = "PostgreSQL access from EKS nodes only"
  vpc_id      = aws_vpc.main.id

  ingress {
    description     = "PostgreSQL from EKS nodes"
    from_port       = 5432
    to_port         = 5432
    protocol        = "tcp"
    security_groups = [aws_eks_cluster.main.vpc_config[0].cluster_security_group_id]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = { Name = "${local.name}-rds-sg" }
}

resource "aws_security_group" "redis" {
  name        = "${local.name}-redis"
  description = "Redis access from EKS nodes only"
  vpc_id      = aws_vpc.main.id

  ingress {
    description     = "Redis from EKS nodes"
    from_port       = 6379
    to_port         = 6379
    protocol        = "tcp"
    security_groups = [aws_eks_cluster.main.vpc_config[0].cluster_security_group_id]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = { Name = "${local.name}-redis-sg" }
}

# ------------------------------------------------------------- RDS --------
# PostgreSQL 15 + PostGIS. RDS PostgreSQL supports the postgis extension;
# db/0001_init.sql enables it with CREATE EXTENSION IF NOT EXISTS postgis,
# so the migration runs unchanged against RDS.

resource "random_password" "db_master" {
  length  = 32
  special = false # keep the password URL-safe for DATABASE_URL
}

resource "aws_db_subnet_group" "main" {
  name       = "${local.name}-db-subnet-group"
  subnet_ids = aws_subnet.private[*].id

  tags = { Name = "${local.name}-db-subnet-group" }
}

resource "aws_db_instance" "main" {
  identifier     = "${local.name}-postgres"
  engine         = "postgres"
  engine_version = var.db_engine_version
  instance_class = var.db_instance_class

  allocated_storage     = var.db_allocated_storage_gb
  max_allocated_storage = var.db_max_allocated_storage_gb
  storage_type          = "gp3"
  storage_encrypted     = true

  db_name  = var.db_name
  username = var.db_username
  password = random_password.db_master.result

  db_subnet_group_name   = aws_db_subnet_group.main.name
  vpc_security_group_ids = [aws_security_group.rds.id]
  publicly_accessible    = false
  multi_az               = var.db_multi_az

  backup_retention_period   = var.db_backup_retention_days
  deletion_protection       = var.db_deletion_protection
  skip_final_snapshot       = false
  final_snapshot_identifier = "${local.name}-postgres-final"

  # Migrations run from the backend pod / CI (npm run migrate), not from
  # Terraform — the DB must exist before the backend boots.
  apply_immediately = false

  tags = { Name = "${local.name}-postgres" }
}

# ------------------------------------------------------- ElastiCache ----

resource "aws_elasticache_subnet_group" "main" {
  name       = "${local.name}-redis-subnet-group"
  subnet_ids = aws_subnet.private[*].id
}

resource "aws_elasticache_replication_group" "main" {
  replication_group_id = "${var.project}-${var.environment}-redis"
  description          = "Near Service Redis (sessions, OTP rate limits, realtime)"

  engine               = "redis"
  engine_version       = var.redis_engine_version
  node_type            = var.redis_node_type
  num_cache_clusters   = var.redis_num_cache_nodes
  parameter_group_name = "default.redis7"
  port                 = 6379

  subnet_group_name  = aws_elasticache_subnet_group.main.name
  security_group_ids = [aws_security_group.redis.id]

  automatic_failover_enabled = var.redis_automatic_failover_enabled
  at_rest_encryption_enabled = true
  transit_encryption_enabled = false # true requires TLS in REDIS_URL; the backend uses plain redis:// — see ../k8s/README.md

  apply_immediately = false

  tags = { Name = "${local.name}-redis" }
}

# ------------------------------------------------------------- ECR --------

resource "aws_ecr_repository" "backend" {
  name                 = "${var.project}/backend"
  image_tag_mutability = "IMMUTABLE"
  force_delete         = false

  image_scanning_configuration {
    scan_on_push = true
  }
}

resource "aws_ecr_repository" "admin" {
  name                 = "${var.project}/admin"
  image_tag_mutability = "IMMUTABLE"
  force_delete         = false

  image_scanning_configuration {
    scan_on_push = true
  }
}

resource "aws_ecr_lifecycle_policy" "backend" {
  repository = aws_ecr_repository.backend.name

  policy = jsonencode({
    rules = [{
      rulePriority = 1
      description  = "Keep the last 10 images"
      selection = {
        tagStatus   = "any"
        countType   = "imageCountMoreThan"
        countNumber = 10
      }
      action = { type = "expire" }
    }]
  })
}

resource "aws_ecr_lifecycle_policy" "admin" {
  repository = aws_ecr_repository.admin.name

  policy = jsonencode({
    rules = [{
      rulePriority = 1
      description  = "Keep the last 10 images"
      selection = {
        tagStatus   = "any"
        countType   = "imageCountMoreThan"
        countNumber = 10
      }
      action = { type = "expire" }
    }]
  })
}

# --------------------------------------------------- Secrets Manager ----
# One secret holds everything the backend needs that must not live in git:
# the DB password (generated here), the full DATABASE_URL / REDIS_URL the
# backend actually reads, and every app secret from variables.tf. The
# External Secrets Operator in the cluster syncs this into the Kubernetes
# Secret that the backend Deployment mounts (see ../k8s/README.md).

resource "aws_secretsmanager_secret" "app" {
  name        = "${local.name}/app"
  description = "Near Service backend secrets (DB URLs + JWT/CNIC/OTP/encryption secrets). Managed by Terraform; values supplied via terraform.tfvars, never committed."
}

resource "aws_secretsmanager_secret_version" "app" {
  secret_id = aws_secretsmanager_secret.app.id

  secret_string = jsonencode({
    DATABASE_URL      = "postgres://${var.db_username}:${random_password.db_master.result}@${aws_db_instance.main.address}:${aws_db_instance.main.port}/${var.db_name}"
    REDIS_URL         = "redis://${aws_elasticache_replication_group.main.primary_endpoint_address}:${aws_elasticache_replication_group.main.port}"
    POSTGRES_PASSWORD = random_password.db_master.result

    JWT_ACCESS_SECRET    = var.jwt_access_secret
    JWT_REFRESH_SECRET   = var.jwt_refresh_secret
    CNIC_PEPPER          = var.cnic_pepper
    OTP_HASH_SECRET      = var.otp_hash_secret
    FIELD_ENCRYPTION_KEY = var.field_encryption_key
  })
}

# ------------------------------------------------- Uploads bucket (S3) ----

resource "aws_s3_bucket" "uploads" {
  count  = var.enable_uploads_bucket ? 1 : 0
  bucket = "${local.name}-uploads"

  tags = { Name = "${local.name}-uploads" }
}

resource "aws_s3_bucket_public_access_block" "uploads" {
  count  = var.enable_uploads_bucket ? 1 : 0
  bucket = aws_s3_bucket.uploads[0].id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_versioning" "uploads" {
  count  = var.enable_uploads_bucket ? 1 : 0
  bucket = aws_s3_bucket.uploads[0].id

  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "uploads" {
  count  = var.enable_uploads_bucket ? 1 : 0
  bucket = aws_s3_bucket.uploads[0].id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

# ------------------------------------------------------------ TLS / DNS ----
# Created only when var.domain and var.route53_zone_id are both set.
# The certificate covers api.<domain> and admin.<domain> — the two hosts
# in ../k8s/ingress.yaml.

resource "aws_acm_certificate" "main" {
  count = var.domain != "" && var.route53_zone_id != "" ? 1 : 0

  domain_name               = "api.${var.domain}"
  subject_alternative_names = ["admin.${var.domain}"]
  validation_method         = "DNS"

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_route53_record" "acm_validation" {
  for_each = var.domain != "" && var.route53_zone_id != "" ? {
    for dvo in aws_acm_certificate.main[0].domain_validation_options : dvo.domain_name => {
      name   = dvo.resource_record_name
      record = dvo.resource_record_value
      type   = dvo.resource_record_type
    }
  } : {}

  allow_overwrite = true
  name            = each.value.name
  records         = [each.value.record]
  ttl             = 60
  type            = each.value.type
  zone_id         = var.route53_zone_id
}

resource "aws_acm_certificate_validation" "main" {
  count = var.domain != "" && var.route53_zone_id != "" ? 1 : 0

  certificate_arn         = aws_acm_certificate.main[0].arn
  validation_record_fqdns = [for record in aws_route53_record.acm_validation : record.fqdn]
}
