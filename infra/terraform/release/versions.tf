terraform {
  required_version = "~> 1.16.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "= 6.50.0"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.7"
    }
  }

  # Own state: rewind/release/terraform.tfstate. Nothing here addresses the
  # live dev (demo) root's resources.
  backend "s3" {}
}
