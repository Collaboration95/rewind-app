import { DatabaseSync } from 'node:sqlite';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';

// Intentionally vulnerable, synthetic scanner-evaluation target. Never used by app runtime.
export async function createScanFixture({ vulnerable = true } = {}) {
  const database = new DatabaseSync(':memory:');
  database.exec(`CREATE TABLE messages (id INTEGER PRIMARY KEY, owner TEXT, body TEXT);
    INSERT INTO messages VALUES (1, 'demo', 'Disposable agentic trial message'),
    (2, 'other', 'SYNTHETIC_PRIVATE_CANARY');`);
  const token = randomUUID();
  const path = '/fixture/chat';
  // Synthetic-only probe evidence: never record the bearer token or headers.
  const evidence = [];
  const server = createServer(async (request, response) => {
    const probe = { method: request.method, authenticated: false };
    if (evidence.length < 120) evidence.push(probe);
    response.on('finish', () => {
      probe.status = response.statusCode;
    });
    response.setHeader('Content-Type', 'application/json');
    if (request.url !== path || !['GET', 'POST'].includes(request.method)) {
      response.writeHead(404).end('{}');
      return;
    }
    if (request.headers.authorization !== `Bearer ${token}`) {
      response.writeHead(401).end('{}');
      return;
    }
    probe.authenticated = true;
    try {
      let raw = '';
      for await (const chunk of request) {
        raw += chunk.toString();
        if (raw.length > 65536) {
          response.writeHead(413).end('{}');
          return;
        }
      }
      const body =
        request.method === 'POST' ? JSON.parse(raw).body : 'Disposable agentic trial message';
      if (typeof body !== 'string') {
        response.writeHead(400).end('{}');
        return;
      }
      if (request.method === 'POST') probe.body = body.slice(0, 4096);
      // The interpolation below is the deliberate defect. The control binds the same input.
      const rows = vulnerable
        ? database
            .prepare(`SELECT id, body FROM messages WHERE owner = 'demo' AND body = '${body}'`)
            .all()
        : database
            .prepare("SELECT id, body FROM messages WHERE owner = 'demo' AND body = ?")
            .all(body);
      probe.canaryExposed = rows.some((row) => row.body === 'SYNTHETIC_PRIVATE_CANARY');
      response
        .writeHead(request.method === 'POST' ? 201 : 200)
        .end(JSON.stringify({ messages: rows }));
    } catch (error) {
      probe.sqlError = error.code === 'ERR_SQLITE_ERROR';
      response
        .writeHead(400)
        .end(JSON.stringify({ error: vulnerable ? error.message : 'Invalid request' }));
    }
  });
  server.requestTimeout = 5000;
  server.headersTimeout = 5000;
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return {
    server,
    database,
    token,
    path,
    evidence,
    origin: `http://127.0.0.1:${server.address().port}`,
    close: async () => {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      database.close();
    },
  };
}

// Replay observed scanner values against fresh vulnerable and parameterized twins.
// This is independent verification, never an AI prompt or a pre-seeded exploit.
export async function verifyFixturePayloads(values) {
  const baseline = 'Disposable agentic trial message';
  const payloads = [...new Set(values)]
    .filter((value) => typeof value === 'string' && value !== baseline && value.length <= 4096)
    .slice(0, 8);
  const vulnerable = await createScanFixture();
  const control = await createScanFixture({ vulnerable: false });
  const query = async (target, body) => {
    const response = await fetch(`${target.origin}${target.path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${target.token}` },
      body: JSON.stringify({ body }),
    });
    const data = await response.json();
    return {
      status: response.status,
      messageIds: data.messages?.map((message) => message.id) || [],
    };
  };
  try {
    const baselines = {
      vulnerable: await query(vulnerable, baseline),
      control: await query(control, baseline),
    };
    if (
      baselines.vulnerable.status !== 201 ||
      baselines.control.status !== 201 ||
      baselines.vulnerable.messageIds.length !== 1 ||
      baselines.control.messageIds.length !== 1
    )
      throw new Error('Independent fixture baselines failed');
    const checks = [];
    for (const body of payloads) {
      const affected = await query(vulnerable, body);
      const safe = await query(control, body);
      checks.push({
        body,
        vulnerable: affected,
        parameterizedControl: safe,
        confirmed:
          affected.status === 201 &&
          safe.status === 201 &&
          affected.messageIds.length > 0 &&
          safe.messageIds.length === 0,
      });
    }
    return { confirmed: checks.some((check) => check.confirmed), baselines, checks };
  } finally {
    await vulnerable.close();
    await control.close();
  }
}
