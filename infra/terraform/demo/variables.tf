variable "aws_region" {
  type        = string
  description = "The one permitted region for this demo."
  default     = "ap-southeast-1"
}

variable "account_id" {
  type        = string
  description = "Twelve-digit AWS account ID owning the demo."

  validation {
    condition     = can(regex("^[0-9]{12}$", var.account_id))
    error_message = "account_id must be a 12-digit AWS account ID."
  }
}

variable "operator_username" {
  type        = string
  description = "IAM user permitted to assume the demo power-operator role."
  default     = "macos-m1"
}

variable "github_repository" {
  type        = string
  description = "GitHub repository whose dev workflow may assume the Demo host deployment role."
  default     = "Collaboration95/rewind-app"

  validation {
    condition     = can(regex("^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$", var.github_repository))
    error_message = "github_repository must be an owner/repository name."
  }
}

variable "github_repository_immutable" {
  type        = string
  description = "Immutable OIDC subject repository prefix (owner@owner_id/repo@repo_id). GitHub issues this form in the sub claim when immutable subject claims are enabled; the trust policy accepts both this and the classic owner/repo form."
  default     = "Collaboration95@68595032/rewind-app@1354608509"

  validation {
    condition     = can(regex("^[A-Za-z0-9_.-]+@[0-9]+/[A-Za-z0-9_.-]+@[0-9]+$", var.github_repository_immutable))
    error_message = "github_repository_immutable must be an owner@owner_id/repo@repo_id subject prefix."
  }
}

variable "backup_bucket_name" {
  type        = string
  description = "Existing S3 bucket for encrypted demo backups and short-lived release bundles."
}

variable "audit_bucket_name" {
  type        = string
  description = "Existing S3 bucket receiving CloudTrail logs."
}

variable "budget_email_recipients" {
  type        = set(string)
  description = "Email recipients for the budget warning and critical alerts."
  default     = []
}

variable "ssh_cidr" {
  type        = string
  description = "The operator's public IPv4 CIDR permitted to use SSH."
  default     = "27.125.178.53/32"
}

variable "automatic_start_schedule_expression" {
  type        = string
  description = "Optional EventBridge Scheduler expression for automatic startup; null disables scheduled starts."
  default     = null
  nullable    = true
}

variable "automatic_start_schedule_timezone" {
  type        = string
  description = "IANA timezone used only when an automatic-start schedule is enabled."
  default     = "Asia/Singapore"
}

variable "demo_instance_enabled" {
  type        = bool
  description = "Whether the disposable Lightsail runtime should exist. Set false only after a verified S3 backup."
  default     = true
}

variable "real_auth_https_distribution_enabled" {
  type        = bool
  description = "Whether to add a separate CloudFront HTTPS distribution with real-origin authentication."
  default     = false
}

variable "public_https_origin_auth_header" {
  type        = string
  description = "Secret shared with the Demo origin and sent as X-Rewind-Origin-Auth by CloudFront. Set from a secret manager or protected tfvars."
  sensitive   = true
  default     = ""

  validation {
    condition     = !var.real_auth_https_distribution_enabled || length(var.public_https_origin_auth_header) >= 32
    error_message = "Set public_https_origin_auth_header to a random secret of at least 32 characters when the real-auth CloudFront distribution is enabled."
  }
}

variable "retain_static_ip_when_instance_deleted" {
  type        = bool
  description = "Keep the Rewind static IPv4 address while the disposable instance is hibernated. Keeping it preserves the endpoint but has a small recurring charge."
  default     = false
}
