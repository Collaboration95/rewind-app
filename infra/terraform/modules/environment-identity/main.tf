terraform {
  required_version = "~> 1.16.0"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "= 6.50.0"
    }
  }
}

variable "environment" {
  type = string
  validation {
    condition     = contains(["dev", "prod"], var.environment)
    error_message = "Only the accepted dev/prod media roots are supported."
  }
}

variable "kms_key_arn" {
  type = string
  validation {
    condition     = can(regex("^arn:aws:kms:ap-southeast-1:330599756236:key/[A-Za-z0-9-]+$", var.kms_key_arn))
    error_message = "Supply the existing reviewed media key in account 330599756236, ap-southeast-1."
  }
}

data "aws_caller_identity" "current" {}

locals {
  branch = var.environment == "dev" ? "dev" : "main"
  policies = {
    for operation in ["plan", "apply"] : operation => templatefile("${path.module}/${operation}-policy.json.tftpl", {
      environment = var.environment
      kms_key_arn = var.kms_key_arn
    })
  }
}

# The same policy is the role's permission grant and its upper boundary.
# Additional role attachments cannot expand this reviewed resource allowlist.
resource "aws_iam_policy" "boundary" {
  for_each = local.policies
  name     = "rewind-${var.environment}-terraform-${each.key}-boundary"
  policy   = each.value
  lifecycle {
    precondition {
      condition     = data.aws_caller_identity.current.account_id == "330599756236"
      error_message = "Environment identities must be prepared in the reviewed Rewind account."
    }
  }
}

resource "aws_iam_role" "environment" {
  for_each             = local.policies
  name                 = "rewind-${var.environment}-terraform-${each.key}"
  max_session_duration = 3600
  permissions_boundary = aws_iam_policy.boundary[each.key].arn
  assume_role_policy = templatefile("${path.module}/trust.json.tftpl", {
    environment = var.environment
    operation   = each.key
    branch      = local.branch
  })
}

resource "aws_iam_role_policy" "environment" {
  for_each = local.policies
  name     = "reviewed-media-and-state"
  role     = aws_iam_role.environment[each.key].id
  policy   = each.value
}

output "role_arns" {
  value = { for operation, role in aws_iam_role.environment : operation => role.arn }
}
