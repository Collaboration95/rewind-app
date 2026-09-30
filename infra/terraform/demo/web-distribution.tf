locals {
  public_https_distribution_name = "rewind-demo-web"
}

# This is deliberately opt-in. A Lightsail distribution has a recurring
# charge even when the disposable Demo instance is hibernated, so the default
# Terraform state remains distribution-free.
resource "aws_lightsail_distribution" "web" {
  provider = aws.lightsail_distribution
  count    = var.public_https_distribution_enabled ? 1 : 0

  name            = local.public_https_distribution_name
  bundle_id       = "small_1_0"
  ip_address_type = "ipv4"

  # The origin is the same instance that serves the local Nginx web boundary.
  # The distribution's default domain is HTTPS-enabled and redirects HTTP
  # viewers to HTTPS; the origin itself only exposes the existing HTTP port.
  origin {
    name            = local.instance_name
    region_name     = var.aws_region
    protocol_policy = "http-only"
  }

  default_cache_behavior {
    behavior = "cache"
  }

  # Keep the SPA shell and all runtime requests fresh. Static Expo assets keep
  # their immutable origin cache headers through the default behavior.
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

    # Same-origin requests do not require CORS, but forwarding Origin keeps the
    # existing runtime CORS contract correct for direct API clients. Lightsail
    # forwards Content-Type and other-defined headers by default; the supported
    # cache-vary headers below are the ones this distribution opts into.
    forwarded_headers {
      option             = "allow-list"
      headers_allow_list = ["Accept", "Origin"]
    }

    # Session and group context are query parameters. Forward them even though
    # the API path is explicitly marked dont-cache above.
    forwarded_query_strings {
      option = true
    }
  }

  tags = {
    Environment = "demo"
    AccessScope = "public-https-web"
  }

  depends_on = [aws_lightsail_static_ip_attachment.rewind]

  lifecycle {
    precondition {
      condition     = var.demo_instance_enabled
      error_message = "public_https_distribution_enabled requires demo_instance_enabled=true so the instance origin exists."
    }

    precondition {
      condition     = lookup(var.cost_safety_expected_distributions, local.public_https_distribution_name, null) == local.instance_name
      error_message = "When the public HTTPS distribution is enabled, cost_safety_expected_distributions must allow rewind-demo-web with origin rewind-demo."
    }
  }
}

output "public_https_distribution_domain" {
  description = "HTTPS-enabled default domain for the optional public Demo distribution, or null when disabled."
  value       = try(aws_lightsail_distribution.web[0].domain_name, null)
}

resource "aws_cloudfront_distribution" "real_auth_web" {
  count = var.real_auth_https_distribution_enabled ? 1 : 0

  enabled         = true
  is_ipv6_enabled = true
  comment         = "Rewind Demo real-auth HTTPS distribution"
  price_class     = "PriceClass_100"

  origin {
    domain_name = "ec2-${replace(aws_lightsail_static_ip.rewind[0].ip_address, ".", "-")}.${var.aws_region}.compute.amazonaws.com"
    origin_id   = local.instance_name

    custom_header {
      name  = "X-Rewind-Origin-Auth"
      value = var.public_https_origin_auth_header
    }

    custom_header {
      name  = "X-Forwarded-Proto"
      value = "https"
    }

    custom_origin_config {
      http_port              = 80
      https_port             = 443
      origin_protocol_policy = "http-only"
      origin_ssl_protocols   = ["TLSv1.2"]
    }
  }

  default_cache_behavior {
    target_origin_id       = local.instance_name
    viewer_protocol_policy = "redirect-to-https"
    allowed_methods        = ["GET", "HEAD", "OPTIONS", "PUT", "PATCH", "POST", "DELETE"]
    cached_methods         = ["GET", "HEAD"]
    compress               = true
    cache_policy_id        = data.aws_cloudfront_cache_policy.caching_disabled.id
  }

  ordered_cache_behavior {
    path_pattern             = "/api/*"
    target_origin_id         = local.instance_name
    viewer_protocol_policy   = "redirect-to-https"
    allowed_methods          = ["GET", "HEAD", "OPTIONS", "PUT", "PATCH", "POST", "DELETE"]
    cached_methods           = ["GET", "HEAD"]
    compress                 = true
    cache_policy_id          = data.aws_cloudfront_cache_policy.caching_disabled.id
    origin_request_policy_id = data.aws_cloudfront_origin_request_policy.api_forward_all.id
  }

  ordered_cache_behavior {
    path_pattern             = "/api"
    target_origin_id         = local.instance_name
    viewer_protocol_policy   = "redirect-to-https"
    allowed_methods          = ["GET", "HEAD", "OPTIONS", "PUT", "PATCH", "POST", "DELETE"]
    cached_methods           = ["GET", "HEAD"]
    compress                 = true
    cache_policy_id          = data.aws_cloudfront_cache_policy.caching_disabled.id
    origin_request_policy_id = data.aws_cloudfront_origin_request_policy.api_forward_all.id
  }

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }

  viewer_certificate {
    cloudfront_default_certificate = true
  }

  tags = {
    Environment = "demo"
    AccessScope = "public-https-web"
  }

  depends_on = [aws_lightsail_static_ip_attachment.rewind]

  lifecycle {
    precondition {
      condition     = var.demo_instance_enabled
      error_message = "real_auth_https_distribution_enabled requires demo_instance_enabled=true so the instance origin exists."
    }

    precondition {
      condition     = length(var.public_https_origin_auth_header) >= 32
      error_message = "Set public_https_origin_auth_header to a random secret of at least 32 characters when real-auth CloudFront is enabled."
    }
  }
}

data "aws_cloudfront_cache_policy" "caching_optimized" {
  name = "Managed-CachingOptimized"
}

data "aws_cloudfront_cache_policy" "caching_disabled" {
  name = "Managed-CachingDisabled"
}

data "aws_cloudfront_origin_request_policy" "api_forward_all" {
  name = "Managed-AllViewer"
}

output "real_auth_https_distribution_domain" {
  description = "HTTPS-enabled default CloudFront domain for the optional real-auth endpoint, or null when disabled."
  value       = try(aws_cloudfront_distribution.real_auth_web[0].domain_name, null)
}
