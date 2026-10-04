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

variable "github_oidc_provider_arn" {
  type        = string
  description = "Existing GitHub Actions OIDC provider ARN. Leave null to create one with this root; set it when the account already has one."
  default     = null
  nullable    = true

  validation {
    condition = var.github_oidc_provider_arn == null || can(
      regex("^arn:[^:]+:iam::[0-9]{12}:oidc-provider/token\\.actions\\.githubusercontent\\.com$", var.github_oidc_provider_arn)
    )
    error_message = "github_oidc_provider_arn must be the token.actions.githubusercontent.com OIDC provider ARN when set."
  }
}
