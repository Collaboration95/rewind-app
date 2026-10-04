variable "region" {
  description = "AWS region; matches the dev environment."
  type        = string
  default     = "ap-southeast-1"
}

variable "github_subjects" {
  description = "GitHub OIDC subjects allowed to deploy release (the release environment, by name and immutable id)."
  type        = list(string)
  default = [
    "repo:Collaboration95/rewind-app:environment:release",
    "repo:Collaboration95@68595032/rewind-app@1354608509:environment:release",
  ]
}
