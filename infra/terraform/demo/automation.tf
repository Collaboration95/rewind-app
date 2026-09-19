data "archive_file" "power_controller" {
  type        = "zip"
  source_file = "${path.module}/lambda/power_controller.py"
  output_path = "${path.module}/.terraform/power-controller.zip"
}

moved {
  from = aws_iam_role.power_controller
  to   = aws_iam_role.power_controller[0]
}

moved {
  from = aws_iam_role_policy.power_controller
  to   = aws_iam_role_policy.power_controller[0]
}

moved {
  from = aws_lambda_function.power_controller
  to   = aws_lambda_function.power_controller[0]
}

moved {
  from = aws_iam_role_policy.operator
  to   = aws_iam_role_policy.operator[0]
}

moved {
  from = aws_iam_role_policy.scheduler
  to   = aws_iam_role_policy.scheduler[0]
}

resource "aws_cloudwatch_log_group" "power_controller" {
  name              = "/aws/lambda/rewind-demo-power-controller"
  retention_in_days = 7
}

data "aws_iam_policy_document" "power_controller_assume_role" {
  statement {
    effect = "Allow"

    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }

    actions = ["sts:AssumeRole"]
  }
}

resource "aws_iam_role" "power_controller" {
  count              = var.demo_instance_enabled ? 1 : 0
  name               = "rewind-demo-power-controller"
  assume_role_policy = data.aws_iam_policy_document.power_controller_assume_role.json
  description        = "Legacy power control for an existing Rewind demo instance; hibernation uses reviewed Terraform instead."

  tags = {
    Environment = "demo"
    AccessScope = "power-controller"
  }
}

data "aws_iam_policy_document" "power_controller" {
  statement {
    sid       = "WriteControllerLogs"
    effect    = "Allow"
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["${aws_cloudwatch_log_group.power_controller.arn}:*"]
  }

  statement {
    sid       = "ControlOnlyTheRewindDemo"
    effect    = "Allow"
    actions   = ["lightsail:StartInstance", "lightsail:StopInstance"]
    resources = var.demo_instance_enabled ? [aws_lightsail_instance.rewind[0].arn] : ["arn:aws:lightsail:${var.aws_region}:${var.account_id}:Instance/${local.instance_name}"]
  }

  # Lightsail does not support resource-level authorization for this read-only
  # action. Write actions remain constrained to the single instance above.
  statement {
    sid       = "ReadInstanceState"
    effect    = "Allow"
    actions   = ["lightsail:GetInstanceState"]
    resources = ["*"]
  }

  statement {
    sid       = "VerifyOnlyBackupManifests"
    effect    = "Allow"
    actions   = ["s3:GetObject"]
    resources = ["${aws_s3_bucket.backups.arn}/rewind-demo/*.manifest.json"]
  }
}

resource "aws_iam_role_policy" "power_controller" {
  count  = var.demo_instance_enabled ? 1 : 0
  name   = "rewind-demo-power-controller"
  role   = aws_iam_role.power_controller[0].id
  policy = data.aws_iam_policy_document.power_controller.json
}

resource "aws_lambda_function" "power_controller" {
  count            = var.demo_instance_enabled ? 1 : 0
  function_name    = "rewind-demo-power-controller"
  description      = "Starts or stops an existing Rewind demo instance after the legacy backup gate."
  filename         = data.archive_file.power_controller.output_path
  source_code_hash = data.archive_file.power_controller.output_base64sha256
  handler          = "power_controller.handler"
  runtime          = "python3.12"
  architectures    = ["arm64"]
  memory_size      = 128
  timeout          = 15
  role             = aws_iam_role.power_controller[0].arn

  logging_config {
    log_format = "JSON"
    log_group  = aws_cloudwatch_log_group.power_controller.name
  }

  environment {
    variables = {
      INSTANCE_NAME          = local.instance_name
      BACKUP_BUCKET          = aws_s3_bucket.backups.id
      BACKUP_PREFIX          = "rewind-demo"
      MAX_BACKUP_AGE_MINUTES = "60"
    }
  }

  depends_on = [aws_iam_role_policy.power_controller]
}

data "aws_iam_policy_document" "operator_assume_role" {
  statement {
    effect = "Allow"

    principals {
      type        = "AWS"
      identifiers = ["arn:aws:iam::${var.account_id}:user/${var.operator_username}"]
    }

    actions = ["sts:AssumeRole"]
  }
}

resource "aws_iam_role" "operator" {
  name               = "rewind-demo-operator"
  assume_role_policy = data.aws_iam_policy_document.operator_assume_role.json
  description        = "May invoke the Rewind power controller, but cannot operate AWS directly."

  tags = {
    Environment = "demo"
    AccessScope = "power-operator"
  }
}

data "aws_iam_policy_document" "operator" {
  statement {
    effect    = "Allow"
    actions   = ["lambda:InvokeFunction"]
    resources = var.demo_instance_enabled ? [aws_lambda_function.power_controller[0].arn] : ["arn:aws:lambda:${var.aws_region}:${var.account_id}:function:rewind-demo-power-controller"]
  }
}

resource "aws_iam_role_policy" "operator" {
  count  = var.demo_instance_enabled ? 1 : 0
  name   = "rewind-demo-operator-invoke"
  role   = aws_iam_role.operator.id
  policy = data.aws_iam_policy_document.operator.json
}

data "aws_iam_policy_document" "scheduler_assume_role" {
  statement {
    effect = "Allow"

    principals {
      type        = "Service"
      identifiers = ["scheduler.amazonaws.com"]
    }

    actions = ["sts:AssumeRole"]

    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [var.account_id]
    }

    condition {
      test     = "ArnLike"
      variable = "aws:SourceArn"
      values   = ["arn:aws:scheduler:${var.aws_region}:${var.account_id}:schedule/rewind-demo/*"]
    }
  }
}

resource "aws_iam_role" "scheduler" {
  name               = "rewind-demo-scheduler"
  assume_role_policy = data.aws_iam_policy_document.scheduler_assume_role.json
  description        = "Invokes the Rewind power controller for approved schedules."

  tags = {
    Environment = "demo"
    AccessScope = "scheduler"
  }
}

resource "aws_iam_role_policy" "scheduler" {
  count = var.demo_instance_enabled ? 1 : 0
  name  = "rewind-demo-scheduler-invoke"
  role  = aws_iam_role.scheduler.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = "lambda:InvokeFunction"
      Resource = try(aws_lambda_function.power_controller[0].arn, null)
    }]
  })
}

resource "aws_scheduler_schedule_group" "rewind" {
  name = "rewind-demo"
}

resource "aws_scheduler_schedule" "automatic_start" {
  count = var.demo_instance_enabled && var.automatic_start_schedule_expression != null ? 1 : 0

  name                         = "rewind-demo-automatic-start"
  group_name                   = aws_scheduler_schedule_group.rewind.name
  description                  = "Starts the Rewind demo at the explicitly configured schedule."
  schedule_expression          = var.automatic_start_schedule_expression
  schedule_expression_timezone = var.automatic_start_schedule_timezone
  state                        = "ENABLED"

  flexible_time_window {
    mode = "OFF"
  }

  target {
    arn      = aws_lambda_function.power_controller[0].arn
    role_arn = aws_iam_role.scheduler.arn
    input    = jsonencode({ action = "start" })
  }
}

output "power_controller_function_name" {
  description = "Invoke this Lambda with action=start or action=stop plus a backup manifest key."
  value       = try(aws_lambda_function.power_controller[0].function_name, null)
}

output "operator_role_arn" {
  description = "Role for humans/tools that may invoke, but not administer, the power controller."
  value       = aws_iam_role.operator.arn
}
