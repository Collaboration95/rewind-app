terraform {
  required_version = "~> 1.16.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "= 6.50.0"
    }
  }

  # Separate state from the live demo root: rewind/media/terraform.tfstate.
  backend "s3" {}
}
