import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import test from 'node:test';

const demoDirectory = new URL('../../infra/terraform/demo/', import.meta.url);
const demoSources = await Promise.all(
  (await readdir(demoDirectory))
    .filter((name) => name.endsWith('.tf'))
    .map((name) => readFile(new URL(name, demoDirectory), 'utf8')),
);
const allTerraform = demoSources.join('\n');
const providerTerraform = await readFile(new URL('providers.tf', demoDirectory), 'utf8');
const lightsailTerraform = await readFile(
  new URL('../../infra/terraform/demo/lightsail.tf', import.meta.url),
  'utf8',
);
// Terraform fmt leaves resource closing braces at column zero. Scope the
// assertions to the instance, not a lifecycle on another resource.
const instanceTerraform = lightsailTerraform.match(
  /^resource "aws_lightsail_instance" "rewind" \{\n[\s\S]*?^\}/m,
)?.[0];
assert.ok(instanceTerraform, 'missing Demo instance resource');
const distributionTerraform = await readFile(
  new URL('../../infra/terraform/demo/web-distribution.tf', import.meta.url),
  'utf8',
);
const demoVariables = await readFile(
  new URL('../../infra/terraform/demo/variables.tf', import.meta.url),
  'utf8',
);

test('the deleted optional Lightsail distribution cannot be recreated by Terraform', () => {
  assert.doesNotMatch(allTerraform, /aws_lightsail_distribution/);
  assert.doesNotMatch(allTerraform, /public_https_distribution_enabled/);
  assert.doesNotMatch(allTerraform, /public_https_distribution_domain/);
  assert.doesNotMatch(allTerraform, /rewind-demo-web/);
  assert.doesNotMatch(providerTerraform, /lightsail_distribution/);
});

test('the real-auth distribution remains CloudFront with HTTPS viewers and the protected instance origin', () => {
  assert.match(distributionTerraform, /resource "aws_cloudfront_distribution" "real_auth_web"/);
  assert.match(distributionTerraform, /viewer_protocol_policy\s*=\s*"redirect-to-https"/);
  assert.match(distributionTerraform, /name\s*=\s*"X-Rewind-Origin-Auth"/);
  assert.match(distributionTerraform, /name\s*=\s*"X-Forwarded-Proto"/);
  assert.match(demoVariables, /variable "real_auth_https_distribution_enabled"/);
});

test('the default AWS provider remains regional and no distribution-only provider is configured', () => {
  const providers = [...providerTerraform.matchAll(/^provider "aws" \{\n[\s\S]*?^\}/gm)];
  assert.equal(providers.length, 1);
  assert.match(providers[0][0], /region\s*=\s*var\.aws_region/);
  assert.doesNotMatch(providers[0][0], /alias\s*=/);
});

test('existing hosts ignore only creation-time user_data drift', () => {
  const instanceWithoutComments = instanceTerraform.replace(/#[^\n]*/g, '');
  const lifecycles = [...instanceWithoutComments.matchAll(/\blifecycle\s*\{([^{}]*)\}/g)];
  assert.equal(lifecycles.length, 1, 'the instance must have one explicit lifecycle');
  assert.match(lifecycles[0][1], /^\s*ignore_changes\s*=\s*\[\s*user_data\s*\]\s*$/);
});

test('new hosts keep current bootstrap and the static IP attachment chain', () => {
  assert.match(instanceTerraform, /user_data\s*=\s*file\("\$\{path\.module\}\/cloud-init\.sh"\)/);
  assert.match(instanceTerraform, /count\s*=\s*var\.demo_instance_enabled\s*\?\s*1\s*:\s*0/);
  const attachment = lightsailTerraform.match(
    /^resource "aws_lightsail_static_ip_attachment" "rewind" \{\n[\s\S]*?^\}/m,
  )?.[0];
  assert.ok(attachment, 'missing Demo static IP attachment');
  assert.match(attachment, /instance_name\s*=\s*aws_lightsail_instance\.rewind\[0\]\.name/);
  assert.match(attachment, /static_ip_name\s*=\s*aws_lightsail_static_ip\.rewind\[0\]\.name/);
});
