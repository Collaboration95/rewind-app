# Private media for the hosted Rewind server (#165, #341). Browsers upload with
# short-lived signed PUT URLs; reads stay behind the application's own
# authorization. Lightsail cannot use instance roles, so the runtime uses a
# dedicated IAM user limited to this bucket.

provider "aws" {
  region = var.region

  default_tags {
    tags = {
      Project     = "rewind"
      Component   = "media"
      Environment = var.environment
    }
  }
}

data "aws_caller_identity" "current" {}

locals {
  name = "rewind-${var.environment}-media"
}

resource "aws_s3_bucket" "media" {
  bucket = "${local.name}-${data.aws_caller_identity.current.account_id}"
}

resource "aws_s3_bucket_ownership_controls" "media" {
  bucket = aws_s3_bucket.media.id
  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_public_access_block" "media" {
  bucket                  = aws_s3_bucket.media.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

# The server pins every object to a version and checks its encryption.
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
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_cors_configuration" "media" {
  bucket = aws_s3_bucket.media.id
  cors_rule {
    allowed_methods = ["PUT"]
    allowed_origins = var.web_origins
    allowed_headers = ["*"]
    expose_headers  = ["ETag", "x-amz-version-id"]
    max_age_seconds = 3000
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "media" {
  bucket = aws_s3_bucket.media.id

  # Uploads that were never finalized or processed.
  rule {
    id     = "expire-abandoned-incoming"
    status = "Enabled"
    filter {
      tag {
        key   = "rewind-media-class"
        value = "incoming"
      }
    }
    expiration {
      days = 7
    }
  }

  rule {
    id     = "expire-old-versions"
    status = "Enabled"
    filter {}
    noncurrent_version_expiration {
      noncurrent_days = 30
    }
    abort_incomplete_multipart_upload {
      days_after_initiation = 1
    }
  }

  depends_on = [aws_s3_bucket_versioning.media]
}

data "aws_iam_policy_document" "bucket" {
  statement {
    sid     = "DenyInsecureTransport"
    effect  = "Deny"
    actions = ["s3:*"]
    resources = [
      aws_s3_bucket.media.arn,
      "${aws_s3_bucket.media.arn}/*",
    ]
    principals {
      type        = "*"
      identifiers = ["*"]
    }
    condition {
      test     = "Bool"
      variable = "aws:SecureTransport"
      values   = ["false"]
    }
  }
}

resource "aws_s3_bucket_policy" "media" {
  bucket     = aws_s3_bucket.media.id
  policy     = data.aws_iam_policy_document.bucket.json
  depends_on = [aws_s3_bucket_public_access_block.media]
}

resource "aws_iam_user" "runtime" {
  name = "${local.name}-runtime"
}

data "aws_iam_policy_document" "runtime" {
  statement {
    sid = "MediaObjects"
    actions = [
      "s3:PutObject",
      "s3:PutObjectTagging",
      "s3:GetObject",
      "s3:GetObjectVersion",
      "s3:GetObjectTagging",
      "s3:GetObjectVersionTagging",
      "s3:DeleteObject",
      "s3:DeleteObjectVersion",
    ]
    resources = ["${aws_s3_bucket.media.arn}/*"]
  }

  statement {
    sid       = "MediaVersions"
    actions   = ["s3:ListBucket", "s3:ListBucketVersions"]
    resources = [aws_s3_bucket.media.arn]
  }

  # The daily host backup uploads with these keys, and the PostgreSQL import
  # (deploy/database-import.sh) reads a backup back. No delete: the backup
  # bucket is versioned, so earlier backups cannot be overwritten or removed.
  dynamic "statement" {
    for_each = var.backup_prefix_arn == null ? [] : [var.backup_prefix_arn]
    content {
      sid       = "HostBackups"
      actions   = ["s3:PutObject", "s3:GetObject"]
      resources = [statement.value]
    }
  }

  dynamic "statement" {
    for_each = var.backup_prefix_arn == null ? [] : [var.backup_prefix_arn]
    content {
      sid       = "ListHostBackups"
      actions   = ["s3:ListBucket"]
      resources = [regex("^arn:aws:s3:::[^/]+", statement.value)]
      condition {
        test     = "StringLike"
        variable = "s3:prefix"
        values   = [replace(statement.value, "/^arn:aws:s3:::[^/]+\\//", "")]
      }
    }
  }
}

resource "aws_iam_user_policy" "runtime" {
  name   = "${local.name}-objects"
  user   = aws_iam_user.runtime.name
  policy = data.aws_iam_policy_document.runtime.json
}

resource "aws_iam_access_key" "runtime" {
  user = aws_iam_user.runtime.name
}

# Shared login for the read-only /admin table browser (user "admin").
resource "random_password" "admin" {
  length  = 32
  special = false
}

# Hosted settings for the dev deploy. Terraform writes them here and the deploy
# workflow streams them to the server (deploy/release-host.sh configure), so
# no person or agent copies the runtime credentials anywhere. Web push keys are
# generated on the server itself and never leave it.
resource "aws_s3_object" "hosted_env" {
  bucket                 = aws_s3_bucket.media.id
  key                    = "_config/${var.environment}.env"
  content_type           = "text/plain"
  server_side_encryption = "AES256"
  content = sensitive(join("\n", concat([
    "REWIND_MEDIA_BACKEND=s3",
    "REWIND_MEDIA_ENVIRONMENT=${var.environment}",
    "REWIND_MEDIA_S3_BUCKET=${aws_s3_bucket.media.id}",
    "REWIND_MEDIA_S3_OWNER=${data.aws_caller_identity.current.account_id}",
    "REWIND_MEDIA_S3_REGION=${var.region}",
    "AWS_REGION=${var.region}",
    "AWS_ACCESS_KEY_ID=${aws_iam_access_key.runtime.id}",
    "AWS_SECRET_ACCESS_KEY=${aws_iam_access_key.runtime.secret}",
    "REWIND_REMINDER_VAPID_SUBJECT=${var.web_push_subject}",
    "REWIND_REQUEST_TIMING=true",
    "REWIND_ADMIN_PASSWORD=${random_password.admin.result}",
  ], local.database_hosted_settings, var.extra_hosted_settings, [""])))
}

data "aws_iam_policy_document" "deploy_reads_hosted_env" {
  statement {
    actions   = ["s3:GetObject"]
    resources = ["${aws_s3_bucket.media.arn}/${aws_s3_object.hosted_env.key}"]
  }
}

resource "aws_iam_role_policy" "deploy_reads_hosted_env" {
  name   = "rewind-${var.environment}-read-hosted-env"
  role   = var.deploy_role_name
  policy = data.aws_iam_policy_document.deploy_reads_hosted_env.json
}
