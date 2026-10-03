import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const repository = 'Collaboration95/rewind-app';
export const account = '330599756236';
export const stateBucket = `rewind-terraform-state-${account}`;
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const command = (name, args, options = {}) =>
  execFileSync(name, args, { encoding: 'utf8', ...options });
const gh = (path) => JSON.parse(command('gh', ['api', path]));
export function configuration(environment, operation, context = process.env) {
  assert.ok(['dev', 'prod'].includes(environment), 'Unknown environment');
  assert.ok(['plan', 'apply'].includes(operation), 'Unknown operation');
  const branch = environment === 'dev' ? 'dev' : 'main';
  assert.equal(
    context.GITHUB_ACTIONS,
    'true',
    'Only the reviewed manual Actions workflow may operate',
  );
  assert.equal(context.GITHUB_EVENT_NAME, 'workflow_dispatch');
  assert.equal(context.GITHUB_REPOSITORY, repository);
  assert.equal(context.GITHUB_REPOSITORY_ID, '1354608509');
  assert.equal(context.GITHUB_REPOSITORY_OWNER_ID, '68595032');
  assert.equal(context.GITHUB_REF, `refs/heads/${branch}`);
  assert.match(context.GITHUB_SHA ?? '', /^[a-f0-9]{40}$/);
  assert.equal(
    context.QUIESCENT_ENVIRONMENT,
    'true',
    'Operator must confirm no external Terraform writer',
  );
  assert.match(
    context.MEDIA_KMS_KEY_ARN ?? '',
    /^arn:aws:kms:ap-southeast-1:330599756236:key\/[A-Za-z0-9-]+$/,
  );
  assert.match(
    context.MEDIA_CORS_ORIGIN ?? '',
    /^https:\/\/[A-Za-z0-9][A-Za-z0-9.-]*(?::[0-9]+)?$/,
  );
  return {
    environment,
    branch,
    sha: context.GITHUB_SHA,
    gate: `terraform-${environment}-${operation}`,
    root: resolve(`infra/terraform/environments/${environment}`),
    stateKey: `rewind/${environment}/media.tfstate`,
    variables: {
      account_id: account,
      aws_region: 'ap-southeast-1',
      kms_key_arn: context.MEDIA_KMS_KEY_ARN,
      cors_origin: context.MEDIA_CORS_ORIGIN,
    },
  };
}

export function verifyProtection(environment, branch) {
  const reviewer = environment.protection_rules?.find((rule) => rule.type === 'required_reviewers');
  assert.ok(reviewer?.reviewers?.length > 0, 'Required human reviewers are missing');
  assert.equal(reviewer.prevent_self_review, true, 'Self review must be disabled');
  assert.equal(environment.can_admins_bypass, false, 'Administrator bypass must be disabled');
  assert.equal(environment.deployment_branch_policy?.protected_branches, true);
  assert.equal(environment.deployment_branch_policy?.custom_branch_policies, false);
  assert.equal(branch.protected, true, 'Branch must be protected');
}

export function verifyQuality(checks, sha) {
  const quality = checks.filter(
    (check) =>
      check.name === 'Format, lint, typecheck, and test' &&
      check.app?.slug === 'github-actions' &&
      check.head_sha === sha,
  );
  assert.ok(quality.length > 0, 'Exact head is missing the aggregate Quality check');
  assert.ok(
    quality.every((check) => check.status === 'completed' && check.conclusion === 'success'),
  );
}

export function preflight(config, api = gh) {
  const base = `repos/${repository}`;
  const repo = api(base);
  assert.equal(repo.id, 1354608509);
  assert.equal(repo.owner?.id, 68595032);
  assert.equal(
    repo.private,
    true,
    'Saved state plans require private artifact access; public repository operations are disabled',
  );
  const oidc = api(`${base}/actions/oidc/customization/sub`);
  assert.equal(oidc.use_default, true);
  assert.equal(oidc.use_immutable_subject, true);
  assert.equal(oidc.sub_claim_prefix, 'repo:Collaboration95@68595032/rewind-app@1354608509');
  const branch = api(`${base}/branches/${config.branch}`);
  assert.equal(branch.commit.sha, config.sha, 'Reviewed checkout must remain the branch head');
  verifyProtection(api(`${base}/environments/${config.gate}`), branch);
  const checks = api(`${base}/commits/${config.sha}/check-runs?per_page=100`);
  assert.ok(checks.total_count <= 100, 'Check pagination requires explicit review');
  verifyQuality(checks.check_runs, config.sha);
}

export function verifyPlan(plan) {
  assert.equal(plan.errored, false, 'Plan must not contain errors');
  assert.ok(Array.isArray(plan.resource_changes), 'Plan changes are missing');
  const resources = new Set([
    'aws_s3_bucket.media',
    'aws_s3_bucket_public_access_block.media',
    'aws_s3_bucket_ownership_controls.media',
    'aws_s3_bucket_versioning.media',
    'aws_s3_bucket_server_side_encryption_configuration.media',
    'aws_s3_bucket_cors_configuration.media',
    'aws_s3_bucket_lifecycle_configuration.media',
    'aws_s3_bucket_policy.media',
    'aws_iam_policy.runtime_media',
  ]);
  for (const change of plan.resource_changes) {
    if (change.mode === 'data') {
      assert.ok(
        [
          'module.private_media.data.aws_caller_identity.current',
          'module.private_media.data.aws_kms_key.media',
        ].includes(change.address),
      );
      continue;
    }
    assert.ok(
      resources.has(change.address.replace(/^module\.private_media\./, '')) &&
        change.address.startsWith('module.private_media.'),
      `Unreviewed resource ${change.address}`,
    );
    assert.ok(
      change.change.actions.every((action) => ['no-op', 'create', 'update'].includes(action)),
      'Delete/replacement requires separate review',
    );
  }
  assert.ok(!plan.deferred_changes?.length, 'Deferred changes require separate review');
}

export function metadata(config, bytes, sourceRun, sourceAttempt) {
  return {
    schema: 1,
    account,
    region: 'ap-southeast-1',
    environment: config.environment,
    sha: config.sha,
    stateBucket,
    stateKey: config.stateKey,
    terraform: '1.16.0',
    sourceRun,
    sourceAttempt,
    variablesSha256: sha256(JSON.stringify(config.variables)),
    lockSha256: sha256(readFileSync(resolve(config.root, '.terraform.lock.hcl'))),
    planSha256: sha256(bytes),
  };
}

export function verifySavedPlan(config, meta, bytes, digest, run, attempt) {
  assert.match(
    digest ?? '',
    /^[a-f0-9]{64}$/,
    'A human must supply the reviewed saved-plan SHA-256',
  );
  assert.match(run ?? '', /^[1-9][0-9]*$/);
  assert.match(attempt ?? '', /^[1-9][0-9]*$/);
  assert.deepEqual(
    meta,
    metadata(config, bytes, run, attempt),
    'Plan metadata or configuration changed',
  );
  assert.equal(meta.planSha256, digest, 'Human-reviewed digest differs from saved binary plan');
}

export function verifySourceRun(run, config, id, attempt) {
  assert.equal(String(run.id), id);
  assert.equal(String(run.run_attempt), attempt);
  assert.equal(run.head_sha, config.sha);
  assert.equal(run.head_branch, config.branch);
  assert.equal(run.event, 'workflow_dispatch');
  assert.equal(run.path, '.github/workflows/terraform-environments.yml');
  assert.equal(run.status, 'completed');
  assert.equal(run.conclusion, 'success');
  assert.equal(run.repository?.id, 1354608509);
  assert.equal(run.head_repository?.id, 1354608509);
}

function operate(operation, config, folder) {
  preflight(config);
  assert.equal(command('git', ['rev-parse', 'HEAD']).trim(), config.sha);
  assert.equal(
    command('git', ['status', '--porcelain', '--untracked-files=no']).trim(),
    '',
    'Tracked checkout must be clean',
  );
  assert.equal(JSON.parse(command('terraform', ['version', '-json'])).terraform_version, '1.16.0');
  const tf = (args, options) => command('terraform', [`-chdir=${config.root}`, ...args], options);
  const varsFile = resolve(folder, 'reviewed.tfvars.json');
  const planFile = resolve(folder, 'media.tfplan');
  const metaFile = resolve(folder, 'metadata.json');
  if (operation === 'apply') {
    verifySavedPlan(
      config,
      JSON.parse(readFileSync(metaFile)),
      readFileSync(planFile),
      process.env.REVIEWED_PLAN_SHA256,
      process.env.PLAN_RUN_ID,
      process.env.PLAN_RUN_ATTEMPT,
    );
  }
  const caller = JSON.parse(command('aws', ['sts', 'get-caller-identity', '--output', 'json']));
  assert.equal(caller.Account, account);
  assert.match(
    caller.Arn,
    new RegExp(
      `^arn:aws:sts::${account}:assumed-role/rewind-${config.environment}-terraform-${operation}/`,
    ),
  );
  assert.ok(!process.env.AWS_PROFILE, 'Local credential profiles are forbidden');
  const backend = [
    `bucket=${stateBucket}`,
    `key=${config.stateKey}`,
    'region=ap-southeast-1',
    'encrypt=true',
    'use_lockfile=true',
    `allowed_account_ids=["${account}"]`,
  ];
  tf(
    [
      'init',
      '-input=false',
      '-reconfigure',
      '-lockfile=readonly',
      ...backend.map((value) => `-backend-config=${value}`),
    ],
    { stdio: 'inherit' },
  );
  assert.equal(
    tf(['workspace', 'show']).trim(),
    'default',
    'Only the default workspace is allowed',
  );
  if (operation === 'apply') verifyPlan(JSON.parse(tf(['show', '-json', planFile])));
  if (operation === 'plan') {
    writeFileSync(varsFile, JSON.stringify(config.variables), { mode: 0o600 });
    tf(['plan', '-input=false', '-lock=false', `-var-file=${varsFile}`, `-out=${planFile}`], {
      stdio: 'inherit',
    });
    const json = tf(['show', '-json', planFile]);
    verifyPlan(JSON.parse(json));
    writeFileSync(resolve(folder, 'plan.json'), json, { mode: 0o600 });
    const meta = metadata(
      config,
      readFileSync(planFile),
      process.env.GITHUB_RUN_ID,
      process.env.GITHUB_RUN_ATTEMPT,
    );
    writeFileSync(metaFile, JSON.stringify(meta, null, 2), { mode: 0o600 });
    writeFileSync(resolve(folder, 'plan.txt'), tf(['show', '-no-color', planFile]), {
      mode: 0o600,
    });
    console.log(`Review saved plan SHA-256: ${meta.planSha256}`);
    if (process.env.GITHUB_STEP_SUMMARY)
      writeFileSync(
        process.env.GITHUB_STEP_SUMMARY,
        `Review the private plan artifact from run ${meta.sourceRun}, attempt ${meta.sourceAttempt}.\n\nEnvironment: ${meta.environment}; head: ${meta.sha}\n\nSaved plan SHA-256: \`${meta.planSha256}\`\n`,
        { flag: 'a' },
      );
  } else {
    // Recheck branch/protections after init; Terraform also rejects stale state.
    preflight(config);
    tf(['apply', '-input=false', '-lock-timeout=60s', planFile], { stdio: 'inherit' });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [phase, environment, operation] = process.argv.slice(2);
  const config = configuration(environment, operation);
  if (phase === 'preflight') preflight(config);
  else if (phase === 'run') {
    const folder = resolve(process.env.RUNNER_TEMP, 'reviewed-media-plan');
    mkdirSync(folder, { recursive: true, mode: 0o700 });
    operate(operation, config, folder);
  } else if (phase === 'download') {
    assert.equal(operation, 'apply');
    preflight(config);
    const id = process.env.PLAN_RUN_ID;
    const attempt = process.env.PLAN_RUN_ATTEMPT;
    assert.match(id ?? '', /^[1-9][0-9]*$/);
    assert.match(attempt ?? '', /^[1-9][0-9]*$/);
    verifySourceRun(gh(`repos/${repository}/actions/runs/${id}`), config, id, attempt);
    const folder = resolve(process.env.RUNNER_TEMP, 'reviewed-media-plan');
    command('gh', [
      'run',
      'download',
      id,
      '--repo',
      repository,
      '--name',
      `media-plan-${environment}-${attempt}`,
      '--dir',
      folder,
    ]);
    verifySavedPlan(
      config,
      JSON.parse(readFileSync(resolve(folder, 'metadata.json'))),
      readFileSync(resolve(folder, 'media.tfplan')),
      process.env.REVIEWED_PLAN_SHA256,
      id,
      attempt,
    );
  } else throw new Error('Unknown phase');
}
