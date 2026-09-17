data "archive_file" "cost_safety_audit" {
  type        = "zip"
  source_file = "${path.module}/lambda/cost_safety_audit.py"
  output_path = "${path.module}/.terraform/cost-safety-audit.zip"
}

resource "aws_cloudwatch_log_group" "cost_safety_audit" {
  name              = "/aws/lambda/rewind-demo-cost-safety-audit"
  retention_in_days = 7
}

resource "aws_iam_role" "cost_safety_audit" {
  name               = "rewind-demo-cost-safety-audit"
  assume_role_policy = data.aws_iam_policy_document.power_controller_assume_role.json
  description        = "Read-only periodic cost-safety checks for the Rewind Demo."

  tags = {
    Environment = "demo"
    AccessScope = "cost-safety-audit"
  }
}

data "aws_iam_policy_document" "cost_safety_audit" {
  statement {
    sid       = "WriteAuditLogs"
    effect    = "Allow"
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["${aws_cloudwatch_log_group.cost_safety_audit.arn}:*"]
  }

  # Lightsail has no resource-level authorization for these read-only actions.
  statement {
    sid    = "ReadOnlyDemoSurface"
    effect = "Allow"
    actions = [
      "lightsail:GetInstance",
      "lightsail:GetInstanceSnapshots",
      "lightsail:GetStaticIp",
    ]
    resources = ["*"]
  }

  # Distribution inventory is global and is read from us-east-1. Reading it
  # even for an empty allowlist makes an unexpected distribution actionable.
  statement {
    sid       = "ReadGlobalDistributionInventory"
    effect    = "Allow"
    actions   = ["lightsail:GetDistributions"]
    resources = ["*"]
  }

  statement {
    sid       = "ReadOnlyBackupRetention"
    effect    = "Allow"
    actions   = ["s3:GetLifecycleConfiguration"]
    resources = [aws_s3_bucket.backups.arn]
  }
}

resource "aws_iam_role_policy" "cost_safety_audit" {
  name   = "rewind-demo-cost-safety-audit"
  role   = aws_iam_role.cost_safety_audit.id
  policy = data.aws_iam_policy_document.cost_safety_audit.json
}

resource "aws_lambda_function" "cost_safety_audit" {
  function_name    = "rewind-demo-cost-safety-audit"
  description      = "Reports unexpected running or unsafe Rewind Demo resources; never mutates them."
  filename         = data.archive_file.cost_safety_audit.output_path
  source_code_hash = data.archive_file.cost_safety_audit.output_base64sha256
  handler          = "cost_safety_audit.handler"
  runtime          = "python3.12"
  architectures    = ["arm64"]
  memory_size      = 128
  timeout          = 15
  role             = aws_iam_role.cost_safety_audit.arn

  logging_config {
    log_format = "JSON"
    log_group  = aws_cloudwatch_log_group.cost_safety_audit.name
  }

  environment {
    variables = {
      INSTANCE_NAME           = aws_lightsail_instance.rewind.name
      STATIC_IP_NAME          = aws_lightsail_static_ip.rewind.name
      BACKUP_BUCKET           = aws_s3_bucket.backups.id
      EXPECTED_SNAPSHOT_NAMES = jsonencode(tolist(var.cost_safety_expected_snapshot_names))
      EXPECTED_DISTRIBUTIONS  = jsonencode(var.cost_safety_expected_distributions)
    }
  }

  depends_on = [aws_iam_role_policy.cost_safety_audit]
}

data "aws_iam_policy_document" "cost_safety_audit_scheduler_assume_role" {
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
      values   = ["arn:aws:scheduler:${var.aws_region}:${var.account_id}:schedule/${aws_scheduler_schedule_group.rewind.name}/rewind-demo-cost-safety-audit"]
    }
  }
}

resource "aws_iam_role" "cost_safety_audit_scheduler" {
  name               = "rewind-demo-cost-safety-audit-scheduler"
  assume_role_policy = data.aws_iam_policy_document.cost_safety_audit_scheduler_assume_role.json
  description        = "Invokes only the read-only Rewind Demo cost-safety audit."

  tags = {
    Environment = "demo"
    AccessScope = "cost-safety-audit-scheduler"
  }
}

resource "aws_iam_role_policy" "cost_safety_audit_scheduler" {
  name = "rewind-demo-cost-safety-audit-invoke"
  role = aws_iam_role.cost_safety_audit_scheduler.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = "lambda:InvokeFunction"
      Resource = aws_lambda_function.cost_safety_audit.arn
    }]
  })
}

resource "aws_scheduler_schedule" "cost_safety_audit" {
  name                         = "rewind-demo-cost-safety-audit"
  group_name                   = aws_scheduler_schedule_group.rewind.name
  description                  = "Runs the read-only Rewind Demo cost-safety audit every four hours."
  schedule_expression          = "rate(4 hours)"
  schedule_expression_timezone = var.automatic_start_schedule_timezone
  state                        = "ENABLED"

  flexible_time_window {
    mode = "OFF"
  }

  target {
    arn      = aws_lambda_function.cost_safety_audit.arn
    role_arn = aws_iam_role.cost_safety_audit_scheduler.arn
    input    = jsonencode({ action = "audit" })
  }
}

resource "aws_sns_topic" "cost_safety_audit" {
  name              = "rewind-demo-cost-safety-audit"
  display_name      = "Rewind Demo cost safety"
  kms_master_key_id = "alias/aws/sns"
}

resource "aws_sns_topic_subscription" "cost_safety_audit_email" {
  for_each = var.budget_email_recipients

  topic_arn = aws_sns_topic.cost_safety_audit.arn
  protocol  = "email"
  endpoint  = each.value
}

data "aws_iam_policy_document" "cost_safety_audit_notifications" {
  statement {
    sid    = "AllowAccountTopicAdministration"
    effect = "Allow"

    principals {
      type        = "AWS"
      identifiers = ["arn:aws:iam::${var.account_id}:root"]
    }

    actions   = ["SNS:*"]
    resources = [aws_sns_topic.cost_safety_audit.arn]
  }

  statement {
    sid    = "AllowCloudWatchAlarmPublish"
    effect = "Allow"

    principals {
      type        = "Service"
      identifiers = ["cloudwatch.amazonaws.com"]
    }

    actions   = ["sns:Publish"]
    resources = [aws_sns_topic.cost_safety_audit.arn]

    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [var.account_id]
    }

    condition {
      test     = "ArnLike"
      variable = "aws:SourceArn"
      values   = [aws_cloudwatch_metric_alarm.cost_safety_audit.arn]
    }
  }
}

resource "aws_sns_topic_policy" "cost_safety_audit" {
  arn    = aws_sns_topic.cost_safety_audit.arn
  policy = data.aws_iam_policy_document.cost_safety_audit_notifications.json
}

resource "aws_cloudwatch_metric_alarm" "cost_safety_audit" {
  alarm_name          = "rewind-demo-cost-safety-audit-failed"
  alarm_description   = "The read-only Rewind Demo cost-safety audit reported an unexpected resource state."
  comparison_operator = "GreaterThanOrEqualToThreshold"
  evaluation_periods  = 1
  metric_name         = "Errors"
  namespace           = "AWS/Lambda"
  period              = 14400
  statistic           = "Sum"
  threshold           = 1
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.cost_safety_audit.arn]

  dimensions = {
    FunctionName = aws_lambda_function.cost_safety_audit.function_name
  }
}

output "cost_safety_audit_function_name" {
  description = "Read-only Lambda that audits the expected stopped Demo state every four hours."
  value       = aws_lambda_function.cost_safety_audit.function_name
}
