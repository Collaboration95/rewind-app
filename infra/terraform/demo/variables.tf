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

variable "cost_safety_expected_instance_state" {
  type        = string
  description = "Expected Lightsail state for the periodic cost-safety audit; use stopped except during a deliberate hosted Demo window."
  default     = "stopped"

  validation {
    condition     = contains(["running", "stopped"], var.cost_safety_expected_instance_state)
    error_message = "cost_safety_expected_instance_state must be running or stopped."
  }
}
