variable "region" {
  description = "AWS region for the media bucket; matches the hosted server."
  type        = string
  default     = "ap-southeast-1"
}

variable "environment" {
  description = "Media namespace, also used in resource names."
  type        = string
  default     = "dev"
}

variable "web_origins" {
  description = "HTTPS origins allowed to upload directly to the bucket with signed PUT URLs."
  type        = list(string)
  # The hosted app, plus `make run-real` for local checks. Uploads still need
  # a server-signed URL; CORS only controls which pages may send them.
  default = ["https://d2m6kz76y4kuvm.cloudfront.net", "http://localhost:8090"]
}

variable "web_push_subject" {
  description = "VAPID subject the server sends with web push (an https: or mailto: contact)."
  type        = string
  default     = "https://d2m6kz76y4kuvm.cloudfront.net"
}

variable "deploy_role_name" {
  description = "GitHub Actions deploy role that streams the hosted settings to the server."
  type        = string
  default     = "rewind-demo-deploy"
}

variable "extra_hosted_settings" {
  description = "Additional allowlisted KEY=VALUE settings for this environment's host (for example the release origin secret)."
  type        = list(string)
  default     = []
  sensitive   = true
}
