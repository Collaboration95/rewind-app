import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const demoTerraform = await readFile(
  new URL('../../infra/terraform/demo/lightsail.tf', import.meta.url),
  'utf8',
);
const demoBackend = await readFile(
  new URL('../../infra/terraform/demo/backend.hcl.example', import.meta.url),
  'utf8',
);

test('pins Demo Lightsail names/addresses and the example backend key', () => {
  assert.match(demoTerraform, /instance_name\s*=\s*"rewind-demo"/);
  assert.match(demoTerraform, /static_ip_name\s*=\s*"rewind-demo-ip"/);
  assert.match(demoTerraform, /resource "aws_lightsail_instance" "rewind"/);
  assert.match(demoTerraform, /resource "aws_lightsail_static_ip" "rewind"/);
  assert.match(demoTerraform, /resource "aws_lightsail_static_ip_attachment" "rewind"/);
  assert.match(demoTerraform, /resource "aws_lightsail_instance_public_ports" "rewind"/);
  assert.match(demoBackend, /key\s*=\s*"rewind\/demo\/terraform\.tfstate"/);
});
