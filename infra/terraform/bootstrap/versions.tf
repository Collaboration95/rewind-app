terraform {
  required_version = "~> 1.16.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "= 6.50.0"
    }
  }

  # After the pre-existing bucket is imported into local state, migrate that
  # state with backend.hcl (or equivalent -backend-config arguments).
  backend "s3" {}
}
