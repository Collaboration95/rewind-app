provider "aws" {
  region = var.aws_region

  default_tags {
    tags = {
      Project   = "rewind"
      Owner     = "team"
      ManagedBy = "terraform"
    }
  }
}
