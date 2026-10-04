output "bucket" {
  description = "REWIND_MEDIA_S3_BUCKET"
  value       = aws_s3_bucket.media.id
}

output "bucket_owner" {
  description = "REWIND_MEDIA_S3_OWNER"
  value       = data.aws_caller_identity.current.account_id
}

output "region" {
  description = "REWIND_MEDIA_S3_REGION"
  value       = var.region
}

output "runtime_access_key_id" {
  description = "AWS_ACCESS_KEY_ID for the hosted runtime."
  value       = aws_iam_access_key.runtime.id
  sensitive   = true
}

output "runtime_secret_access_key" {
  description = "AWS_SECRET_ACCESS_KEY for the hosted runtime."
  value       = aws_iam_access_key.runtime.secret
  sensitive   = true
}
