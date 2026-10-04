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
