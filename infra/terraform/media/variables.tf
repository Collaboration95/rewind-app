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
