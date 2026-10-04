output "environment" {
  value       = module.environment.environment
  description = "Environment identifier."
}

output "instance_name" {
  value       = module.environment.instance_name
  description = "Dev Lightsail host name."
}

output "static_ip" {
  value       = module.environment.static_ip
  description = "Dev public IPv4 address, when enabled."
}

output "backup_bucket" {
  value       = module.environment.backup_bucket
  description = "Private dev backup bucket."
}

output "backup_prefix" {
  value       = module.environment.backup_prefix
  description = "Dev backup object prefix."
}

output "https_distribution_domain" {
  value       = module.environment.https_distribution_domain
  description = "HTTPS-enabled dev provider domain, when enabled."
}
