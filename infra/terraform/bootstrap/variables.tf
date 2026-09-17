variable "aws_region" {
  type        = string
  description = "AWS region for the Rewind demo foundation."
  default     = "ap-southeast-1"
}

variable "account_id" {
  type        = string
  description = "Twelve-digit AWS account ID owning this state bucket."

  validation {
    condition     = can(regex("^[0-9]{12}$", var.account_id))
    error_message = "account_id must be a 12-digit AWS account ID."
  }
}

variable "state_bucket_name" {
  type        = string
  description = "Existing private S3 bucket used as the Terraform backend."
}

variable "operator_username" {
  type        = string
  description = "IAM user permitted to assume the read-only coding-agent role."
  default     = "macos-m1"
}
