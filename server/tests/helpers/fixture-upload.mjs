import { Buffer } from 'node:buffer';
import { request } from 'node:http';

// Only synthetic fixtures belong here. Pin transport to the live test server,
// bypass DNS/proxy configuration, and never replay file bytes on redirects.
export async function uploadFixture(server, destination, { authorization, mimeType, bytes }) {
  const address = server.address();
  if (!server.listening || !address || address.address !== '127.0.0.1' || !address.port) {
    throw new Error('Fixture uploads require a listening IPv4 loopback test server');
  }
  const url = new URL(destination);
  if (
    url.origin !== `http://127.0.0.1:${address.port}` ||
    url.username ||
    url.password ||
    url.hash
  ) {
    throw new Error('Fixture destination must match the owned loopback test server');
  }
  return new Promise((resolve, reject) => {
    const upload = request(
      {
        hostname: '127.0.0.1',
        port: address.port,
        path: `${url.pathname}${url.search}`,
        method: 'POST',
        headers: { Authorization: authorization, 'Content-Type': mimeType },
        agent: false,
      },
      (response) => {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('error', reject);
        response.on('end', () => {
          if (response.statusCode >= 300 && response.statusCode < 400) {
            reject(new Error('Fixture uploads must not follow redirects'));
            return;
          }
          resolve(new Response(Buffer.concat(chunks), { status: response.statusCode }));
        });
      },
    );
    upload.on('error', reject);
    upload.end(bytes);
  });
}
