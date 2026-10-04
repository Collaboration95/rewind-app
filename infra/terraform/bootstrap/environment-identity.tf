# Preparatory only. Enabling this map requires separate human IAM review,
# an existing GitHub OIDC provider and configured protected environments.
# No change to the existing bootstrap access roles or provider configuration.
variable "environment_identity_media_keys" {
  description = "Disabled by default; opt in with reviewed dev/prod existing media KMS key ARNs."
  type        = map(string)
  default     = {}
  validation {
    condition     = alltrue([for environment in keys(var.environment_identity_media_keys) : contains(["dev", "prod"], environment)])
    error_message = "Only dev/prod media identities are in scope."
  }
}

module "environment_identity" {
  for_each    = var.environment_identity_media_keys
  source      = "../modules/environment-identity"
  environment = each.key
  kms_key_arn = each.value
}

output "environment_identity_roles" {
  value = { for environment, identity in module.environment_identity : environment => identity.role_arns }
}
