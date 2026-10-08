# Release environment (#230): an independent Lightsail host, HTTPS
# distribution, private media bucket, deploy identity and settings, running
# alongside dev. Deploys come from main through the protected GitHub
# "release" environment (.github/workflows/deploy-release.yml).

provider "aws" {
  region = var.region

  default_tags {
    tags = {
      Project     = "rewind"
      Environment = "release"
    }
  }
}

locals {
  name = "rewind-release"
}

data "aws_iam_openid_connect_provider" "github" {
  url = "https://token.actions.githubusercontent.com"
}

# Same bootstrap as dev: packages, Docker and directories on first boot; the
# first deploy installs the release bundle.
resource "aws_lightsail_instance" "release" {
  name              = local.name
  availability_zone = "${var.region}a"
  blueprint_id      = "ubuntu_24_04"
  bundle_id         = "micro_3_0"
  ip_address_type   = "ipv4"
  user_data         = file("${path.module}/../demo/cloud-init.sh")

  lifecycle {
    ignore_changes = [user_data]
  }
}

resource "aws_lightsail_static_ip" "release" {
  name = "${local.name}-ip"
}

resource "aws_lightsail_static_ip_attachment" "release" {
  static_ip_name = aws_lightsail_static_ip.release.name
  instance_name  = aws_lightsail_instance.release.name
}

# HTTP for the CloudFront origin. SSH only from Lightsail's browser client;
# the deploy workflow opens it to its own runner for the run and closes it.
resource "aws_lightsail_instance_public_ports" "release" {
  instance_name = aws_lightsail_instance.release.name

  port_info {
    protocol  = "tcp"
    from_port = 80
    to_port   = 80
    cidrs     = ["0.0.0.0/0"]
  }

  port_info {
    protocol          = "tcp"
    from_port         = 22
    to_port           = 22
    cidr_list_aliases = ["lightsail-connect"]
  }
}

# Origin secret proving requests came through this distribution.
resource "random_password" "origin_auth" {
  length  = 48
  special = false
}

data "aws_cloudfront_cache_policy" "caching_disabled" {
  name = "Managed-CachingDisabled"
}

data "aws_cloudfront_origin_request_policy" "all_viewer" {
  name = "Managed-AllViewer"
}

resource "aws_cloudfront_distribution" "release" {
  enabled         = true
  is_ipv6_enabled = true
  comment         = "Rewind release HTTPS distribution"
  price_class     = "PriceClass_100"

  origin {
    domain_name = "ec2-${replace(aws_lightsail_static_ip.release.ip_address, ".", "-")}.${var.region}.compute.amazonaws.com"
    origin_id   = local.name

    custom_header {
      name  = "X-Rewind-Origin-Auth"
      value = random_password.origin_auth.result
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
    target_origin_id       = local.name
    viewer_protocol_policy = "redirect-to-https"
    allowed_methods        = ["GET", "HEAD", "OPTIONS", "PUT", "PATCH", "POST", "DELETE"]
    cached_methods         = ["GET", "HEAD"]
    compress               = true
    cache_policy_id        = data.aws_cloudfront_cache_policy.caching_disabled.id
  }

  ordered_cache_behavior {
    path_pattern             = "/api/*"
    target_origin_id         = local.name
    viewer_protocol_policy   = "redirect-to-https"
    allowed_methods          = ["GET", "HEAD", "OPTIONS", "PUT", "PATCH", "POST", "DELETE"]
    cached_methods           = ["GET", "HEAD"]
    compress                 = true
    cache_policy_id          = data.aws_cloudfront_cache_policy.caching_disabled.id
    origin_request_policy_id = data.aws_cloudfront_origin_request_policy.all_viewer.id
  }

  ordered_cache_behavior {
    path_pattern             = "/api"
    target_origin_id         = local.name
    viewer_protocol_policy   = "redirect-to-https"
    allowed_methods          = ["GET", "HEAD", "OPTIONS", "PUT", "PATCH", "POST", "DELETE"]
    cached_methods           = ["GET", "HEAD"]
    compress                 = true
    cache_policy_id          = data.aws_cloudfront_cache_policy.caching_disabled.id
    origin_request_policy_id = data.aws_cloudfront_origin_request_policy.all_viewer.id
  }

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }

  viewer_certificate {
    cloudfront_default_certificate = true
  }

  depends_on = [aws_lightsail_static_ip_attachment.release]
}

locals {
  web_origin = "https://${aws_cloudfront_distribution.release.domain_name}"
}

# Deploy identity: only the protected "release" GitHub environment on main.
data "aws_iam_policy_document" "deploy_trust" {
  statement {
    actions = ["sts:AssumeRoleWithWebIdentity"]
    principals {
      type        = "Federated"
      identifiers = [data.aws_iam_openid_connect_provider.github.arn]
    }
    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:aud"
      values   = ["sts.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:sub"
      values   = var.github_subjects
    }
    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:ref"
      values   = ["refs/heads/main"]
    }
  }
}

resource "aws_iam_role" "deploy" {
  name                 = "${local.name}-deploy"
  description          = "Deploys main to the release host; assumable only from the release environment on main."
  assume_role_policy   = data.aws_iam_policy_document.deploy_trust.json
  max_session_duration = 3600
}

data "aws_iam_policy_document" "deploy" {
  statement {
    sid = "ReachOnlyTheReleaseHost"
    actions = [
      "lightsail:GetInstanceAccessDetails",
      "lightsail:OpenInstancePublicPorts",
      "lightsail:CloseInstancePublicPorts",
    ]
    resources = [aws_lightsail_instance.release.arn]
  }

  statement {
    sid       = "ReadInstanceState"
    actions   = ["lightsail:GetInstance"]
    resources = ["*"]
  }

  statement {
    sid       = "IdentifySession"
    actions   = ["sts:GetCallerIdentity"]
    resources = ["*"]
  }
}

resource "aws_iam_role_policy" "deploy" {
  name   = "${local.name}-deploy-lightsail"
  role   = aws_iam_role.deploy.id
  policy = data.aws_iam_policy_document.deploy.json
}

# Release media and hosted settings, isolated from dev by bucket, IAM user,
# namespace and settings object.
module "media" {
  source = "../media"

  region           = var.region
  environment      = "release"
  web_origins      = [local.web_origin]
  web_push_subject = local.web_origin
  deploy_role_name = aws_iam_role.deploy.name
  # Release signs in through Cognito only; its server refuses password sign-in.
  auth_password = false
  # Release has no host backup bucket yet.
  backup_prefix_arn = null
  extra_hosted_settings = [
    "REWIND_WEB_BIND_ADDRESS=0.0.0.0",
    "REWIND_WEB_PORT=80",
    "REWIND_ALLOW_ORIGIN=${local.web_origin}",
    "REWIND_ORIGIN_AUTH_SECRET=${random_password.origin_auth.result}",
  ]
}
