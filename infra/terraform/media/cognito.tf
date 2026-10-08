# Amazon Cognito sign-in (Sprint 3). One user pool per environment: this root
# is the dev pool, and release gets its own through the same module call
# (`environment = "release"`). Rewind's server does the authorization-code +
# PKCE token exchange, so the app client is public and holds no secret.
#
# Speed over hardening (no real users): no MFA, deletion protection off,
# default Cognito sender, no custom domain, no social identity providers.

locals {
  # Managed Login host, as the server expects it (no scheme).
  cognito_domain = "${aws_cognito_user_pool_domain.rewind.domain}.auth.${var.region}.amazoncognito.com"
}

resource "aws_cognito_user_pool" "rewind" {
  name = "rewind-${var.environment}"

  username_attributes      = ["email"]
  auto_verified_attributes = ["email"]
  mfa_configuration        = "OFF"
  user_pool_tier           = "ESSENTIALS"
  deletion_protection      = "INACTIVE"

  admin_create_user_config {
    allow_admin_create_user_only = false
  }

  email_configuration {
    email_sending_account = "COGNITO_DEFAULT"
  }

  account_recovery_setting {
    recovery_mechanism {
      name     = "verified_email"
      priority = 1
    }
  }

  password_policy {
    minimum_length                   = 10
    require_lowercase                = false
    require_uppercase                = false
    require_numbers                  = false
    require_symbols                  = false
    temporary_password_validity_days = 7
  }
}

# Default Cognito prefix domain (no custom domain). Prefixes may not contain
# "aws", "amazon" or "cognito".
resource "aws_cognito_user_pool_domain" "rewind" {
  domain                = "rewind-${var.environment}-${data.aws_caller_identity.current.account_id}"
  user_pool_id          = aws_cognito_user_pool.rewind.id
  managed_login_version = 2
}

resource "aws_cognito_user_pool_client" "rewind" {
  name         = "rewind-${var.environment}-web"
  user_pool_id = aws_cognito_user_pool.rewind.id

  generate_secret = false

  allowed_oauth_flows                  = ["code"]
  allowed_oauth_flows_user_pool_client = true
  allowed_oauth_scopes                 = ["openid", "email", "profile"]
  supported_identity_providers         = ["COGNITO"]

  # The Rewind server handles /api/auth/callback; sign-out returns to the root.
  callback_urls = [for origin in var.web_origins : "${origin}/api/auth/callback"]
  logout_urls   = [for origin in var.web_origins : "${origin}/"]

  explicit_auth_flows = ["ALLOW_USER_SRP_AUTH", "ALLOW_REFRESH_TOKEN_AUTH"]

  # Tokens are only used at sign-in; Rewind issues its own session after.
  # Cognito's minimum refresh validity is 60 minutes; one day keeps it simple.
  access_token_validity  = 1
  id_token_validity      = 1
  refresh_token_validity = 1
  token_validity_units {
    access_token  = "days"
    id_token      = "days"
    refresh_token = "days"
  }

  prevent_user_existence_errors = "ENABLED"
}

# Managed Login (v2) branding in Warm Glass colours (src/ui/tokens.ts WARM):
# cream page, warm ink text, peach primary button with dark ink, orange links,
# rounded buttons. Colours are RRGGBBAA hex. Unlisted settings keep Cognito's
# defaults; read them with `aws cognito-idp describe-managed-login-branding
# --use-cognito-provided-values` to extend this.
locals {
  cognito_branding = {
    categories = {
      global = { colorSchemeMode = "LIGHT" }
    }
    componentClasses = {
      buttons = { borderRadius = 24.0 }
      input   = { borderRadius = 14.0 }
      link = {
        lightMode = {
          defaults = { textColor = "b8541fff" }
          hover    = { textColor = "e0703aff" }
        }
      }
      inputLabel = { lightMode = { textColor = "33231aff" } }
    }
    components = {
      pageBackground = { lightMode = { color = "f6ede3ff" } }
      form = {
        borderRadius = 24.0
        lightMode    = { backgroundColor = "fffaf4ff", borderColor = "ecdcc9ff" }
      }
      primaryButton = {
        lightMode = {
          defaults = { backgroundColor = "ff9f6bff", textColor = "2a1a10ff" }
          hover    = { backgroundColor = "ffb27eff", textColor = "2a1a10ff" }
          active   = { backgroundColor = "e0703aff", textColor = "2a1a10ff" }
        }
      }
    }
  }
}

resource "aws_cognito_managed_login_branding" "rewind" {
  user_pool_id = aws_cognito_user_pool.rewind.id
  client_id    = aws_cognito_user_pool_client.rewind.id
  settings     = jsonencode(local.cognito_branding)

  asset {
    category   = "FORM_LOGO"
    color_mode = "LIGHT"
    extension  = "PNG"
    bytes      = filebase64("${path.module}/../../../assets/icon.png")
  }

  depends_on = [aws_cognito_user_pool_domain.rewind]
}
