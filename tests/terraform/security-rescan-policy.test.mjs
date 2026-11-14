import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const access = await readFile(
  new URL('../../infra/terraform/bootstrap/access.tf', import.meta.url),
  'utf8',
);
const storage = await readFile(
  new URL('../../infra/terraform/demo/storage.tf', import.meta.url),
  'utf8',
);

test('the apply role uses explicit S3 operations limited to Rewind and state buckets', () => {
  assert.doesNotMatch(access, /"s3:\*"/);
  const block = access.slice(access.indexOf('sid    = "ManageRewindBucketsAndState"'));
  assert.match(block, /"s3:PutBucketLogging"/);
  assert.match(block, /"s3:GetObject"/);
  assert.match(block, /"arn:aws:s3:::rewind-\*"/);
  assert.match(block, /"arn:aws:s3:::\$\{var.state_bucket_name\}\/\*"/);
  assert.doesNotMatch(block.split('resource "aws_iam_role_policy"')[0], /resources = \["\*"\]/);
});

test('backup access logs use the existing private audit bucket with a bounded source and retention', () => {
  assert.match(
    storage,
    /resource "aws_s3_bucket_logging" "backups" \{[\s\S]*?target_bucket = aws_s3_bucket.audit_logs.id/,
  );
  assert.match(storage, /identifiers = \["logging.s3.amazonaws.com"\]/);
  assert.match(
    storage,
    /variable = "aws:SourceArn"[\s\S]*?values\s*= \[aws_s3_bucket.backups.arn\]/,
  );
  assert.match(storage, /variable = "aws:SourceAccount"[\s\S]*?values\s*= \[var.account_id\]/);
  assert.match(
    storage,
    /resources = \["\$\{aws_s3_bucket.audit_logs.arn\}\/access\/backups\/\*"\]/,
  );
  assert.match(storage, /id\s*= "expire-backup-access-logs"[\s\S]*?expiration \{ days = 30 \}/);
  assert.doesNotMatch(storage, /sse_algorithm\s*=\s*"aws:kms"/);
});
