locals {
  public_https_distribution_name = "rewind-demo-web"
}

# This is deliberately opt-in. A Lightsail distribution has a recurring
# charge even when the disposable Demo instance is hibernated, so the default
# Terraform state remains distribution-free.
resource "aws_lightsail_distribution" "web" {
  count = var.public_https_distribution_enabled ? 1 : 0

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
    allowed_http_methods = "GET,HEAD,OPTIONS,POST,PUT,DELETE,PATCH"
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
