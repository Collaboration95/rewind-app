import { once } from 'node:events';
import { listAuditEvents, type AuditEvent } from './audit';
import { ConfigError, parseConfig, SERVICE_VERSION, type RuntimeConfig } from './config';
import { backfillMediaIntegrity, openDatabase, resetDatabase, fixtureSummary } from './db';
import { runFfmpegProbe } from './ffmpeg';
import { createRuntimeServer, getLanAddress } from './http';
import { cleanupOrphanedStagedSources } from './jobs';
import {
  listQueueJobs,
  parseQueueKind,
  parseQueueLimit,
  parseQueueStatus,
  QueueQueryError,
} from './jobs/queue';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  applyConsistencyRepair,
  CONSISTENCY_DEFAULT_LIMIT,
  CONSISTENCY_MAX_LIMIT,
  planConsistencyRepair,
} from './jobs/consistency';
import {
  applyProcessedMediaRetention,
  planProcessedMediaRetention,
  PROCESSED_RETENTION_DEFAULT_LIMIT,
  PROCESSED_RETENTION_MAX_LIMIT,
} from './jobs/retention';

async function openRuntimeDatabase(
  config: RuntimeConfig,
): Promise<ReturnType<typeof openDatabase>> {
  const database = openDatabase(config, { seedNow: new Date() });
  try {
    await backfillMediaIntegrity(database, config.dataDir);
    return database;
  } catch (error) {
    database.close();
    throw error;
  }
}

export interface PreflightReport {
  ok: boolean;
  version: string;
  service: { ok: boolean; message: string };
  sqlite: { ok: boolean; message: string; rows?: Record<string, number> };
  lan: { ok: boolean; message: string; address: string | null };
  ffmpeg: Awaited<ReturnType<typeof runFfmpegProbe>>;
}

async function serviceProbe(config: RuntimeConfig): Promise<PreflightReport['service']> {
  let database: ReturnType<typeof openDatabase> | null = null;
  let server: ReturnType<typeof createRuntimeServer> | null = null;
  try {
    database = await openRuntimeDatabase({ ...config, port: 0 });
    server = createRuntimeServer({ ...config, port: 0 }, database);
    server.listen(0, config.host);
    await once(server, 'listening');
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    const host = config.host === '0.0.0.0' || config.host === '::' ? '127.0.0.1' : config.host;
    const response = await fetch(`http://${host}:${port}/health`);
    if (!response.ok)
      return { ok: false, message: `Health endpoint returned HTTP ${response.status}.` };
    const body = (await response.json()) as { ok?: boolean; version?: string };
    return body.ok
      ? {
          ok: true,
          message: `Health endpoint responded with version ${body.version ?? SERVICE_VERSION}.`,
        }
      : { ok: false, message: 'Health endpoint did not report ready.' };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      message: `Could not bind or probe the local service: ${detail}. Check REWIND_HOST and firewall settings.`,
    };
  } finally {
    if (server?.listening) server.close();
    database?.close();
  }
}

export async function runPreflight(
  config: RuntimeConfig = parseConfig(),
): Promise<PreflightReport> {
  let sqlite: PreflightReport['sqlite'];
  let database: ReturnType<typeof openDatabase> | null = null;
  try {
    database = await openRuntimeDatabase(config);
    const rows = fixtureSummary(database);
    sqlite = {
      ok: rows.profiles === 5 && rows.groups === 1 && rows.memberships === 5,
      message: 'SQLite migrated and loaded the deterministic five-member fixture.',
      rows,
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    sqlite = {
      ok: false,
      message: `SQLite preflight failed: ${detail}. Use Node.js 22 LTS or newer and check the local-data path.`,
    };
  } finally {
    database?.close();
  }

  const service = await serviceProbe(config);
  const lanAddress = getLanAddress();
  const lan: PreflightReport['lan'] = {
    ok: Boolean(lanAddress),
    message: lanAddress
      ? `LAN URL can be advertised as http://${lanAddress}:${config.port}.`
      : 'No non-loopback IPv4 interface was detected; use localhost or check network access.',
    address: lanAddress,
  };
  const ffmpeg = await runFfmpegProbe(config.ffmpegBin);
  return {
    ok:
      service.ok &&
      sqlite.ok &&
      lan.ok &&
      ffmpeg.transformSucceeded &&
      ffmpeg.deliberateFailureDetected,
    version: SERVICE_VERSION,
    service,
    sqlite,
    lan,
    ffmpeg,
  };
}

function printPreflight(report: PreflightReport, json: boolean): void {
  if (json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  const mark = (ok: boolean) => (ok ? '✓' : '✗');
  console.log(`Rewind local runtime preflight (${report.version})`);
  console.log(`${mark(report.service.ok)} Service — ${report.service.message}`);
  console.log(`${mark(report.sqlite.ok)} SQLite — ${report.sqlite.message}`);
  console.log(`${mark(report.lan.ok)} LAN — ${report.lan.message}`);
  console.log(
    `${mark(report.ffmpeg.transformSucceeded && report.ffmpeg.deliberateFailureDetected)} FFmpeg — ${report.ffmpeg.message}`,
  );
  console.log(
    report.ok
      ? 'READY: local runtime gate passed.'
      : 'BLOCKED: fix the failed check(s) above, then retry.',
  );
}

function parseDiagnosticsLimit(argv: string[]): number {
  const index = argv.indexOf('--limit');
  if (index === -1) return 100;
  const value = argv[index + 1];
  const limit = Number(value);
  if (!value || !Number.isInteger(limit) || limit < 1 || limit > 500) {
    throw new ConfigError(
      `--limit must be an integer from 1 to 500 (received ${JSON.stringify(value)}).`,
      'Use --limit 100 or omit it to show the latest 100 events.',
    );
  }
  return limit;
}

function parseRetentionLimit(argv: string[]): number {
  const index = argv.indexOf('--limit');
  if (index === -1) return PROCESSED_RETENTION_DEFAULT_LIMIT;
  const value = argv[index + 1];
  const limit = Number(value);
  if (!value || !Number.isInteger(limit) || limit < 1 || limit > PROCESSED_RETENTION_MAX_LIMIT) {
    throw new ConfigError(
      `--limit must be an integer from 1 to ${PROCESSED_RETENTION_MAX_LIMIT}.`,
      'Use retention --limit 100; deletion requires the explicit --apply flag.',
    );
  }
  return limit;
}

function parseConsistencyLimit(argv: string[]): number {
  const value = readOption(argv, ['--limit']);
  const limit = value === undefined ? CONSISTENCY_DEFAULT_LIMIT : Number(value);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > CONSISTENCY_MAX_LIMIT) {
    throw new ConfigError(
      `--limit must be an integer from 1 to ${CONSISTENCY_MAX_LIMIT}.`,
      'Use consistency --limit 100; changes require --repair.',
    );
  }
  return limit;
}

function printConsistency(
  report: ReturnType<typeof planConsistencyRepair>,
  json: boolean,
  applied?: { repaired: string[]; skipped: string[] },
): void {
  const result = {
    mode: applied ? 'repair' : 'report',
    limit: report.limit,
    findings: report.findings.map(({ kind, id, name, repairable, reason }) => ({
      kind,
      id,
      ...(name ? { name } : {}),
      repairable,
      ...(reason ? { reason } : {}),
    })),
    ...(applied ? { repaired: applied.repaired, skippedOnRevalidation: applied.skipped } : {}),
  };
  if (json) {
    console.log(JSON.stringify({ version: SERVICE_VERSION, ...result }, null, 2));
    return;
  }
  console.log(`Rewind consistency ${result.mode} (${result.findings.length} finding(s))`);
  for (const finding of result.findings)
    console.log(
      `${finding.kind} id=${finding.id}${finding.name ? ` name=${finding.name}` : ''}${finding.repairable ? ' repairable' : ''}${finding.reason ? ` reason=${finding.reason}` : ''}`,
    );
  if (applied)
    console.log(`Repaired ${applied.repaired.length}; skipped ${applied.skipped.length}.`);
}

function printRetention(
  report: {
    cutoff: string;
    limit: number;
    candidates: { reportName: string }[];
    skippedUnsafe: string[];
  },
  json: boolean,
  applied?: { deleted: string[]; skipped: string[] },
): void {
  const result = {
    mode: applied ? 'apply' : 'dry-run',
    cutoff: report.cutoff,
    limit: report.limit,
    candidates: report.candidates.map((candidate) => candidate.reportName),
    skippedUnsafe: report.skippedUnsafe,
    ...(applied ? { deleted: applied.deleted, skippedOnRevalidation: applied.skipped } : {}),
  };
  if (json) {
    console.log(JSON.stringify({ version: SERVICE_VERSION, ...result }, null, 2));
    return;
  }
  console.log(`Processed media retention (${result.mode}; stale before ${report.cutoff})`);
  for (const name of result.candidates) console.log(`${applied ? 'deleted' : 'candidate'} ${name}`);
  for (const name of result.skippedUnsafe) console.log(`skipped unsafe ${name}`);
  if (applied) {
    for (const name of applied.skipped) console.log(`skipped on revalidation ${name}`);
    console.log(`Deleted ${applied.deleted.length}; skipped ${applied.skipped.length}.`);
  } else {
    console.log(
      `${report.candidates.length} candidate(s). Use --apply to delete after revalidation.`,
    );
  }
}

function printDiagnostics(events: AuditEvent[], json: boolean): void {
  if (json) {
    console.log(JSON.stringify({ version: SERVICE_VERSION, events }, null, 2));
    return;
  }
  console.log(`Rewind local diagnostics (${events.length} event${events.length === 1 ? '' : 's'})`);
  if (events.length === 0) {
    console.log('No session or job events recorded.');
    return;
  }
  for (const event of events) {
    const actor = event.actorMemberId ? ` actor=${event.actorMemberId}` : '';
    const resource = event.resourceId ? ` resource=${event.resourceId}` : '';
    console.log(
      `${event.timestamp} ${event.result.toUpperCase()} ${event.eventType}${actor}${resource}`,
    );
  }
}

function readOption(argv: string[], names: string[]): string | undefined {
  for (const name of names) {
    const inline = argv.find((argument) => argument.startsWith(`${name}=`));
    if (inline) return inline.slice(name.length + 1);
    const index = argv.indexOf(name);
    if (index !== -1) {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) {
        throw new ConfigError(`Missing value for ${name}.`, `Use ${name} with a value.`);
      }
      return value;
    }
  }
  return undefined;
}

function parseJobsOptions(argv: string[]) {
  const groupId = readOption(argv, ['--group', '--group-id', '--groupId']);
  if (!groupId) {
    throw new ConfigError(
      'The jobs command requires a group.',
      'Use jobs --group demo-group [--kind clip|film] [--status pending|processing|failed].',
    );
  }
  try {
    return {
      groupId,
      kind: parseQueueKind(readOption(argv, ['--kind'])),
      status: parseQueueStatus(readOption(argv, ['--status'])),
      limit: parseQueueLimit(readOption(argv, ['--limit'])),
      cursor: readOption(argv, ['--cursor']) ?? null,
    };
  } catch (error) {
    if (!(error instanceof QueueQueryError)) throw error;
    throw new ConfigError(error.message, 'Use bounded jobs filters and pagination values.');
  }
}

function printJobs(page: ReturnType<typeof listQueueJobs>, json: boolean): void {
  if (json) {
    console.log(JSON.stringify({ version: SERVICE_VERSION, ...page }, null, 2));
    return;
  }
  console.log(`Rewind queue (${page.jobs.length} job${page.jobs.length === 1 ? '' : 's'})`);
  for (const job of page.jobs) {
    console.log(
      `${job.createdAt} ${job.kind} ${job.status} id=${job.id} attempts=${job.attempts} progress=${job.progress}% retryable=${job.retryable}`,
    );
  }
  if (page.pagination.hasMore)
    console.log('More jobs are available; pass --cursor from JSON output.');
}

async function start(config: RuntimeConfig): Promise<void> {
  const database = await openRuntimeDatabase(config);
  await cleanupOrphanedStagedSources(database, resolve(config.dataDir, 'media', 'staging'));
  const server = createRuntimeServer(config, database);
  const close = () => {
    server.close(() => database.close());
  };
  process.once('SIGINT', close);
  process.once('SIGTERM', close);
  server.on('error', (error) => {
    console.error(
      `Could not start the local runtime on ${config.host}:${config.port}: ${error.message}. ` +
        'Try another REWIND_PORT or stop the process using that port.',
    );
    database.close();
    process.exitCode = 1;
  });
  server.listen(config.port, config.host, () => {
    const address = server.address();
    const actualPort = typeof address === 'object' && address ? address.port : config.port;
    config.port = actualPort;
    const host = config.host === '0.0.0.0' || config.host === '::' ? '127.0.0.1' : config.host;
    const lan = getLanAddress();
    console.log(
      `Rewind local runtime ${SERVICE_VERSION} listening on http://${host}:${actualPort}`,
    );
    if (lan) console.log(`LAN address: http://${lan}:${actualPort}`);
    console.log(`SQLite data: ${config.databasePath}`);
    console.log('Press Ctrl-C to stop.');
  });
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const command = argv[0] ?? 'start';
  const json = argv.includes('--json');
  try {
    const config = parseConfig();
    if (command === 'preflight') {
      const report = await runPreflight(config);
      printPreflight(report, json);
      if (!report.ok) process.exitCode = 1;
      return;
    }
    if (command === 'migrate') {
      const database = await openRuntimeDatabase(config);
      console.log(`SQLite migrated and seeded at ${config.databasePath}.`);
      database.close();
      return;
    }
    if (command === 'reset') {
      resetDatabase(config);
      const database = await openRuntimeDatabase(config);
      console.log(
        `Local database reset to the deterministic five-member fixture at ${config.databasePath}.`,
      );
      database.close();
      return;
    }
    if (command === 'diagnostics') {
      const database = await openRuntimeDatabase(config);
      try {
        printDiagnostics(listAuditEvents(database, parseDiagnosticsLimit(argv)), json);
      } finally {
        database.close();
      }
      return;
    }
    if (command === 'retention') {
      const limit = parseRetentionLimit(argv);
      const apply = argv.includes('--apply');
      // Retention must not run migrations, seed fixtures, or the startup
      // integrity backfill. The apply path needs only a direct SQLite handle
      // so reference revalidation and deletion share its writer transaction.
      const database = new DatabaseSync(
        config.databasePath,
        apply ? undefined : { readOnly: true },
      );
      try {
        const report = planProcessedMediaRetention(
          database,
          resolve(config.dataDir, 'media', 'processed'),
          { limit },
        );
        printRetention(
          report,
          json,
          apply
            ? applyProcessedMediaRetention(
                database,
                resolve(config.dataDir, 'media', 'processed'),
                report,
              )
            : undefined,
        );
      } finally {
        database.close();
      }
      return;
    }
    if (command === 'consistency') {
      const limit = parseConsistencyLimit(argv);
      const repair = argv.includes('--repair');
      const database = new DatabaseSync(
        config.databasePath,
        repair ? undefined : { readOnly: true },
      );
      try {
        const report = planConsistencyRepair(
          database,
          resolve(config.dataDir, 'media', 'processed'),
          resolve(config.dataDir, 'media', 'staging'),
          { limit },
        );
        printConsistency(
          report,
          json,
          repair
            ? applyConsistencyRepair(
                database,
                resolve(config.dataDir, 'media', 'processed'),
                report,
              )
            : undefined,
        );
      } finally {
        database.close();
      }
      return;
    }
    if (command === 'jobs' || command === 'queue') {
      const database = await openRuntimeDatabase(config);
      try {
        printJobs(listQueueJobs(database, parseJobsOptions(argv)), json);
      } finally {
        database.close();
      }
      return;
    }
    if (command !== 'start') {
      throw new ConfigError(
        `Unknown local runtime command ${JSON.stringify(command)}.`,
        'Use start, preflight, migrate, reset, diagnostics, jobs, retention, or consistency.',
      );
    }
    await start(config);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.error(`Local runtime configuration/startup error: ${detail}`);
    process.exitCode = 1;
  }
}

if (require.main === module) {
  void main();
}
