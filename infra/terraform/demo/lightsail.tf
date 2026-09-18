locals {
  instance_name  = "rewind-demo"
  static_ip_name = "rewind-demo-ip"
}

# Preserve the adopted resource addresses when the optional compute resources
# are converted to counted resources. Without these moves, the first lifecycle
# apply could mistake an existing instance for an unrelated replacement.
moved {
  from = aws_lightsail_instance.rewind
  to   = aws_lightsail_instance.rewind[0]
}

moved {
  from = aws_lightsail_static_ip.rewind
  to   = aws_lightsail_static_ip.rewind[0]
}

moved {
  from = aws_lightsail_static_ip_attachment.rewind
  to   = aws_lightsail_static_ip_attachment.rewind[0]
}

moved {
  from = aws_lightsail_instance_public_ports.rewind
  to   = aws_lightsail_instance_public_ports.rewind[0]
}

resource "aws_lightsail_instance" "rewind" {
  count             = var.demo_instance_enabled ? 1 : 0
  name              = local.instance_name
  availability_zone = "ap-southeast-1a"
  blueprint_id      = "ubuntu_24_04"
  bundle_id         = "micro_3_0"
  ip_address_type   = "ipv4"
  user_data         = file("${path.module}/cloud-init.sh")

  tags = {
    Environment = "demo"
  }

}

resource "aws_lightsail_static_ip" "rewind" {
  count = var.demo_instance_enabled || var.retain_static_ip_when_instance_deleted ? 1 : 0
  name  = local.static_ip_name
}

resource "aws_lightsail_static_ip_attachment" "rewind" {
  count          = var.demo_instance_enabled ? 1 : 0
  static_ip_name = aws_lightsail_static_ip.rewind[0].name
  instance_name  = aws_lightsail_instance.rewind[0].name
}

resource "aws_lightsail_instance_public_ports" "rewind" {
  count         = var.demo_instance_enabled ? 1 : 0
  instance_name = aws_lightsail_instance.rewind[0].name

  port_info {
    protocol  = "tcp"
    from_port = 80
    to_port   = 80
    cidrs     = ["0.0.0.0/0"]
  }

  port_info {
    protocol          = "tcp"
    from_port         = 22
    to_port           = 22
    cidrs             = [var.ssh_cidr]
    cidr_list_aliases = ["lightsail-connect"]
  }
}

output "demo_instance_name" {
  description = "Stable logical name used when the disposable Demo instance is recreated."
  value       = local.instance_name
}

output "demo_static_ip" {
  description = "Current Demo static IP, or null while the static IP is not retained."
  value       = try(aws_lightsail_static_ip.rewind[0].ip_address, null)
}

output "demo_instance_enabled" {
  description = "Whether Terraform currently expects the disposable Demo instance to exist."
  value       = var.demo_instance_enabled
}
