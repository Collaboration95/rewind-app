mock_provider "aws" {
  mock_data "aws_caller_identity" {
    defaults = {
      account_id = "330599756236"
    }
  }
}

variables {
  environment = "dev"
  kms_key_arn = "arn:aws:kms:ap-southeast-1:330599756236:key/reviewed-key"
}

run "dev_roles" {
  command = plan
  assert {
    condition = (
      aws_iam_role.environment["plan"].name == "rewind-dev-terraform-plan" &&
      aws_iam_role.environment["apply"].name == "rewind-dev-terraform-apply"
    )
    error_message = "Plan and apply must remain distinct environment roles."
  }
  assert {
    condition = (
      jsondecode(aws_iam_role.environment["apply"].assume_role_policy).Statement[0].Condition.StringEquals["token.actions.githubusercontent.com:ref"] == "refs/heads/dev" &&
      jsondecode(aws_iam_role.environment["apply"].assume_role_policy).Statement[0].Condition.StringEquals["token.actions.githubusercontent.com:sub"] == "repo:Collaboration95@68595032/rewind-app@1354608509:environment:terraform-dev-apply"
    )
    error_message = "Trust must retain the immutable subject, exact ref and apply environment."
  }
  assert {
    condition = (
      aws_iam_role_policy.environment["plan"].policy == aws_iam_policy.boundary["plan"].policy &&
      aws_iam_role_policy.environment["apply"].policy == aws_iam_policy.boundary["apply"].policy
    )
    error_message = "Role permissions and upper boundaries must remain identical."
  }
}

run "prod_roles" {
  command = plan
  variables {
    environment = "prod"
  }
  assert {
    condition = (
      aws_iam_role.environment["plan"].name == "rewind-prod-terraform-plan" &&
      jsondecode(aws_iam_role.environment["plan"].assume_role_policy).Statement[0].Condition.StringEquals["token.actions.githubusercontent.com:ref"] == "refs/heads/main" &&
      jsondecode(aws_iam_role.environment["plan"].assume_role_policy).Statement[0].Condition.StringEquals["token.actions.githubusercontent.com:environment"] == "terraform-prod-plan"
    )
    error_message = "Production trust must be exact main and the separate prod plan gate."
  }
}

run "reject_wrong_account" {
  command = plan
  override_data {
    target = data.aws_caller_identity.current
    values = { account_id = "999999999999" }
  }
  expect_failures = [aws_iam_policy.boundary]
}

run "reject_cross_account_key" {
  command = plan
  variables {
    kms_key_arn = "arn:aws:kms:ap-southeast-1:999999999999:key/wrong-account"
  }
  expect_failures = [var.kms_key_arn]
}

run "reject_other_environment" {
  command = plan
  variables {
    environment = "demo"
  }
  expect_failures = [var.environment]
}
