import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const costSafetyTerraform = await readFile(
  new URL('../../infra/terraform/demo/cost-safety-audit.tf', import.meta.url),
  'utf8',
);
const demoVariables = await readFile(
  new URL('../../infra/terraform/demo/variables.tf', import.meta.url),
  'utf8',
);

function extractBlock(source, header) {
  const headerStart = source.indexOf(header);
  assert.notEqual(headerStart, -1, `missing Terraform block: ${header}`);
  const openBrace = source.indexOf('{', headerStart);
  let depth = 0;
  let inString = false;
  let escaped = false;
  let inComment = false;

  for (let index = openBrace; index < source.length; index += 1) {
    const character = source[index];
    const next = source[index + 1];

    if (inComment) {
      if (character === '\n') inComment = false;
      continue;
    }
    if (!inString && character === '#') {
      inComment = true;
      continue;
    }
    if (!inString && character === '/' && next === '/') {
      inComment = true;
      continue;
    }
    if (character === '"' && !escaped) inString = !inString;
    escaped = character === '\\' && !escaped;
    if (inString) continue;
    if (character === '{') depth += 1;
    if (character === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(openBrace, index + 1);
    }
  }

  assert.fail(`unterminated Terraform block: ${header}`);
}

function actionsIn(policyBlock) {
  return [...policyBlock.matchAll(/\bactions\s*=\s*\[([\s\S]*?)\]/g)].flatMap((match) =>
    [...match[1].matchAll(/"([^"]+)"/g)].map((item) => item[1]),
  );
}

function statementWithSid(policyBlock, sid) {
  const statements = [];
  let searchFrom = 0;
  while (true) {
    const statementStart = policyBlock.indexOf('statement {', searchFrom);
    if (statementStart === -1) break;
    statements.push(extractBlock(policyBlock.slice(statementStart), 'statement'));
    searchFrom = statementStart + 'statement {'.length;
  }
  const statement = statements.find((candidate) =>
    new RegExp(`sid\\s*=\\s*"${sid}"`).test(candidate),
  );
  assert.ok(statement, `missing IAM statement ${sid}`);
  return statement;
}

const lambdaPolicy = extractBlock(
  costSafetyTerraform,
  'data "aws_iam_policy_document" "cost_safety_audit"',
);
const lambdaTrust = extractBlock(
  costSafetyTerraform,
  'data "aws_iam_policy_document" "cost_safety_audit_assume_role"',
);
const schedulerTrust = extractBlock(
  costSafetyTerraform,
  'data "aws_iam_policy_document" "cost_safety_audit_scheduler_assume_role"',
);
const schedulerPolicy = extractBlock(
  costSafetyTerraform,
  'data "aws_iam_policy_document" "cost_safety_audit_scheduler"',
);

test('audit Lambda policy is an explicit read, log, and optional publish allowlist', () => {
  const expectedActions = [
    'logs:CreateLogStream',
    'logs:PutLogEvents',
    'lightsail:GetInstance',
    'lightsail:GetInstanceSnapshots',
    'lightsail:GetStaticIp',
    'lightsail:GetDistributions',
    's3:GetLifecycleConfiguration',
    'sns:Publish',
  ];
  assert.deepEqual(actionsIn(lambdaPolicy).sort(), expectedActions.sort());
  assert.match(
    statementWithSid(lambdaPolicy, 'WriteAuditLogs'),
    /resources\s*=\s*\["\$\{aws_cloudwatch_log_group\.cost_safety_audit\.arn\}:\*"\]/,
  );
  assert.match(
    statementWithSid(lambdaPolicy, 'ReadOnlyBackupRetention'),
    /resources\s*=\s*\[aws_s3_bucket\.backups\.arn\]/,
  );
  assert.match(
    statementWithSid(lambdaPolicy, 'ReadRegionalLightsailInventory'),
    /resources\s*=\s*\["\*"\]/,
  );
  assert.match(
    statementWithSid(lambdaPolicy, 'ReadGlobalDistributionInventory'),
    /resources\s*=\s*\["\*"\]/,
  );
  assert.match(
    lambdaPolicy,
    /for_each\s*=\s*var\.cost_safety_audit_notification_mode == "sns" && var\.cost_safety_audit_notification_topic_arn != null/,
  );
  assert.match(lambdaPolicy, /resources\s*=\s*\[statement\.value\]/);
});

test('audit Lambda policy cannot mutate compute, bucket objects, IAM, or account state', () => {
  const forbiddenMutation =
    /(?:lightsail|ec2|ecs|rds|s3|iam|lambda|organizations|account|budgets):(?:\*|Start|Stop|Run|Terminate|Delete|Put|Post|Create|Update|Modify|Attach|Detach|Release|PassRole)/i;
  assert.doesNotMatch(lambdaPolicy, forbiddenMutation);
  assert.doesNotMatch(lambdaPolicy, /s3:(?:GetObject|ListAllMyBuckets)/i);
  assert.doesNotMatch(lambdaPolicy, /iam:/i);
});

test('audit Lambda has an independent Lambda-only trust policy', () => {
  assert.match(lambdaTrust, /identifiers\s*=\s*\["lambda\.amazonaws\.com"\]/);
  assert.match(lambdaTrust, /actions\s*=\s*\["sts:AssumeRole"\]/);
  assert.match(
    costSafetyTerraform,
    /assume_role_policy\s*=\s*data\.aws_iam_policy_document\.cost_safety_audit_assume_role\.json/,
  );
});

test('scheduler can invoke only the audit Lambda', () => {
  assert.deepEqual(actionsIn(schedulerPolicy), ['lambda:InvokeFunction']);
  assert.match(schedulerPolicy, /resources\s*=\s*\[aws_lambda_function\.cost_safety_audit\.arn\]/);
  assert.doesNotMatch(schedulerPolicy, /\*/);
});

test('scheduler trust is scoped to this account and this exact schedule', () => {
  assert.match(schedulerTrust, /test\s*=\s*"StringEquals"/);
  assert.match(schedulerTrust, /variable\s*=\s*"aws:SourceAccount"/);
  assert.match(schedulerTrust, /values\s*=\s*\[var\.account_id\]/);
  assert.match(schedulerTrust, /test\s*=\s*"ArnEquals"/);
  assert.match(schedulerTrust, /variable\s*=\s*"aws:SourceArn"/);
  assert.match(
    schedulerTrust,
    /arn:aws:scheduler:\$\{var\.aws_region\}:\$\{var\.account_id\}:schedule\/\$\{aws_scheduler_schedule_group\.rewind\.name\}\/rewind-demo-cost-safety-audit/,
  );
  assert.doesNotMatch(schedulerTrust, /\*/);
});

test('audit expected power state is explicit and distinct from instance existence', () => {
  assert.match(demoVariables, /variable "cost_safety_expected_instance_state"/);
  assert.match(
    demoVariables,
    /contains\(\["stopped", "running"\], var\.cost_safety_expected_instance_state\)/,
  );
  assert.match(costSafetyTerraform, /EXPECTED_STATE\s+=\s+local\.cost_safety_expected_state/);
  assert.match(costSafetyTerraform, /"approved_active_demo"/);
  assert.match(costSafetyTerraform, /"expected_stopped"/);
});

test('disabled audit notifications tolerate a null topic ARN during planning', () => {
  assert.match(
    costSafetyTerraform,
    /AUDIT_NOTIFICATION_TOPIC_ARN\s*=\s*var\.cost_safety_audit_notification_topic_arn != null \? var\.cost_safety_audit_notification_topic_arn : ""/,
  );
  assert.doesNotMatch(
    costSafetyTerraform,
    /coalesce\(var\.cost_safety_audit_notification_topic_arn/,
  );
});
