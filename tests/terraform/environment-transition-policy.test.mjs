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
const terraformRunbook = await readFile(
  new URL('../../infra/terraform/README.md', import.meta.url),
  'utf8',
);

test('keeps the existing Demo names, resource addresses, and state key pinned', () => {
  assert.match(demoTerraform, /instance_name\s*=\s*"rewind-demo"/);
  assert.match(demoTerraform, /static_ip_name\s*=\s*"rewind-demo-ip"/);
  assert.match(demoTerraform, /resource "aws_lightsail_instance" "rewind"/);
  assert.match(demoTerraform, /resource "aws_lightsail_static_ip" "rewind"/);
  assert.match(demoTerraform, /resource "aws_lightsail_static_ip_attachment" "rewind"/);
  assert.match(demoTerraform, /resource "aws_lightsail_instance_public_ports" "rewind"/);
  assert.match(demoBackend, /key\s*=\s*"rewind\/demo\/terraform\.tfstate"/);
});

test('records remote inventory and human review as pre-provision gates', () => {
  const boundary = terraformRunbook.split('## Sprint 2 dev/prod transition boundary (#230)')[1];

  assert.ok(boundary, 'the #230 transition boundary is documented');
  assert.match(boundary, /remote state or enumerate the S3 buckets/);
  assert.match(boundary, /checked against the remote state bucket/);
  assert.match(
    boundary,
    /No environment resources, state migration, IAM grants, or deployment workflows/,
  );
  assert.match(boundary, /exact GitHub OIDC repository\/branch\/environment claims/);
  assert.match(boundary, /Verify a supported distribution-to-origin trust control/);
  assert.match(boundary, /dated, complete estimate including Demo overlap/);
  assert.match(boundary, /Review the exact Terraform plan before any human-run apply/);
  assert.match(
    boundary,
    /cannot prove remote-state separation,\s*bucket isolation, HTTPS behavior,\s*or cost acceptance/,
  );
  assert.match(
    boundary,
    /#167 Organizations\/SCP work and #261\s+database migration are outside this slice/,
  );
});
