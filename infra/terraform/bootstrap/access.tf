data "aws_iam_policy_document" "coding_agent_trust" {
  statement {
    effect = "Allow"

    principals {
      type        = "AWS"
      identifiers = ["arn:aws:iam::${var.account_id}:user/${var.operator_username}"]
    }

    actions = ["sts:AssumeRole"]
  }
}

data "aws_iam_policy_document" "coding_agent" {
  statement {
    sid    = "ReadRewindOperationalStatus"
    effect = "Allow"
    actions = [
      "lightsail:Get*",
      "lightsail:List*",
      "cloudtrail:DescribeTrails",
      "cloudtrail:GetTrailStatus",
      "cloudtrail:LookupEvents",
      "budgets:Describe*",
      "budgets:ViewBudget",
      "ce:GetCostAndUsage",
      "ce:GetCostForecast",
      "ce:GetDimensionValues",
      "ce:GetTags",
      "s3:GetBucketLocation",
      "s3:GetBucketPolicyStatus",
      "s3:GetBucketPublicAccessBlock",
      "s3:GetBucketVersioning",
      "s3:GetEncryptionConfiguration",
      "s3:GetLifecycleConfiguration",
      "s3:ListBucket",
    ]
    resources = ["*"]
  }

  statement {
    sid       = "IdentifySession"
    effect    = "Allow"
    actions   = ["sts:GetCallerIdentity"]
    resources = ["*"]
  }

  # This is redundant with the allowlist above, but makes the intended safety
  # boundary visible even if an overly broad policy is attached accidentally.
  statement {
    sid    = "DenyMutatingAccountAndInfrastructureActions"
    effect = "Deny"
    actions = [
      "iam:*",
      "organizations:*",
      "account:*",
      "aws-portal:*",
      "cloudtrail:DeleteTrail",
      "cloudtrail:StopLogging",
      "cloudtrail:UpdateTrail",
      "lightsail:Create*",
      "lightsail:Delete*",
      "lightsail:RebootInstance",
      "lightsail:StartInstance",
      "lightsail:StopInstance",
      "lightsail:Update*",
      "s3:CreateBucket",
      "s3:Delete*",
      "s3:Put*",
    ]
    resources = ["*"]
  }
}

resource "aws_iam_role" "coding_agent" {
  name               = "rewind-coding-agent"
  assume_role_policy = data.aws_iam_policy_document.coding_agent_trust.json
  description        = "Read-only operational and cost inspection for Rewind coding agents."

  tags = {
    Environment = "bootstrap"
    AccessScope = "read-only"
  }
}

resource "aws_iam_role_policy" "coding_agent" {
  name   = "rewind-coding-agent-readonly"
  role   = aws_iam_role.coding_agent.id
  policy = data.aws_iam_policy_document.coding_agent.json
}

data "aws_iam_policy_document" "terraform_apply_trust" {
  statement {
    effect = "Allow"

    principals {
      type        = "AWS"
      identifiers = ["arn:aws:iam::${var.account_id}:user/${var.operator_username}"]
    }

    actions = ["sts:AssumeRole"]
  }
}

resource "aws_iam_role" "terraform_apply" {
  name                 = "rewind-terraform-apply"
  assume_role_policy   = data.aws_iam_policy_document.terraform_apply_trust.json
  description          = "Human-only Terraform plan/apply role for the Rewind AWS service allowlist."
  max_session_duration = 3600

  tags = {
    Environment = "bootstrap"
    AccessScope = "terraform-apply"
  }
}

data "aws_iam_policy_document" "terraform_apply" {
  # This purposefully excludes EC2, RDS, VPC/NAT, ECR, ECS, and Organizations.
  # Add a service family only through reviewed Terraform when the product needs it.
  statement {
    sid    = "ManageApprovedRewindServiceFamilies"
    effect = "Allow"
    actions = [
      "budgets:*",
      "cloudtrail:*",
      "cloudwatch:*",
      "cloudfront:CreateDistributionWithTags",
      "cloudfront:CreateDistribution",
      "cloudfront:GetCachePolicy",
      "cloudfront:GetDistribution",
      "cloudfront:GetDistributionConfig",
      "cloudfront:GetOriginRequestPolicy",
      "cloudfront:ListCachePolicies",
      "cloudfront:ListDistributions",
      "cloudfront:ListOriginRequestPolicies",
      "cloudfront:ListTagsForResource",
      "cloudfront:TagResource",
      "cloudfront:UntagResource",
      "iam:*",
      "lambda:*",
      "lightsail:*",
      "logs:*",
      "s3:*",
      "scheduler:*",
      "sts:AssumeRole",
      "tag:*",
    ]
    resources = ["*"]
  }
}

resource "aws_iam_role_policy" "terraform_apply" {
  name   = "rewind-terraform-apply-services"
  role   = aws_iam_role.terraform_apply.id
  policy = data.aws_iam_policy_document.terraform_apply.json
}

data "aws_iam_policy_document" "operator_role_assumption" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRole"]
    resources = [
      aws_iam_role.coding_agent.arn,
      aws_iam_role.terraform_apply.arn,
      "arn:aws:iam::${var.account_id}:role/rewind-demo-operator",
    ]
  }
}

resource "aws_iam_user_policy" "operator_role_assumption" {
  name   = "rewind-assume-approved-roles"
  user   = var.operator_username
  policy = data.aws_iam_policy_document.operator_role_assumption.json
}

output "coding_agent_role_arn" {
  description = "Configure this role as a named AWS CLI profile for coding agents."
  value       = aws_iam_role.coding_agent.arn
}

output "terraform_apply_role_arn" {
  description = "Human-only role for reviewed Terraform plans and applies."
  value       = aws_iam_role.terraform_apply.arn
}

# --- GitHub OIDC for deployment workflows (#230) ---
#
# One account-level GitHub Actions OIDC provider. Environment-scoped deploy
# roles are declared next to the resources they operate: the Demo host's
# deployment role lives in infra/terraform/demo, where it can reference the
# exact Lightsail instance ARN.

resource "aws_iam_openid_connect_provider" "github" {
  count          = var.github_oidc_provider_arn == null ? 1 : 0
  url            = "https://token.actions.githubusercontent.com"
  client_id_list = ["sts.amazonaws.com"]
}

data "aws_iam_openid_connect_provider" "github" {
  count = var.github_oidc_provider_arn == null ? 0 : 1
  arn   = var.github_oidc_provider_arn
}

output "github_oidc_provider_arn" {
  description = "GitHub Actions OIDC provider ARN referenced by environment-scoped deploy roles."
  value       = coalesce(var.github_oidc_provider_arn, try(aws_iam_openid_connect_provider.github[0].arn, null))
}

