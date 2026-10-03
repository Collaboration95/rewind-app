import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const moduleUrl = new URL('../../infra/terraform/modules/private-media/', import.meta.url);
const text = (name) => readFileSync(new URL(name, moduleUrl), 'utf8');
function policy(name, environment) {
  const values = {
    bucket_arn: `arn:aws:s3:::rewind-${environment}-media-330599756236`,
    environment,
    account_id: '330599756236',
  };
  return JSON.parse(
    text(name).replace(/\$\{([a-z_]+)\}/g, (_, key) => {
      assert.ok(key in values, `Unknown policy input: ${key}`);
      return values[key];
    }),
  );
}
const array = (value) => (Array.isArray(value) ? value : [value]);
const match = (pattern, value) =>
  new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`).test(value);
function applicable(statement, action, resource, context) {
  if (
    !array(statement.Action).some((pattern) => match(pattern, action)) ||
    !array(statement.Resource).some((pattern) => match(pattern, resource))
  )
    return false;
  return Object.entries(statement.Condition ?? {}).every(([operator, conditions]) =>
    Object.entries(conditions).every(([key, value]) => {
      if (operator === 'StringEquals' || operator === 'Bool') return String(context[key]) === value;
      if (operator === 'StringNotEquals') return String(context[key]) !== value;
      if (operator === 'StringLike') return key in context && match(value, context[key]);
      throw new Error(`Unsupported policy condition ${operator}`);
    }),
  );
}

for (const environment of ['dev', 'prod']) {
  test(`${environment} runtime denies other environment, bucket, account and state access`, () => {
    const statements = policy('runtime-policy.json.tftpl', environment).Statement;
    const bucket = `arn:aws:s3:::rewind-${environment}-media-330599756236`;
    const allow = (
      action,
      resource,
      account = '330599756236',
      prefix = `${environment}/group/incoming/clip`,
    ) =>
      statements.some(
        (statement) =>
          statement.Effect === 'Allow' &&
          applicable(statement, action, resource, {
            'aws:ResourceAccount': account,
            's3:prefix': prefix,
          }),
      );
    for (const kind of ['incoming', 'processed', 'films']) {
      const object = `${bucket}/${environment}/group/${kind}/clip`;
      for (const action of [
        's3:PutObject',
        's3:PutObjectTagging',
        's3:GetObjectVersion',
        's3:DeleteObjectVersion',
      ])
        assert.equal(allow(action, object), true, action);
      assert.equal(allow('s3:GetObjectVersion', object, '999999999999'), false);
    }
    const other = environment === 'dev' ? 'prod' : 'dev';
    assert.equal(allow('s3:GetObject', `${bucket}/${other}/group/films/film`), false);
    assert.equal(
      allow(
        's3:GetObject',
        `arn:aws:s3:::rewind-${other}-media-330599756236/${other}/group/films/film`,
      ),
      false,
    );
    assert.equal(
      allow(
        's3:GetObject',
        'arn:aws:s3:::rewind-terraform-state-330599756236/rewind/prod/media.tfstate',
      ),
      false,
    );
    assert.equal(allow('s3:ListBucket', bucket), true);
    assert.equal(allow('s3:ListBucketVersions', bucket), true);
    assert.equal(allow('s3:ListBucket', bucket, '330599756236', `${other}/`), false);
    assert.equal(allow('s3:ListBucket', bucket, '330599756236', ''), false);
    for (const action of [
      's3:PutBucketPolicy',
      's3:DeleteBucket',
      's3:DeleteObject',
      'iam:PassRole',
      'organizations:CreateAccount',
      'billing:GetBillingData',
    ])
      assert.equal(allow(action, bucket), false);
    assert.ok(
      statements.every(
        (statement) => !array(statement.Action).some((action) => action.includes('*')),
      ),
    );
  });

  test(`${environment} bucket rejects public transport, foreign account, absent encryption and relabelled originals`, () => {
    const statements = policy('bucket-policy.json.tftpl', environment).Statement;
    const bucket = `arn:aws:s3:::rewind-${environment}-media-330599756236`;
    const context = {
      'aws:SecureTransport': 'true',
      'aws:PrincipalAccount': '330599756236',
      's3:x-amz-server-side-encryption': 'AES256',
      's3:RequestObjectTag/rewind-media-class': 'incoming',
    };
    const denied = (action, resource, overrides = {}) =>
      statements.some(
        (statement) =>
          statement.Effect === 'Deny' &&
          applicable(statement, action, resource, { ...context, ...overrides }),
      );
    const incoming = `${bucket}/${environment}/group/incoming/source`;
    assert.equal(denied('s3:PutObject', incoming), false);
    assert.equal(denied('s3:GetObjectVersion', incoming, { 'aws:SecureTransport': 'false' }), true);
    assert.equal(denied('s3:ListBucket', bucket, { 'aws:PrincipalAccount': '999999999999' }), true);
    for (const encryption of [undefined, 'aws:kms', ''])
      assert.equal(
        denied('s3:PutObject', incoming, { 's3:x-amz-server-side-encryption': encryption }),
        true,
      );
    for (const kind of ['incoming', 'processed', 'films']) {
      const object = `${bucket}/${environment}/group/${kind}/value`;
      for (const action of ['s3:PutObject', 's3:PutObjectTagging', 's3:PutObjectVersionTagging']) {
        assert.equal(
          denied(action, object, { 's3:RequestObjectTag/rewind-media-class': kind }),
          false,
        );
        assert.equal(
          denied(action, object, { 's3:RequestObjectTag/rewind-media-class': undefined }),
          true,
        );
        assert.equal(
          denied(action, object, {
            's3:RequestObjectTag/rewind-media-class': kind === 'incoming' ? 'films' : 'incoming',
          }),
          true,
        );
      }
    }
    assert.ok(
      statements.every((statement) => statement.Effect === 'Deny'),
      'Bucket policy must never add public grants',
    );
  });
}

test('storage preserves public block, immutable versions and retained output without default deletion', () => {
  const main = text('main.tf');
  for (const control of [
    'block_public_acls',
    'block_public_policy',
    'ignore_public_acls',
    'restrict_public_buckets',
    'prevent_destroy',
  ])
    assert.match(main, new RegExp(`${control}\\s*=\\s*true`));
  assert.match(main, /force_destroy\s*=\s*false/);
  assert.match(main, /object_ownership\s*=\s*"BucketOwnerEnforced"/);
  assert.match(main, /status\s*=\s*"Enabled"/);
  assert.match(main, /sse_algorithm\s*=\s*"AES256"/);
  assert.match(main, /data\.aws_caller_identity\.current\.account_id\s*==\s*var.account_id/);
  assert.equal((main.match(/\n\s+expiration \{/g) ?? []).length, 1);
  assert.equal((main.match(/\n\s+noncurrent_version_expiration \{/g) ?? []).length, 1);
  assert.match(main, /tags\s*=\s*\{\s*"rewind-media-class"\s*=\s*"incoming"\s*\}/);
  assert.match(main, /allowed_origins\s*=\s*\[var.cors_origin\]/);
  for (const header of [
    'x-amz-tagging',
    'x-amz-checksum-sha256',
    'x-amz-meta-media-ref',
    'x-amz-expected-bucket-owner',
    'x-amz-server-side-encryption',
    'x-amz-version-id',
  ])
    assert.ok(main.includes(`"${header}"`), header);
  assert.match(text('variables.tf'), /\^https:\/\//);
  assert.doesNotMatch(main, /aws_iam_access_key|aws_iam_role_policy_attachment/);
});

test('root state keys, buckets and provider account boundaries are distinct from Demo and one another', () => {
  const keys = [];
  for (const environment of ['dev', 'prod']) {
    const root = new URL(`../../infra/terraform/environments/${environment}/`, import.meta.url);
    const main = readFileSync(new URL('main.tf', root), 'utf8');
    const backend = readFileSync(new URL('backend.hcl.example', root), 'utf8');
    assert.match(main, /allowed_account_ids\s*=\s*\[var.account_id\]/);
    assert.ok(
      main.includes(`environment = "${environment}"`) ||
        new RegExp(`environment\\s*=\\s*"${environment}"`).test(main),
    );
    assert.match(main, /source\s*=\s*"\.\.\/\.\.\/modules\/private-media"/);
    assert.match(backend, /use_lockfile\s*=\s*true/);
    const key = /key\s*=\s*"([^"]+)"/.exec(backend)[1];
    assert.equal(key, `rewind/${environment}/media.tfstate`);
    keys.push(key);
  }
  assert.notEqual(keys[0], keys[1]);
});
