provider "aws" {
  region = var.aws_region

  default_tags {
    tags = {
      Project     = "rewind"
      Environment = "prod"
      ManagedBy   = "terraform"
    }
  }
}

provider "aws" {
  alias  = "lightsail_distribution"
  region = "us-east-1"

  default_tags {
    tags = {
      Project     = "rewind"
      Environment = "prod"
      ManagedBy   = "terraform"
    }
  }
}
