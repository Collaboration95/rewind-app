variable "aws_region" {
  type        = string
  description = "AWS region for prod resources."
  default     = "ap-southeast-1"
}

variable "account_id" {
  type        = string
  description = "Twelve-digit AWS account ID."

  validation {
    condition     = can(regex("^[0-9]{12}$", var.account_id))
    error_message = "account_id must be a 12-digit AWS account ID."
  }
}

variable "instance_enabled" {
  type        = bool
  description = "Whether the prod Lightsail host exists."
  default     = true
}

variable "https_distribution_enabled" {
  type        = bool
  description = "Whether the prod HTTPS provider-domain distribution exists."
  default     = false
}

variable "ssh_cidr" {
  type        = string
  description = "Trusted operator IPv4 CIDR for SSH. Set to an approved /32 before applying."
  default     = "127.0.0.1/32"
}

variable "backup_retention_days" {
  type        = number
  description = "Retention in days for prod backup objects."
  default     = 30
}
