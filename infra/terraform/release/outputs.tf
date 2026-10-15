output "web_url" {
  description = "Release app URL."
  value       = local.web_origin
}

output "instance_name" {
  description = "REWIND_RELEASE_INSTANCE repository variable."
  value       = aws_lightsail_instance.release.name
}

output "deploy_role_arn" {
  description = "AWS_RELEASE_DEPLOY_ROLE_ARN repository variable."
  value       = aws_iam_role.deploy.arn
}

output "hosted_env_uri" {
  description = "REWIND_RELEASE_HOSTED_ENV_URI repository variable."
  value       = module.media.hosted_env_uri
}

output "database_bootstrap_uri" {
  description = "Release environment REWIND_DATABASE_BOOTSTRAP_URI variable."
  value       = module.media.database_bootstrap_uri
}

output "database_name" {
  description = "Isolated release managed PostgreSQL database."
  value       = module.media.database_name
}

output "backup_bucket" {
  description = "Release-only logical backup bucket."
  value       = aws_s3_bucket.backups.id
}
