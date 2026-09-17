resource "aws_lightsail_instance" "rewind" {
  name              = "rewind-demo"
  availability_zone = "ap-southeast-1a"
  blueprint_id      = "ubuntu_24_04"
  bundle_id         = "micro_3_0"
  ip_address_type   = "ipv4"

  tags = {
    Environment = "demo"
  }

  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_lightsail_static_ip" "rewind" {
  name = "rewind-demo-ip"

  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_lightsail_static_ip_attachment" "rewind" {
  static_ip_name = aws_lightsail_static_ip.rewind.name
  instance_name  = aws_lightsail_instance.rewind.name
}

resource "aws_lightsail_instance_public_ports" "rewind" {
  instance_name = aws_lightsail_instance.rewind.name

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
