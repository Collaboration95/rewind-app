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
  const server = createServer(async (request, response) => {
    response.setHeader('Content-Type', 'application/json');
    if (request.url !== path || !['GET', 'POST'].includes(request.method)) {
      response.writeHead(404).end('{}');
      return;
    }
    if (request.headers.authorization !== `Bearer ${token}`) {
      response.writeHead(401).end('{}');
      return;
    }
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
      // The interpolation below is the deliberate defect. The control binds the same input.
      const rows = vulnerable
        ? database
            .prepare(`SELECT id, body FROM messages WHERE owner = 'demo' AND body = '${body}'`)
            .all()
        : database
            .prepare("SELECT id, body FROM messages WHERE owner = 'demo' AND body = ?")
            .all(body);
      response
        .writeHead(request.method === 'POST' ? 201 : 200)
        .end(JSON.stringify({ messages: rows }));
    } catch (error) {
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
    origin: `http://127.0.0.1:${server.address().port}`,
    close: async () => {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      database.close();
    },
  };
}
