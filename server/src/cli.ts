import { once } from 'node:events';
import { ConfigError, parseConfig, SERVICE_VERSION, type RuntimeConfig } from './config';
import { openDatabase, resetDatabase, fixtureSummary } from './db';
import { runFfmpegProbe } from './ffmpeg';
import { createRuntimeServer, getLanAddress } from './http';

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
    database = openDatabase({ ...config, port: 0 });
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
    database = openDatabase(config);
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

async function start(config: RuntimeConfig): Promise<void> {
  const database = openDatabase(config);
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
      const database = openDatabase(config);
      console.log(`SQLite migrated and seeded at ${config.databasePath}.`);
      database.close();
      return;
    }
    if (command === 'reset') {
      resetDatabase(config);
      const database = openDatabase(config);
      console.log(
        `Local database reset to the deterministic five-member fixture at ${config.databasePath}.`,
      );
      database.close();
      return;
    }
    if (command !== 'start') {
      throw new ConfigError(
        `Unknown local runtime command ${JSON.stringify(command)}.`,
        'Use start, preflight, migrate, or reset.',
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
