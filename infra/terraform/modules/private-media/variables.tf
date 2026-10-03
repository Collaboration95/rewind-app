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

variable "cors_origin" {
  type = string
  validation {
    condition     = can(regex("^https://[A-Za-z0-9][A-Za-z0-9.-]*(?::[0-9]+)?$", var.cors_origin))
    error_message = "cors_origin must be one exact HTTPS origin without paths or wildcards."
  }
}
