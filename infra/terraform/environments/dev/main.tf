terraform {
  required_version = "~> 1.16.0"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "= 6.50.0"
    }
  }
  backend "s3" {}
}

provider "aws" {
  region              = var.aws_region
  allowed_account_ids = [var.account_id]
}

variable "account_id" {
  type = string
}

variable "aws_region" {
  type    = string
  default = "ap-southeast-1"
}

variable "cors_origin" {
  type = string
}

variable "kms_key_arn" {
  type = string
}

module "private_media" {
  source      = "../../modules/private-media"
  environment = "dev"
  account_id  = var.account_id
  cors_origin = var.cors_origin
  aws_region  = var.aws_region
  kms_key_arn = var.kms_key_arn
}

output "private_media" {
  value = {
    bucket_name        = module.private_media.bucket_name
    runtime_policy_arn = module.private_media.runtime_policy_arn
    runtime_configuration = merge(module.private_media.runtime_configuration, {
      REWIND_MEDIA_S3_REGION = var.aws_region
    })
  }
}
