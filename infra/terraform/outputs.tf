# Near Service — outputs. Use these after `terraform apply` to wire up
# kubectl and the Kubernetes manifests (see ../k8s/README.md).
# No output contains a secret value.

output "cluster_name" {
  description = "EKS cluster name — used by `aws eks update-kubeconfig --name <this>`."
  value       = aws_eks_cluster.main.name
}

output "cluster_endpoint" {
  description = "EKS cluster API endpoint."
  value       = aws_eks_cluster.main.endpoint
}

output "cluster_region" {
  description = "AWS region of the cluster."
  value       = var.aws_region
}

output "vpc_id" {
  description = "VPC ID."
  value       = aws_vpc.main.id
}

output "private_subnet_ids" {
  description = "Private subnet IDs (EKS nodes, RDS, ElastiCache)."
  value       = aws_subnet.private[*].id
}

output "rds_endpoint" {
  description = "RDS PostgreSQL endpoint (address only; the full DATABASE_URL lives in Secrets Manager)."
  value       = aws_db_instance.main.address
}

output "rds_port" {
  description = "RDS PostgreSQL port."
  value       = aws_db_instance.main.port
}

output "redis_endpoint" {
  description = "ElastiCache Redis primary endpoint (address only; the full REDIS_URL lives in Secrets Manager)."
  value       = aws_elasticache_replication_group.main.primary_endpoint_address
}

output "redis_port" {
  description = "ElastiCache Redis port."
  value       = aws_elasticache_replication_group.main.port
}

output "backend_ecr_repository_url" {
  description = "ECR repository for the backend image. CI pushes <this>:<tag>; the backend Deployment uses it."
  value       = aws_ecr_repository.backend.repository_url
}

output "admin_ecr_repository_url" {
  description = "ECR repository for the admin image."
  value       = aws_ecr_repository.admin.repository_url
}

output "app_secrets_arn" {
  description = "Secrets Manager ARN holding DATABASE_URL, REDIS_URL and all app secrets. The External Secrets Operator in the cluster reads this ARN."
  value       = aws_secretsmanager_secret.app.arn
}

output "uploads_bucket_name" {
  description = "S3 bucket for provider-document uploads. Empty when enable_uploads_bucket is false."
  value       = var.enable_uploads_bucket ? aws_s3_bucket.uploads[0].id : ""
}

output "uploads_base_url" {
  description = "Value for STORAGE_UPLOAD_BASE_URL in the backend ConfigMap. Empty when enable_uploads_bucket is false."
  value       = var.enable_uploads_bucket ? "https://${aws_s3_bucket.uploads[0].id}.s3.${var.aws_region}.amazonaws.com" : ""
}

output "acm_certificate_arn" {
  description = "ACM certificate ARN for api.<domain> / admin.<domain>. Empty when no domain was supplied. The Ingress annotates this ARN for the AWS Load Balancer Controller."
  value       = var.domain != "" && var.route53_zone_id != "" ? aws_acm_certificate_validation.main[0].certificate_arn : ""
}

output "api_url" {
  description = "Public API base URL (once the Ingress is applied). Empty when no domain was supplied."
  value       = var.domain != "" ? "https://api.${var.domain}/api/v1" : ""
}

output "admin_url" {
  description = "Public admin panel URL (once the Ingress is applied). Empty when no domain was supplied."
  value       = var.domain != "" ? "https://admin.${var.domain}" : ""
}
