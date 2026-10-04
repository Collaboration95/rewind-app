module "environment" {
  source = "../modules/runtime"

  providers = {
    aws                        = aws
    aws.lightsail_distribution = aws.lightsail_distribution
  }

  environment                = "dev"
  aws_region                 = var.aws_region
  account_id                 = var.account_id
  instance_enabled           = var.instance_enabled
  https_distribution_enabled = var.https_distribution_enabled
  ssh_cidr                   = var.ssh_cidr
  backup_retention_days      = var.backup_retention_days
}
