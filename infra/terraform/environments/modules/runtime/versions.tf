terraform {
  required_version = "~> 1.16.0"

  required_providers {
    aws = {
      source                = "hashicorp/aws"
      version               = "= 6.50.0"
      configuration_aliases = [aws.lightsail_distribution]
    }
  }
}
