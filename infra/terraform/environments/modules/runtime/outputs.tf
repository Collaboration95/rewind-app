output "environment" {
  value       = var.environment
  description = "Environment identifier."
}

output "instance_name" {
  value       = local.instance_name
  description = "Environment-specific Lightsail host name."
}

output "static_ip" {
  value       = try(aws_lightsail_static_ip.app[0].ip_address, null)
  description = "Environment-specific public IPv4 address, when enabled."
}

output "backup_bucket" {
  value       = aws_s3_bucket.backups.id
  description = "Private environment-specific backup bucket."
}

output "backup_prefix" {
  value       = local.backup_prefix
  description = "Environment-specific backup object prefix."
}

output "https_distribution_domain" {
  value       = try(aws_lightsail_distribution.web[0].domain_name, null)
  description = "HTTPS-enabled provider domain, when the distribution is enabled."
}
