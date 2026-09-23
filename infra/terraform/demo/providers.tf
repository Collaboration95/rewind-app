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

# Lightsail distribution APIs use us-east-1 even when the origin is elsewhere.
# Keep the default provider regional; only the distribution selects this alias.
provider "aws" {
  alias  = "lightsail_distribution"
  region = "us-east-1"

  default_tags {
    tags = {
      Project   = "rewind"
      Owner     = "team"
      ManagedBy = "terraform"
    }
  }
}
