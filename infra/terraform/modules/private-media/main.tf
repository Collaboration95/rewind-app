terraform {
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "= 6.50.0"
    }
  }
}

data "aws_caller_identity" "current" {}
data "aws_kms_key" "media" {
  key_id = var.kms_key_arn
}

locals {
  bucket_name = "rewind-${var.environment}-media-${var.account_id}"
  policy_vars = {
    bucket_arn  = aws_s3_bucket.media.arn
    environment = var.environment
    account_id  = var.account_id
    kms_key_arn = data.aws_kms_key.media.arn
    aws_region  = var.aws_region
  }
}

resource "aws_s3_bucket" "media" {
  bucket        = local.bucket_name
  force_destroy = false
  tags = {
    Project     = "rewind"
    Environment = var.environment
    DataClass   = "private-media"
    ManagedBy   = "terraform"
  }
  lifecycle {
    prevent_destroy = true
    precondition {
      condition     = data.aws_caller_identity.current.account_id == var.account_id
      error_message = "The caller account must match this environment's reviewed account."
    }
    precondition {
      condition = (
        data.aws_kms_key.media.key_manager == "CUSTOMER" &&
        data.aws_kms_key.media.key_state == "Enabled" &&
        data.aws_kms_key.media.key_usage == "ENCRYPT_DECRYPT" &&
        data.aws_kms_key.media.customer_master_key_spec == "SYMMETRIC_DEFAULT"
      )
      error_message = "Media requires an enabled customer-managed symmetric encryption key."
    }
  }
}

resource "aws_s3_bucket_public_access_block" "media" {
  bucket                  = aws_s3_bucket.media.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_ownership_controls" "media" {
  bucket = aws_s3_bucket.media.id
  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_versioning" "media" {
  bucket = aws_s3_bucket.media.id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "media" {
  bucket = aws_s3_bucket.media.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm     = "aws:kms"
      kms_master_key_id = data.aws_kms_key.media.arn
    }
    # Object-level KMS context enforces the environment prefix in runtime IAM.
    bucket_key_enabled = false
  }
}

resource "aws_s3_bucket_cors_configuration" "media" {
  bucket = aws_s3_bucket.media.id
  cors_rule {
    allowed_origins = [var.cors_origin]
    allowed_methods = ["PUT", "HEAD", "GET"]
    allowed_headers = [
      "content-type", "cache-control", "range",
      "x-amz-checksum-sha256", "x-amz-meta-media-ref",
      "x-amz-expected-bucket-owner", "x-amz-server-side-encryption", "x-amz-tagging",
      "x-amz-server-side-encryption-aws-kms-key-id",
    ]
    expose_headers  = ["ETag", "x-amz-version-id", "x-amz-checksum-sha256", "Content-Range"]
    max_age_seconds = 300
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "media" {
  bucket     = aws_s3_bucket.media.id
  depends_on = [aws_s3_bucket_versioning.media]
  rule {
    id     = "expire-incoming-only"
    status = "Enabled"
    filter {
      and {
        prefix = "${var.environment}/"
        tags   = { "rewind-media-class" = "incoming" }
      }
    }
    expiration {
      days = 1
    }
    noncurrent_version_expiration {
      noncurrent_days = 1
    }
  }
  # Multipart abandonment is not accepted media and does not expire objects.
  rule {
    id     = "abort-unfinished-multipart"
    status = "Enabled"
    filter {
      prefix = "${var.environment}/"
    }
    abort_incomplete_multipart_upload {
      days_after_initiation = 1
    }
  }
}

resource "aws_s3_bucket_policy" "media" {
  bucket     = aws_s3_bucket.media.id
  policy     = templatefile("${path.module}/bucket-policy.json.tftpl", local.policy_vars)
  depends_on = [aws_s3_bucket_public_access_block.media]
}

resource "aws_iam_policy" "runtime_media" {
  name        = "rewind-${var.environment}-private-media"
  description = "Versioned media operations for this environment only; attach through reviewed credential delivery."
  policy      = templatefile("${path.module}/runtime-policy.json.tftpl", local.policy_vars)
  tags = {
    Project     = "rewind"
    Environment = var.environment
  }
}
