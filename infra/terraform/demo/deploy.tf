# --- GitHub Actions deployment identity for the hosted Demo host (#230) ---
#
# The dev branch deploys to this host from GitHub Actions instead of from an
# operator machine. The role is declared here, next to the instance, so its
# policy always carries the current Lightsail instance ARN even after the
# documented hibernation and wake cycle replaces the host and its ARN id.
#
# The account-level GitHub OIDC provider is created by the bootstrap root;
# apply that root first.

data "aws_iam_openid_connect_provider" "github" {
  url = "https://token.actions.githubusercontent.com"
}

locals {
  # One branch, one GitHub environment, one host.
  deploy_environment = "dev"
  deploy_branch      = "dev"

  # GitHub issues immutable OIDC subject claims for this repository, so the
  # sub claim arrives as repo:OWNER@OWNER_ID/REPO@REPO_ID:environment:ENV
  # instead of the classic repo:OWNER/REPO:environment:ENV. Trust both exact
  # subjects so the environment-scoped role matches both forms, without
  # widening the trust relationship to a wildcard.
  deploy_subjects = [
    "repo:${var.github_repository}:environment:${local.deploy_environment}",
    "repo:${var.github_repository_immutable}:environment:${local.deploy_environment}",
  ]

  deploy_instance_arn = try(
    aws_lightsail_instance.rewind[0].arn,
    "arn:aws:lightsail:${var.aws_region}:${var.account_id}:Instance/${local.instance_name}",
  )
}

data "aws_iam_policy_document" "deploy_trust" {
  statement {
    sid     = "GitHubActionsDevEnvironmentOnDevBranch"
    effect  = "Allow"
    actions = ["sts:AssumeRoleWithWebIdentity"]

    principals {
      type        = "Federated"
      identifiers = [data.aws_iam_openid_connect_provider.github.arn]
    }

    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:aud"
      values   = ["sts.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:sub"
      values   = local.deploy_subjects
    }

    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:ref"
      values   = ["refs/heads/${local.deploy_branch}"]
    }
  }
}

resource "aws_iam_role" "deploy" {
  name                 = "rewind-demo-deploy"
  assume_role_policy   = data.aws_iam_policy_document.deploy_trust.json
  max_session_duration = 3600
  description          = "Deploys the dev branch to the hosted Demo host; assumes only from the dev environment on the dev branch."

  tags = {
    Environment = "demo"
    AccessScope = "deploy"
  }
}

data "aws_iam_policy_document" "deploy" {
  statement {
    sid    = "OperateOnlyTheDemoHost"
    effect = "Allow"
    actions = [
      "lightsail:GetInstanceAccessDetails",
      "lightsail:OpenInstancePublicPorts",
      "lightsail:CloseInstancePublicPorts",
    ]
    resources = [local.deploy_instance_arn]
  }

  # Lightsail declares no resource type for this read action, so it requires a
  # wildcard resource. The mutating actions above stay on the one host, and
  # this role cannot start, stop, delete, or resize anything.
  statement {
    sid       = "ReadTheDemoHostAddress"
    effect    = "Allow"
    actions   = ["lightsail:GetInstance"]
    resources = ["*"]
  }

  statement {
    sid       = "IdentifySession"
    effect    = "Allow"
    actions   = ["sts:GetCallerIdentity"]
    resources = ["*"]
  }
}

resource "aws_iam_role_policy" "deploy" {
  name   = "rewind-demo-deploy-lightsail"
  role   = aws_iam_role.deploy.id
  policy = data.aws_iam_policy_document.deploy.json
}

output "deploy_role_arn" {
  description = "Set this as the AWS_DEMO_DEPLOY_ROLE_ARN repository variable for the Deploy dev workflow."
  value       = aws_iam_role.deploy.arn
}

