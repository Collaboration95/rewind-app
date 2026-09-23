import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import test from 'node:test';

const demoDirectory = new URL('../../infra/terraform/demo/', import.meta.url);
const providerTerraform = await readFile(new URL('providers.tf', demoDirectory), 'utf8');
const demoSources = await Promise.all(
  (await readdir(demoDirectory))
    .filter((name) => name.endsWith('.tf'))
    .map((name) => readFile(new URL(name, demoDirectory), 'utf8')),
);

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

test('distribution provider uses us-east-1 while the default provider stays regional', () => {
  const providers = [...providerTerraform.matchAll(/^provider "aws" \{\n[\s\S]*?^\}/gm)].map(
    (match) => match[0],
  );
  assert.equal(providers.length, 2);
  const regional = providers.find((block) => !/\balias\s*=/.test(block));
  const distribution = providers.find((block) =>
    /alias\s*=\s*"lightsail_distribution"/.test(block),
  );
  assert.ok(regional, 'missing default regional provider');
  assert.ok(distribution, 'missing distribution provider alias');
  assert.match(regional, /region\s*=\s*var\.aws_region/);
  assert.match(distribution, /region\s*=\s*"us-east-1"/);
  for (const provider of providers) {
    assert.match(provider, /Project\s*=\s*"rewind"/);
    assert.match(provider, /Owner\s*=\s*"team"/);
    assert.match(provider, /ManagedBy\s*=\s*"terraform"/);
  }
});

test('only the Lightsail distribution selects an aliased AWS provider', () => {
  const routedResources = demoSources.flatMap((source) =>
    [...source.matchAll(/^(?:resource|data) "([^"]+)" "([^"]+)" \{\n[\s\S]*?^\}/gm)]
      .filter((match) => /^\s*provider\s*=/m.test(match[0]))
      .map((match) => ({
        address: `${match[1]}.${match[2]}`,
        provider: match[0].match(/^\s*provider\s*=\s*(\S+)/m)[1],
      })),
  );
  assert.deepEqual(routedResources, [
    { address: 'aws_lightsail_distribution.web', provider: 'aws.lightsail_distribution' },
  ]);
});

test('distribution origin remains rewind-demo in ap-southeast-1', () => {
  assert.match(lightsailTerraform, /instance_name\s*=\s*"rewind-demo"/);
  assert.match(demoVariables, /variable "aws_region" \{[^}]*default\s*=\s*"ap-southeast-1"/);
  assert.match(instanceTerraform, /availability_zone\s*=\s*"ap-southeast-1a"/);
  assert.match(
    distributionTerraform,
    /origin\s*\{\s*name\s*=\s*local\.instance_name\s+region_name\s*=\s*var\.aws_region\s+protocol_policy\s*=\s*"http-only"\s*\}/,
  );
});

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

test('distribution uses the canonical Lightsail full HTTP method enum', () => {
  const allowedMethods = distributionTerraform.match(/allowed_http_methods\s*=\s*"([^"]*)"/);
  assert.ok(allowedMethods, 'missing allowed_http_methods');
  assert.equal(allowedMethods[1], 'GET,HEAD,OPTIONS,PUT,PATCH,POST,DELETE');
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
