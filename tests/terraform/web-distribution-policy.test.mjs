import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

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
