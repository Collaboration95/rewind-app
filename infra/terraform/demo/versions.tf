terraform {
  required_version = "~> 1.16.0"

  required_providers {
    archive = {
      source  = "hashicorp/archive"
      version = "~> 2.7.0"
    }

    aws = {
      source  = "hashicorp/aws"
      version = "= 6.50.0"
    }
  }

  backend "s3" {}
}
