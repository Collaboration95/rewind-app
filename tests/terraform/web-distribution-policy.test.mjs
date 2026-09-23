import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

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
const demoExample = await readFile(
  new URL('../../infra/terraform/demo/terraform.tfvars.example', import.meta.url),
  'utf8',
);
const terraformRunbook = await readFile(
  new URL('../../infra/terraform/README.md', import.meta.url),
  'utf8',
);

test('existing hosts ignore only creation-time user_data drift', () => {
  const instanceWithoutComments = instanceTerraform.replace(/#[^\n]*/g, '');
  const lifecycles = [...instanceWithoutComments.matchAll(/\blifecycle\s*\{([^{}]*)\}/g)];
  assert.equal(lifecycles.length, 1, 'the instance must have one explicit lifecycle');
  assert.match(lifecycles[0][1], /^\s*ignore_changes\s*=\s*\[\s*user_data\s*\]\s*$/);
});

test('new hosts keep current bootstrap and the HTTPS origin attachment chain', () => {
  assert.match(instanceTerraform, /user_data\s*=\s*file\("\$\{path\.module\}\/cloud-init\.sh"\)/);
  assert.match(instanceTerraform, /count\s*=\s*var\.demo_instance_enabled\s*\?\s*1\s*:\s*0/);
  const attachment = lightsailTerraform.match(
    /^resource "aws_lightsail_static_ip_attachment" "rewind" \{\n[\s\S]*?^\}/m,
  )?.[0];
  assert.ok(attachment, 'missing HTTPS origin static IP attachment');
  assert.match(attachment, /instance_name\s*=\s*aws_lightsail_instance\.rewind\[0\]\.name/);
  assert.match(attachment, /static_ip_name\s*=\s*aws_lightsail_static_ip\.rewind\[0\]\.name/);
  assert.match(
    distributionTerraform,
    /depends_on\s*=\s*\[aws_lightsail_static_ip_attachment\.rewind\]/,
  );
});

test('public HTTPS distribution is explicitly opt-in with a safe default', () => {
  assert.match(demoVariables, /variable "public_https_distribution_enabled"/);
  assert.match(
    demoVariables,
    /variable "public_https_distribution_enabled"[\s\S]*?default\s*=\s*false/,
  );
  assert.match(
    distributionTerraform,
    /count\s*=\s*var\.public_https_distribution_enabled\s*\?\s*1\s*:\s*0/,
  );
  assert.match(distributionTerraform, /bundle_id\s*=\s*"small_1_0"/);
  assert.match(distributionTerraform, /ip_address_type\s*=\s*"ipv4"/);
  assert.match(demoExample, /public_https_distribution_enabled\s*=\s*false/);
  assert.match(demoExample, /cost_safety_expected_distributions\s+=\s*\{\}/);
});

test('distribution uses the web origin and preserves same-origin API routing', () => {
  assert.match(
    distributionTerraform,
    /origin\s*\{[\s\S]*?name\s*=\s*local\.instance_name[\s\S]*?region_name\s*=\s*var\.aws_region[\s\S]*?protocol_policy\s*=\s*"http-only"[\s\S]*?\}/,
  );
  assert.match(distributionTerraform, /default_cache_behavior\s*\{[\s\S]*?behavior\s*=\s*"cache"/);
  assert.match(
    distributionTerraform,
    /path\s*=\s*"\/index\.html"[\s\S]*?behavior\s*=\s*"dont-cache"/,
  );
  assert.match(distributionTerraform, /path\s*=\s*"\/api"[\s\S]*?behavior\s*=\s*"dont-cache"/);
  assert.match(distributionTerraform, /path\s*=\s*"\/api\/\*"[\s\S]*?behavior\s*=\s*"dont-cache"/);
  assert.match(distributionTerraform, /forwarded_query_strings\s*\{[\s\S]*?option\s*=\s*true/);
  assert.match(distributionTerraform, /headers_allow_list\s*=\s*\["Accept", "Origin"\]/);
});

test('enabling the distribution requires an explicit cost-safety approval', () => {
  assert.match(
    distributionTerraform,
    /depends_on\s*=\s*\[aws_lightsail_static_ip_attachment\.rewind\]/,
  );
  assert.match(distributionTerraform, /condition\s*=\s*var\.demo_instance_enabled/);
  assert.match(
    distributionTerraform,
    /lookup\(var\.cost_safety_expected_distributions, local\.public_https_distribution_name, null\) == local\.instance_name/,
  );
  assert.match(terraformRunbook, /automatically redirect(?:s)?\s+HTTP requests to HTTPS/);
});
