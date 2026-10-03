import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  configuration,
  preflight,
  metadata,
  verifySavedPlan,
  verifyPlan,
  verifySourceRun,
} from '../../infra/scripts/terraform-environment.mjs';

const read = (path) => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');
const values = (environment, operation) => ({
  environment,
  operation,
  branch: environment === 'dev' ? 'dev' : 'main',
  kms_key_arn: 'arn:aws:kms:ap-southeast-1:330599756236:key/reviewed-key',
});
function render(name, environment, operation) {
  return JSON.parse(
    read(`infra/terraform/modules/environment-identity/${name}.json.tftpl`).replace(
      /\$\{([a-z_]+)\}/g,
      (_, key) => {
        assert.ok(key in values(environment, operation));
        return values(environment, operation)[key];
      },
    ),
  );
}
const list = (value) => (Array.isArray(value) ? value : [value]);
function matches(statement, action, resource, context = {}) {
  context = { 'aws:ResourceAccount': '330599756236', ...context };
  return (
    list(statement.Action).includes(action) &&
    list(statement.Resource).some((arn) => arn === '*' || arn === resource) &&
    Object.entries(statement.Condition?.StringEquals ?? {}).every(
      ([key, value]) => context[key] === value,
    )
  );
}
const allowed = (policy, action, resource, context) =>
  policy.Statement.some(
    (statement) => statement.Effect === 'Allow' && matches(statement, action, resource, context),
  );
const context = {
  GITHUB_ACTIONS: 'true',
  GITHUB_EVENT_NAME: 'workflow_dispatch',
  GITHUB_REPOSITORY: 'Collaboration95/rewind-app',
  GITHUB_REPOSITORY_ID: '1354608509',
  GITHUB_REPOSITORY_OWNER_ID: '68595032',
  GITHUB_REF: 'refs/heads/dev',
  GITHUB_SHA: 'a'.repeat(40),
  QUIESCENT_ENVIRONMENT: 'true',
  MEDIA_KMS_KEY_ARN: values('dev').kms_key_arn,
  MEDIA_CORS_ORIGIN: 'https://reviewed.example.com',
};

for (const environment of ['dev', 'prod'])
  for (const operation of ['plan', 'apply']) {
    test(`${environment}/${operation} trust rejects missing/changed claims, forks, renamed identities, PRs and cross-role tokens`, () => {
      const trust = render('trust', environment, operation).Statement[0];
      assert.equal(
        trust.Principal.Federated,
        'arn:aws:iam::330599756236:oidc-provider/token.actions.githubusercontent.com',
      );
      assert.equal(trust.Action, 'sts:AssumeRoleWithWebIdentity');
      const claims = trust.Condition.StringEquals;
      const accept = (input) =>
        Object.entries(claims).every(([key, value]) => input[key] === value);
      assert.equal(accept(claims), true);
      for (const key of Object.keys(claims)) {
        assert.equal(accept({ ...claims, [key]: 'wrong' }), false, key);
        const missing = { ...claims };
        delete missing[key];
        assert.equal(accept(missing), false, key);
      }
      assert.equal(
        accept({ ...claims, 'token.actions.githubusercontent.com:ref': 'refs/pull/12/merge' }),
        false,
      );
      assert.equal(
        accept({
          ...claims,
          'token.actions.githubusercontent.com:sub': `repo:Collaboration95/rewind-app:environment:terraform-${environment}-${operation}`,
        }),
        false,
      );
      assert.equal(
        claims['token.actions.githubusercontent.com:ref'],
        `refs/heads/${environment === 'dev' ? 'dev' : 'main'}`,
      );
      assert.equal(
        claims['token.actions.githubusercontent.com:environment'],
        `terraform-${environment}-${operation}`,
      );
    });

    test(`${environment}/${operation} scopes state, metadata, runtime IAM and existing key without object contents or account privileges`, () => {
      const policy = render(`${operation}-policy`, environment, operation);
      const other = environment === 'dev' ? 'prod' : 'dev';
      const state = `arn:aws:s3:::rewind-terraform-state-330599756236/rewind/${environment}/media.tfstate`;
      const bucket = `arn:aws:s3:::rewind-${environment}-media-330599756236`;
      assert.equal(allowed(policy, 's3:GetObject', state), true);
      assert.equal(
        allowed(policy, 's3:GetObject', state, { 'aws:ResourceAccount': '999999999999' }),
        false,
      );
      assert.equal(allowed(policy, 's3:PutObject', state), operation === 'apply');
      assert.equal(allowed(policy, 's3:DeleteObject', state), false);
      for (const action of ['s3:GetObject', 's3:PutObject', 's3:DeleteObject'])
        assert.equal(allowed(policy, action, `${state}.tflock`), operation === 'apply');
      for (const resource of [
        state.replace(environment, other),
        state.replace('media.tfstate', 'terraform.tfstate'),
        state.replace('330599756236', '999999999999'),
        `${bucket}/${environment}/group/films/private.mp4`,
      ]) {
        for (const action of [
          's3:GetObject',
          's3:GetObjectVersion',
          's3:PutObject',
          's3:DeleteObjectVersion',
        ])
          assert.equal(allowed(policy, action, resource), false, `${action}:${resource}`);
      }
      for (const prefix of ['', 'rewind/', `rewind/${other}/media.tfstate`])
        assert.equal(
          allowed(policy, 's3:ListBucket', 'arn:aws:s3:::rewind-terraform-state-330599756236', {
            's3:prefix': prefix,
          }),
          false,
        );
      assert.equal(allowed(policy, 's3:GetBucketCORS', bucket), true);
      assert.equal(
        allowed(policy, 's3:CreateBucket', bucket, { 's3:LocationConstraint': 'ap-southeast-1' }),
        operation === 'apply',
      );
      assert.equal(
        allowed(policy, 's3:CreateBucket', bucket, { 's3:LocationConstraint': 'us-east-1' }),
        false,
      );
      assert.equal(allowed(policy, 's3:PutBucketCORS', bucket), operation === 'apply');
      assert.equal(allowed(policy, 's3:PutBucketCORS', bucket.replace(environment, other)), false);
      assert.equal(allowed(policy, 'kms:DescribeKey', values(environment).kms_key_arn), true);
      assert.equal(
        allowed(
          policy,
          'kms:DescribeKey',
          values(environment).kms_key_arn.replace('reviewed-key', 'other-key'),
        ),
        false,
      );
      const runtime = `arn:aws:iam::330599756236:policy/rewind-${environment}-private-media`;
      assert.equal(allowed(policy, 'iam:CreatePolicyVersion', runtime), operation === 'apply');
      assert.equal(
        allowed(policy, 'iam:CreatePolicyVersion', runtime.replace(environment, other)),
        false,
      );
      for (const statement of policy.Statement)
        for (const action of list(statement.Action)) {
          assert.ok(!action.includes('*'), `No service wildcard: ${action}`);
          assert.ok(
            !/^(organizations|account|aws-portal|billing|budgets|ce|payments|ec2|lightsail|cloudfront):/.test(
              action,
            ),
          );
          if (action !== 'sts:GetCallerIdentity')
            assert.ok(!list(statement.Resource).includes('*'));
        }
      for (const action of [
        'iam:PassRole',
        'iam:CreateRole',
        'iam:AttachRolePolicy',
        'iam:PutRolePolicy',
        'iam:DeletePolicy',
        'kms:CreateKey',
        'kms:Encrypt',
        'kms:Decrypt',
        'kms:PutKeyPolicy',
        's3:DeleteBucket',
      ])
        assert.equal(allowed(policy, action, runtime), false);
    });
  }

test('manual operation rejects untrusted context and absent reviewed configuration', () => {
  for (const [key, value] of [
    ['GITHUB_ACTIONS', 'false'],
    ['GITHUB_EVENT_NAME', 'pull_request'],
    ['GITHUB_REF', 'refs/pull/5/merge'],
    ['GITHUB_REPOSITORY_ID', '999'],
    ['QUIESCENT_ENVIRONMENT', 'false'],
    ['MEDIA_KMS_KEY_ARN', ''],
    ['MEDIA_CORS_ORIGIN', '*'],
  ])
    assert.throws(() => configuration('dev', 'plan', { ...context, [key]: value }));
  assert.throws(() => configuration('prod', 'apply', context));
});

function apiFixture(overrides = {}) {
  const environment = {
    protection_rules: [
      {
        type: 'required_reviewers',
        prevent_self_review: true,
        reviewers: [{ type: 'User', reviewer: { id: 123 } }],
      },
    ],
    can_admins_bypass: false,
    deployment_branch_policy: { protected_branches: true, custom_branch_policies: false },
  };
  return (path) => {
    if (path === 'repos/Collaboration95/rewind-app')
      return overrides.repository ?? { id: 1354608509, owner: { id: 68595032 }, private: true };
    if (path.endsWith('/sub'))
      return (
        overrides.oidc ?? {
          use_default: true,
          use_immutable_subject: true,
          sub_claim_prefix: 'repo:Collaboration95@68595032/rewind-app@1354608509',
        }
      );
    if (path.includes('/branches/'))
      return overrides.branch ?? { protected: true, commit: { sha: context.GITHUB_SHA } };
    if (path.includes('/environments/')) return overrides.environment ?? environment;
    if (path.includes('/check-runs'))
      return (
        overrides.checks ?? {
          total_count: 1,
          check_runs: [
            {
              name: 'Format, lint, typecheck, and test',
              app: { slug: 'github-actions' },
              head_sha: context.GITHUB_SHA,
              status: 'completed',
              conclusion: 'success',
            },
          ],
        }
      );
    throw new Error(`Unexpected API ${path}`);
  };
}

test('fail closed on missing environment protections, bypass, stale head, Quality and immutable subject configuration', () => {
  const config = configuration('dev', 'plan', context);
  preflight(config, apiFixture());
  for (const overrides of [
    { repository: { id: 1354608509, owner: { id: 68595032 }, private: false } },
    { environment: {} },
    { environment: { ...apiFixture()('x/environments/x'), can_admins_bypass: true } },
    {
      environment: {
        ...apiFixture()('x/environments/x'),
        protection_rules: [
          { type: 'required_reviewers', prevent_self_review: false, reviewers: [{}] },
        ],
      },
    },
    { branch: { protected: false, commit: { sha: context.GITHUB_SHA } } },
    { branch: { protected: true, commit: { sha: 'b'.repeat(40) } } },
    { checks: { total_count: 0, check_runs: [] } },
    { oidc: { use_default: true, use_immutable_subject: false } },
  ])
    assert.throws(() => preflight(config, apiFixture(overrides)));
  assert.throws(() =>
    preflight(config, () => {
      throw new Error('403');
    }),
  );
});

test('saved binary plan approval binds digest, source run/attempt, environment, head, inputs, lockfile and state', () => {
  const temp = mkdtempSync(join(tmpdir(), 'rewind-174-'));
  try {
    writeFileSync(join(temp, '.terraform.lock.hcl'), 'reviewed provider lock');
    const config = { ...configuration('dev', 'apply', context), root: temp };
    const bytes = Buffer.from('saved opaque Terraform binary');
    const meta = metadata(config, bytes, '100', '1');
    verifySavedPlan(config, meta, bytes, meta.planSha256, '100', '1');
    for (const key of [
      'environment',
      'sha',
      'account',
      'stateKey',
      'variablesSha256',
      'lockSha256',
      'sourceRun',
      'sourceAttempt',
    ])
      assert.throws(() =>
        verifySavedPlan(config, { ...meta, [key]: 'wrong' }, bytes, meta.planSha256, '100', '1'),
      );
    assert.throws(() =>
      verifySavedPlan(config, meta, Buffer.from('tampered'), meta.planSha256, '100', '1'),
    );
    assert.throws(() => verifySavedPlan(config, meta, bytes, '', '100', '1'));
    assert.throws(() =>
      verifySavedPlan(
        { ...config, variables: { ...config.variables, cors_origin: 'https://other.example' } },
        meta,
        bytes,
        meta.planSha256,
        '100',
        '1',
      ),
    );
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test('reject destructive, role and future hosting plans and nonreviewed source runs', () => {
  const change = {
    address: 'module.private_media.aws_s3_bucket.media',
    mode: 'managed',
    change: { actions: ['update'] },
  };
  verifyPlan({ errored: false, resource_changes: [change] });
  for (const actions of [['delete'], ['delete', 'create']])
    assert.throws(() =>
      verifyPlan({ errored: false, resource_changes: [{ ...change, change: { actions } }] }),
    );
  for (const address of [
    'module.private_media.aws_iam_role.runtime',
    'module.hosting.aws_cloudfront_distribution.web',
  ])
    assert.throws(() => verifyPlan({ errored: false, resource_changes: [{ ...change, address }] }));
  assert.throws(() => verifyPlan({ errored: true, resource_changes: [] }));
  assert.throws(() => verifyPlan({ errored: false, resource_changes: [], deferred_changes: [{}] }));
  const config = configuration('dev', 'apply', context);
  const run = {
    id: 100,
    run_attempt: 1,
    head_sha: config.sha,
    head_branch: 'dev',
    event: 'workflow_dispatch',
    path: '.github/workflows/terraform-environments.yml',
    status: 'completed',
    conclusion: 'success',
    repository: { id: 1354608509 },
    head_repository: { id: 1354608509 },
  };
  verifySourceRun(run, config, '100', '1');
  for (const [key, value] of [
    ['event', 'pull_request'],
    ['head_sha', 'b'.repeat(40)],
    ['run_attempt', 2],
    ['conclusion', 'failure'],
    ['path', '.github/workflows/other.yml'],
    ['head_repository', { id: 999 }],
  ])
    assert.throws(() => verifySourceRun({ ...run, [key]: value }, config, '100', '1'));
});

test('workflow is manual, serial per environment, with gates before credentials and saved-plan apply only', () => {
  const workflow = read('.github/workflows/terraform-environments.yml');
  assert.match(workflow, /workflow_dispatch:/);
  assert.doesNotMatch(workflow, /\n\s+(pull_request|pull_request_target|push):/);
  assert.match(workflow, /group: terraform-media-\$\{\{ inputs.environment \}\}/);
  assert.match(workflow, /cancel-in-progress: false/);
  assert.match(
    workflow,
    /environment: terraform-\$\{\{ inputs.environment \}\}-\$\{\{ inputs.operation \}\}/,
  );
  assert.ok(
    workflow.indexOf('terraform-environment.mjs preflight') <
      workflow.indexOf('aws-actions/configure-aws-credentials@'),
  );
  assert.ok(
    workflow.indexOf('terraform-environment.mjs download') <
      workflow.indexOf('aws-actions/configure-aws-credentials@'),
  );
  assert.match(read('infra/terraform/bootstrap/environment-identity.tf'), /default\s*=\s*\{\}/);
  assert.match(
    read('infra/terraform/modules/environment-identity/main.tf'),
    /permissions_boundary\s*=\s*aws_iam_policy.boundary\[each.key\].arn/,
  );
});

test('offline command fixture stops before credentials on failed gates and applies only the approved binary', async () => {
  const { execFileSync } = await import('node:child_process');
  const { mkdirSync, symlinkSync } = await import('node:fs');
  const temp = mkdtempSync(join(tmpdir(), 'rewind-174-command-'));
  try {
    const bin = join(temp, 'bin');
    mkdirSync(bin);
    const fixture = join(bin, 'fixture.mjs');
    writeFileSync(
      fixture,
      `#!/usr/bin/env node
import {readFileSync,writeFileSync,appendFileSync} from 'node:fs';
import {basename} from 'node:path';
const name=basename(process.argv[1]);const args=process.argv.slice(2);
appendFileSync(process.env.FIXTURE_LOG,JSON.stringify([name,...args])+'\\n');
const output=(value)=>console.log(typeof value==='object'?JSON.stringify(value):value);
if(name==='gh') {
 const path=args[1];
 if(path==='repos/Collaboration95/rewind-app') { output({id:1354608509,owner:{id:68595032},private:process.env.PUBLIC_REPO!=='true'});process.exit(0); }
 if(path.endsWith('/sub')) output({use_default:true,use_immutable_subject:true,sub_claim_prefix:'repo:Collaboration95@68595032/rewind-app@1354608509'});
 else if(path.includes('/branches/')) output({protected:true,commit:{sha:process.env.GITHUB_SHA}});
 else if(path.includes('/environments/')) output(process.env.FAIL_GATE==='true'?{}:{can_admins_bypass:false,protection_rules:[{type:'required_reviewers',prevent_self_review:true,reviewers:[{}]}],deployment_branch_policy:{protected_branches:true,custom_branch_policies:false}});
 else if(path.includes('/check-runs')) output({total_count:1,check_runs:[{name:'Format, lint, typecheck, and test',app:{slug:'github-actions'},head_sha:process.env.GITHUB_SHA,status:'completed',conclusion:'success'}]});
 else process.exit(2);
} else if(name==='git') output(args[0]==='rev-parse'?process.env.GITHUB_SHA:'');
else if(name==='aws') output({Account:'330599756236',Arn:'arn:aws:sts::330599756236:assumed-role/rewind-dev-terraform-'+process.env.FIXTURE_OPERATION+'/offline'});
else if(name==='terraform') {
 if(args[0]==='version') output({terraform_version:'1.16.0'});
 else if(args.includes('workspace')) output('default');
 else if(args.includes('plan')) writeFileSync(args.find(x=>x.startsWith('-out=')).slice(5),'offline saved plan');
 else if(args.includes('show')) output(args.includes('-json')?{errored:false,resource_changes:[{address:'module.private_media.aws_s3_bucket.media',mode:'managed',change:{actions:['update']}}]}:'Offline human plan summary');
 else if(!args.includes('init')&&!args.includes('apply')) process.exit(3);
} else process.exit(4);
`,
      { mode: 0o700 },
    );
    for (const name of ['gh', 'git', 'aws', 'terraform']) symlinkSync(fixture, join(bin, name));
    const log = join(temp, 'commands.log');
    const env = {
      ...process.env,
      ...context,
      PATH: `${bin}:${process.env.PATH}`,
      RUNNER_TEMP: temp,
      FIXTURE_LOG: log,
      FIXTURE_OPERATION: 'plan',
      GITHUB_RUN_ID: '100',
      GITHUB_RUN_ATTEMPT: '1',
    };
    delete env.AWS_PROFILE;
    const script = new URL('../../infra/scripts/terraform-environment.mjs', import.meta.url)
      .pathname;
    const exec = (operation, extra = {}) =>
      execFileSync(process.execPath, [script, 'run', 'dev', operation], {
        env: { ...env, ...extra },
        stdio: 'pipe',
      });
    assert.throws(() => exec('plan', { FAIL_GATE: 'true' }));
    assert.doesNotMatch(readFileSync(log, 'utf8'), /"aws"|"terraform"/);
    writeFileSync(log, '');
    assert.throws(() => exec('plan', { PUBLIC_REPO: 'true' }));
    assert.doesNotMatch(readFileSync(log, 'utf8'), /"aws"|"terraform"/);
    writeFileSync(log, '');
    exec('plan');
    const commands = readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse);
    const plan = commands.find((command) => command.includes('plan'));
    assert.ok(plan.includes('-lock=false'));
    const init = commands.find((command) => command.includes('init'));
    assert.ok(init.includes('-backend-config=key=rewind/dev/media.tfstate'));
    assert.ok(init.includes('-backend-config=allowed_account_ids=["330599756236"]'));
    writeFileSync(log, '');
    assert.throws(() => exec('apply', { FIXTURE_OPERATION: 'apply' }));
    assert.doesNotMatch(readFileSync(log, 'utf8'), /"aws"|"apply"/);
    const meta = JSON.parse(readFileSync(join(temp, 'reviewed-media-plan/metadata.json')));
    writeFileSync(log, '');
    exec('apply', {
      FIXTURE_OPERATION: 'apply',
      REVIEWED_PLAN_SHA256: meta.planSha256,
      PLAN_RUN_ID: '100',
      PLAN_RUN_ATTEMPT: '1',
    });
    const applyCommands = readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse);
    assert.ok(!applyCommands.some((command) => command.includes('plan')));
    const apply = applyCommands.find((command) => command.includes('apply'));
    assert.equal(apply.at(-1), join(temp, 'reviewed-media-plan/media.tfplan'));
    assert.ok(apply.includes('-lock-timeout=60s'));
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});
