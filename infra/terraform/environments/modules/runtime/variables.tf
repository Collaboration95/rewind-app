variable "environment" {
  type        = string
  description = "Short isolated environment identifier."

  validation {
    condition     = contains(["dev", "prod"], var.environment)
    error_message = "environment must be dev or prod."
  }
}

variable "aws_region" {
  type        = string
  description = "AWS region for the environment resources."
  default     = "ap-southeast-1"
}

variable "account_id" {
  type        = string
  description = "AWS account ID used to construct globally unique bucket names."

  validation {
    condition     = can(regex("^[0-9]{12}$", var.account_id))
    error_message = "account_id must be a 12-digit AWS account ID."
  }
}

variable "instance_enabled" {
  type        = bool
  description = "Whether the environment Lightsail instance exists."
  default     = true
}

variable "https_distribution_enabled" {
  type        = bool
  description = "Whether to create this environment's HTTPS-enabled provider-domain distribution."
  default     = false
}

variable "ssh_cidr" {
  type        = string
  description = "Trusted operator IPv4 CIDR for SSH. Set to an approved /32 before applying."
  default     = "127.0.0.1/32"
}

variable "backup_retention_days" {
  type        = number
  description = "Lifecycle retention for environment backup objects."
  default     = 30
}
