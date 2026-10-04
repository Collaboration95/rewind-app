locals {
  name_prefix        = "rewind-${var.environment}"
  instance_name      = "${local.name_prefix}-app"
  static_ip_name     = "${local.name_prefix}-ip"
  backup_bucket_name = "rewind-${var.environment}-backups-${var.account_id}"
  distribution_name  = "${local.name_prefix}-web"
  backup_prefix      = "${var.environment}/backups/"
}

resource "aws_lightsail_instance" "app" {
  count             = var.instance_enabled ? 1 : 0
  name              = local.instance_name
  availability_zone = "${var.aws_region}a"
  blueprint_id      = "ubuntu_24_04"
  bundle_id         = "micro_3_0"
  ip_address_type   = "ipv4"

  tags = {
    Environment = var.environment
    Project     = "rewind"
  }
}

resource "aws_lightsail_static_ip" "app" {
  count = var.instance_enabled ? 1 : 0
  name  = local.static_ip_name
}

resource "aws_lightsail_static_ip_attachment" "app" {
  count          = var.instance_enabled ? 1 : 0
  static_ip_name = aws_lightsail_static_ip.app[0].name
  instance_name  = aws_lightsail_instance.app[0].name
}

resource "aws_lightsail_instance_public_ports" "app" {
  count         = var.instance_enabled ? 1 : 0
  instance_name = aws_lightsail_instance.app[0].name

  port_info {
    protocol  = "tcp"
    from_port = 80
    to_port   = 80
    cidrs     = ["0.0.0.0/0"]
  }

  port_info {
    protocol  = "tcp"
    from_port = 22
    to_port   = 22
    cidrs     = [var.ssh_cidr]
  }
}

resource "aws_s3_bucket" "backups" {
  bucket = local.backup_bucket_name

  tags = {
    Environment = var.environment
    DataClass   = "${var.environment}-backup"
  }
}

resource "aws_s3_bucket_public_access_block" "backups" {
  bucket                  = aws_s3_bucket.backups.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_server_side_encryption_configuration" "backups" {
  bucket = aws_s3_bucket.backups.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_versioning" "backups" {
  bucket = aws_s3_bucket.backups.id

  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "backups" {
  bucket = aws_s3_bucket.backups.id

  rule {
    id     = "expire-${var.environment}-backups"
    status = "Enabled"

    filter {
      prefix = local.backup_prefix
    }

    expiration {
      days = var.backup_retention_days
    }

    noncurrent_version_expiration {
      noncurrent_days = 7
    }
  }
}

resource "aws_lightsail_distribution" "web" {
  provider = aws.lightsail_distribution
  count    = var.https_distribution_enabled && var.instance_enabled ? 1 : 0

  name            = local.distribution_name
  bundle_id       = "small_1_0"
  ip_address_type = "ipv4"

  origin {
    name            = local.instance_name
    region_name     = var.aws_region
    protocol_policy = "http-only"
  }

  default_cache_behavior {
    behavior = "cache"
  }

  cache_behavior {
    path     = "/index.html"
    behavior = "dont-cache"
  }

  cache_behavior {
    path     = "/api"
    behavior = "dont-cache"
  }

  cache_behavior {
    path     = "/api/*"
    behavior = "dont-cache"
  }

  cache_behavior_settings {
    allowed_http_methods = "GET,HEAD,OPTIONS,PUT,PATCH,POST,DELETE"
    cached_http_methods  = "GET,HEAD"
    default_ttl          = 86400
    maximum_ttl          = 31536000
    minimum_ttl          = 0

    forwarded_cookies {
      option = "none"
    }

    forwarded_headers {
      option             = "allow-list"
      headers_allow_list = ["Accept", "Origin"]
    }

    forwarded_query_strings {
      option = true
    }
  }

  tags = {
    Environment = var.environment
    Project     = "rewind"
  }
}
