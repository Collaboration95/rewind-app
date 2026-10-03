variable "environment" {
  type = string
  validation {
    condition     = contains(["dev", "prod"], var.environment)
    error_message = "environment must be dev or prod."
  }
}

variable "account_id" {
  type = string
  validation {
    condition     = can(regex("^[0-9]{12}$", var.account_id))
    error_message = "account_id must be an explicit 12-digit AWS account."
  }
}

variable "aws_region" {
  type = string
  validation {
    condition     = can(regex("^[a-z]{2}-[a-z]+-[0-9]+$", var.aws_region))
    error_message = "aws_region must be an explicit commercial AWS Region."
  }
}

variable "kms_key_arn" {
  type = string
  validation {
    condition = can(regex(
      "^arn:aws:kms:${var.aws_region}:${var.account_id}:key/[A-Za-z0-9-]+$",
      var.kms_key_arn
    ))
    error_message = "kms_key_arn must identify the reviewed key in this account and Region."
  }
}

variable "cors_origin" {
  type = string
  validation {
    condition     = can(regex("^https://[A-Za-z0-9][A-Za-z0-9.-]*(?::[0-9]+)?$", var.cors_origin))
    error_message = "cors_origin must be one exact HTTPS origin without paths or wildcards."
  }
}
