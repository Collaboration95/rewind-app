# Managed PostgreSQL for the hosted server (#261, #172).
#
# Lightsail managed PostgreSQL: storage encrypted at rest, automatic daily
# snapshots with point-in-time restore (7 days), private to Lightsail
# resources in this region, TLS on every connection. The high-availability
# bundles add a standby in a second availability zone with automatic
# failover behind the same endpoint.
#
# Each environment's database is changed here, in review:
#   enabled  creates the database and delivers its logins to the host
#   cutover  points the runtime at it (REWIND_DATABASE_URL); false keeps the
#            SQLite file live and is also the rollback switch
#   bundle   micro_2_0 (single AZ) or micro_ha_2_0 (standby + failover)
locals {
  database_settings = {
    dev     = { enabled = true, cutover = false, bundle = "micro_2_0" }
    release = { enabled = false, cutover = false, bundle = "micro_2_0" }
  }
  database = merge(
    { enabled = false, cutover = false, bundle = "micro_2_0" },
    lookup(local.database_settings, var.environment, {}),
  )
  database_count = local.database.enabled ? 1 : 0
  database_name  = "rewind-${var.environment}-postgres"
}

# URL-safe passwords: no quoting is needed in rewind.env or a connection URL.
resource "random_password" "database_admin" {
  count   = local.database_count
  length  = 40
  special = false
}

resource "random_password" "database_app" {
  count   = local.database_count
  length  = 40
  special = false
}

resource "random_password" "database_readonly" {
  count   = local.database_count
  length  = 40
  special = false
}

resource "aws_lightsail_database" "main" {
  count                    = local.database_count
  relational_database_name = local.database_name
  availability_zone        = var.database_availability_zone
  blueprint_id             = "postgres_17"
  bundle_id                = local.database.bundle
  master_database_name     = "rewind"
  master_username          = "rewind_admin"
  master_password          = random_password.database_admin[0].result

  publicly_accessible          = false
  backup_retention_enabled     = true
  preferred_backup_window      = "18:00-18:30" # 02:00-02:30 Singapore
  preferred_maintenance_window = "sun:19:00-sun:19:30"
  apply_immediately            = true

  # A deliberate destroy still leaves a final snapshot to restore from.
  skip_final_snapshot = false
  final_snapshot_name = "${local.database_name}-final"

  tags = {
    Name = local.database_name
  }

  lifecycle {
    prevent_destroy = true
  }
}

locals {
  database_endpoint = local.database.enabled ? (
    "${aws_lightsail_database.main[0].master_endpoint_address}:${aws_lightsail_database.main[0].master_endpoint_port}"
  ) : null
  database_app_url = local.database.enabled ? (
    "postgres://rewind_app:${random_password.database_app[0].result}@${local.database_endpoint}/rewind"
  ) : null
  database_readonly_url = local.database.enabled ? (
    "postgres://rewind_readonly:${random_password.database_readonly[0].result}@${local.database_endpoint}/rewind"
  ) : null
  # Delivered with the other hosted settings (main.tf). An empty
  # REWIND_DATABASE_URL clears an earlier cutover on the host.
  database_hosted_settings = local.database.enabled ? [
    "REWIND_DATABASE_ENVIRONMENT=${var.environment}",
    "REWIND_DATABASE_APP_URL=${local.database_app_url}",
    "REWIND_DATABASE_READONLY_URL=${local.database_readonly_url}",
    "REWIND_DATABASE_URL=${local.database.cutover ? local.database_app_url : ""}",
  ] : []
}

# The one-time role bootstrap reads the admin login from a private settings
# object, streamed to the host by the Database operations workflow
# (.github/workflows/database-operations.yml); nobody copies it by hand.
resource "aws_s3_object" "database_bootstrap" {
  count                  = local.database_count
  bucket                 = aws_s3_bucket.media.id
  key                    = "_config/${var.environment}-database-bootstrap.env"
  content_type           = "text/plain"
  server_side_encryption = "AES256"
  content = sensitive(join("\n", [
    "REWIND_DATABASE_ADMIN_URL=postgres://rewind_admin:${random_password.database_admin[0].result}@${local.database_endpoint}/rewind",
    "REWIND_DATABASE_APP_PASSWORD=${random_password.database_app[0].result}",
    "REWIND_DATABASE_READONLY_PASSWORD=${random_password.database_readonly[0].result}",
    "",
  ]))
}

# The Database operations workflow runs as the deploy role. It may read the
# bootstrap settings, inspect the database and its backups, and create or
# delete point-in-time restore rehearsals, which must carry the rehearsal tag.
data "aws_iam_policy_document" "deploy_database_operations" {
  count = local.database_count

  statement {
    sid       = "ReadBootstrapSettings"
    actions   = ["s3:GetObject"]
    resources = ["${aws_s3_bucket.media.arn}/${aws_s3_object.database_bootstrap[0].key}"]
  }

  statement {
    sid = "InspectDatabases"
    actions = [
      "lightsail:GetRelationalDatabase",
      "lightsail:GetRelationalDatabases",
      "lightsail:GetRelationalDatabaseSnapshots",
      "lightsail:GetRelationalDatabaseEvents",
    ]
    resources = ["*"]
  }

  statement {
    sid       = "CreateRestoreRehearsal"
    actions   = ["lightsail:CreateRelationalDatabaseFromSnapshot", "lightsail:TagResource"]
    resources = ["*"]
    condition {
      test     = "StringEquals"
      variable = "aws:RequestTag/rewind-purpose"
      values   = ["restore-rehearsal-${var.environment}"]
    }
  }

  statement {
    sid       = "DeleteRestoreRehearsal"
    actions   = ["lightsail:DeleteRelationalDatabase"]
    resources = ["*"]
    condition {
      test     = "StringEquals"
      variable = "aws:ResourceTag/rewind-purpose"
      values   = ["restore-rehearsal-${var.environment}"]
    }
  }
}

resource "aws_iam_role_policy" "deploy_database_operations" {
  count  = local.database_count
  name   = "${local.name}-database-operations"
  role   = var.deploy_role_name
  policy = data.aws_iam_policy_document.deploy_database_operations[0].json
}
