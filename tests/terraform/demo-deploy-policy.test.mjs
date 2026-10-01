import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import test from 'node:test';

const read = (path) => readFile(new URL(`../../${path}`, import.meta.url), 'utf8');

const [
  workflow,
  deployTf,
  demoVariables,
  demoLightsail,
  bootstrapAccess,
  bootstrapVariables,
  release,
] = await Promise.all([
  read('.github/workflows/deploy-dev.yml'),
  read('infra/terraform/demo/deploy.tf'),
  read('infra/terraform/demo/variables.tf'),
  read('infra/terraform/demo/lightsail.tf'),
  read('infra/terraform/bootstrap/access.tf'),
  read('infra/terraform/bootstrap/variables.tf'),
  read('deploy/release.py'),
]);

test('the deploy pipeline targets the existing hosted host and provisions nothing', async () => {
  await assert.rejects(
    access(new URL('../../infra/terraform/dev', import.meta.url)),
    /ENOENT/,
    'no separate dev Lightsail root may be introduced',
  );
  assert.match(demoLightsail, /instance_name\s*=\s*"rewind-demo"/);
  assert.match(workflow, /REWIND_DEMO_INSTANCE \|\| 'rewind-demo'/);
  assert.doesNotMatch(workflow, /rewind-dev/);
  assert.doesNotMatch(workflow, /terraform (apply|plan|destroy)/);
  assert.doesNotMatch(workflow, /aws_lightsail_instance/);
});

test('only a dev commit that passed its own Quality run may deploy', () => {
  assert.match(workflow, /on:\n  push:\n    branches: \[dev\]/);
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /group: deploy-demo-dev/);
  assert.match(workflow, /environment: dev/);
  assert.match(workflow, /quality\.yml\/runs/);
  assert.match(workflow, /-f branch=dev/);
  assert.match(workflow, /--branch dev/);
  assert.match(workflow, /--green-sha "\$sha"/);
});

test('the job reaches the host with temporary, always-closed SSH', () => {
  assert.match(workflow, /id-token: write/);
  assert.match(workflow, /ACTIONS_ID_TOKEN_REQUEST_URL/);
  assert.match(workflow, /assume-role-with-web-identity/);
  assert.doesNotMatch(workflow, /secrets\.AWS_/, 'no stored AWS credential');
  assert.doesNotMatch(workflow, /aws-actions\/configure-aws-credentials/);
  assert.match(workflow, /open-instance-public-ports/);
  assert.match(workflow, /close-instance-public-ports/);
  assert.match(workflow, /if: always\(\)/);
  assert.match(workflow, /get-instance-access-details/);
  assert.match(workflow, /rm -rf -- "\$RUNNER_TEMP\/rewind-ssh"/);
  assert.match(
    workflow,
    /if: always\(\)[\s\S]*close-instance-public-ports[\s\S]*rm -rf -- "\$RUNNER_TEMP\/rewind-ssh"/,
  );
});

test('a deploy never powers the host on or off and never rewrites its private config', () => {
  assert.match(workflow, /if \[ "\$state" != running \]; then/);
  assert.match(workflow, /the deploy never powers the host on or off/);
  assert.doesNotMatch(workflow, /lightsail (start|stop)-instance/);
  assert.doesNotMatch(workflow, /rewind\.env\.(dev|example)/);
  assert.doesNotMatch(workflow, /install -o ubuntu[\s\S]{0,40}rewind\.env/);
  assert.match(workflow, /REWIND_DEMO_CONFIG_VERSION \|\| 'demo-v1'/);
  assert.match(workflow, /release-host\.sh install/);
});

test('the deploy role trusts one environment, one branch, and one host', () => {
  assert.match(deployTf, /name\s*=\s*"rewind-demo-deploy"/);
  assert.match(deployTf, /actions = \["sts:AssumeRoleWithWebIdentity"\]/);
  assert.match(deployTf, /deploy_environment\s*=\s*"dev"/);
  assert.match(deployTf, /deploy_branch\s*=\s*"dev"/);
  assert.match(deployTf, /:environment:\$\{local\.deploy_environment\}"\]/);
  assert.match(deployTf, /"refs\/heads\/\$\{local\.deploy_branch\}"/);
  assert.match(deployTf, /token\.actions\.githubusercontent\.com:aud/);
  assert.match(deployTf, /values\s*=\s*\["sts\.amazonaws\.com"\]/);
  assert.match(demoVariables, /variable "github_repository"/);
});

test('the deploy role carries the live instance ARN and cannot mutate the host', () => {
  // The ARN comes from the instance resource, so it stays correct after the
  // documented hibernation/wake cycle replaces the host.
  assert.match(deployTf, /deploy_instance_arn = try\(\s*aws_lightsail_instance\.rewind\[0\]\.arn/);
  assert.match(deployTf, /resources = \[local\.deploy_instance_arn\]/);
  assert.match(deployTf, /"lightsail:GetInstanceAccessDetails"/);
  assert.match(deployTf, /"lightsail:OpenInstancePublicPorts"/);
  assert.match(deployTf, /"lightsail:CloseInstancePublicPorts"/);
  assert.doesNotMatch(deployTf, /lightsail:(Start|Stop|Reboot|Delete|Create|Detach|Attach)/);
  const wildcard = deployTf
    .split('sid       = "ReadTheDemoHostAddress"')[1]
    .split('statement {')[0];
  assert.match(wildcard, /actions\s*=\s*\["lightsail:GetInstance"\]/);
  assert.match(wildcard, /resources = \["\*"\]/);
});

test('the account-level OIDC provider lives in the bootstrap root', () => {
  assert.match(bootstrapAccess, /resource "aws_iam_openid_connect_provider" "github"/);
  assert.match(bootstrapAccess, /url\s*=\s*"https:\/\/token\.actions\.githubusercontent\.com"/);
  assert.match(bootstrapAccess, /client_id_list = \["sts\.amazonaws\.com"\]/);
  assert.match(bootstrapAccess, /output "github_oidc_provider_arn"/);
  assert.doesNotMatch(bootstrapAccess, /aws_iam_role\.dev_deploy/);
  assert.match(bootstrapVariables, /variable "github_oidc_provider_arn"/);
  assert.doesNotMatch(bootstrapVariables, /variable "dev_instance_name"/);
});

test('the release builder takes an explicit branch gate', () => {
  assert.match(release, /create\.add_argument\("--branch", default="main"/);
  assert.match(release, /refs\/remotes\/origin\/\{branch\}/);
  assert.match(release, /release commit must equal origin\/\{branch\}/);
  assert.match(release, /no successful \{branch\}-branch Quality checks run for this commit/);
  assert.doesNotMatch(release, /web-canonical-origin/);
});
