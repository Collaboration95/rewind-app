output "bucket_name" {
  value = aws_s3_bucket.media.id
}

output "runtime_policy_arn" {
  value = aws_iam_policy.runtime_media.arn
}

output "runtime_policy_json" {
  value = aws_iam_policy.runtime_media.policy
}

output "runtime_configuration" {
  value = {
    REWIND_MEDIA_BACKEND        = "s3"
    REWIND_MEDIA_ENVIRONMENT    = var.environment
    REWIND_MEDIA_S3_BUCKET      = aws_s3_bucket.media.id
    REWIND_MEDIA_S3_OWNER       = var.account_id
    REWIND_MEDIA_S3_KMS_KEY_ARN = data.aws_kms_key.media.arn
  }
}
