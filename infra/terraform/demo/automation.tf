data "archive_file" "power_controller" {
  type        = "zip"
  source_file = "${path.module}/lambda/power_controller.py"
  output_path = "${path.module}/.terraform/power-controller.zip"
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
  name               = "rewind-demo-power-controller"
  assume_role_policy = data.aws_iam_policy_document.power_controller_assume_role.json
  description        = "Runs only Rewind demo start and backup-verified stop operations."

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
    resources = [aws_lightsail_instance.rewind.arn]
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
  name   = "rewind-demo-power-controller"
  role   = aws_iam_role.power_controller.id
  policy = data.aws_iam_policy_document.power_controller.json
}

resource "aws_lambda_function" "power_controller" {
  function_name    = "rewind-demo-power-controller"
  description      = "Starts Rewind or stops it only after validating a backup manifest."
  filename         = data.archive_file.power_controller.output_path
  source_code_hash = data.archive_file.power_controller.output_base64sha256
  handler          = "power_controller.handler"
  runtime          = "python3.12"
  architectures    = ["arm64"]
  memory_size      = 128
  timeout          = 15
  role             = aws_iam_role.power_controller.arn

  logging_config {
    log_format = "JSON"
    log_group  = aws_cloudwatch_log_group.power_controller.name
  }

  environment {
    variables = {
      INSTANCE_NAME          = aws_lightsail_instance.rewind.name
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
    resources = [aws_lambda_function.power_controller.arn]
  }
}

resource "aws_iam_role_policy" "operator" {
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
  name = "rewind-demo-scheduler-invoke"
  role = aws_iam_role.scheduler.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Action = "lambda:InvokeFunction"
      Resource = [
        aws_lambda_function.power_controller.arn,
        aws_lambda_function.cost_safety_audit.arn,
      ]
    }]
  })
}

resource "aws_scheduler_schedule_group" "rewind" {
  name = "rewind-demo"
}

resource "aws_scheduler_schedule" "automatic_start" {
  count = var.automatic_start_schedule_expression == null ? 0 : 1

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
    arn      = aws_lambda_function.power_controller.arn
    role_arn = aws_iam_role.scheduler.arn
    input    = jsonencode({ action = "start" })
  }
}

output "power_controller_function_name" {
  description = "Invoke this Lambda with action=start or action=stop plus a backup manifest key."
  value       = aws_lambda_function.power_controller.function_name
}

output "operator_role_arn" {
  description = "Role for humans/tools that may invoke, but not administer, the power controller."
  value       = aws_iam_role.operator.arn
}
