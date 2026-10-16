import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

const mappings = {
  'cors-headers-detect': {
    sources: [
      ['server/src/config.ts', "allowOrigin: env.REWIND_ALLOW_ORIGIN?.trim() || '*'"],
      ['server/src/http.ts', "'Access-Control-Allow-Origin': config.allowOrigin,"],
      ['server/src/http.ts', 'function authCorsHeaders('],
    ],
    cause:
      'parseConfig defaults the public-response CORS origin to *. sendJson writes that value into the response header. Real-account authentication routes use a separate authCorsHeaders helper that excludes wildcard grants; the public advisory is not evidence of a defect in that helper.',
    suggestion:
      'If public cross-origin reads are unintended, use the existing REWIND_ALLOW_ORIGIN setting with the actual trusted web origin. A source change is not necessarily needed. If the synthetic Demo is intentionally public, record an accepted advisory instead.',
    example:
      '# Configuration example; replace with your actual trusted origin\nREWIND_ALLOW_ORIGIN=https://your-rewind-web.example',
    checks: [
      'With the configured origin, GET /health and /profiles should emit that exact origin, not *.',
      'Confirm supported web clients still load and real-account login works from the trusted origin.',
      'Verify untrusted Origin requests do not receive a real-account CORS grant, and keep owner/outsider authorization tests passing.',
    ],
  },
  'api-version-detect': {
    sources: [
      ['server/src/config.ts', "export const SERVICE_VERSION = '"],
      ['server/src/http.ts', 'version: SERVICE_VERSION,'],
      ['server/src/http.ts', "url.pathname === '/health' || url.pathname === '/version'"],
    ],
    cause:
      'healthPayload includes SERVICE_VERSION in the JSON object used by both /health and /version. The scanner found that field in a public response. This is an informational observation, not a demonstrated exploit.',
    suggestion:
      'Keep the field if it is an intentional diagnostics contract. If the team chooses to remove it, review /version consumers first, remove the version member from HealthPayload and healthPayload, and remove the now-unused SERVICE_VERSION import. This changes the response contract and must be validated before application.',
    example:
      "// Illustrative removals in server/src/http.ts — not an applied patch\n// HealthPayload interface:\n-  version: string;\n// healthPayload return object:\n-    version: SERVICE_VERSION,\n// If SERVICE_VERSION is no longer used, retain the type import only:\nimport type { RuntimeConfig } from './config';",
    checks: [
      'Check /health and /version clients, diagnostics and tests for reliance on version before removal.',
      'Run type checking, server tests and health/readiness smoke checks after any change.',
      'Rescan and confirm the version field is absent, or explicitly accept the informational finding if retained.',
    ],
  },
};

export async function sourceDetails(moduleId, sourceRoot) {
  const mapping = mappings[moduleId];
  if (!mapping) return null;
  const snippets = [];
  for (const [file, marker] of mapping.sources) {
    let source;
    try {
      source = await readFile(join(sourceRoot, file), 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') continue;
      throw error;
    }
    const lines = source.split(/\r?\n/);
    const index = lines.findIndex((line) => line.includes(marker));
    if (index < 0) continue;
    const first = Math.max(0, index - 2);
    const last = Math.min(lines.length, index + 9);
    snippets.push({
      file,
      line: index + 1,
      code: lines
        .slice(first, last)
        .map((line, offset) => `${first + offset + 1}  ${line}`)
        .join('\n'),
    });
  }
  return { ...mapping, snippets, complete: snippets.length === mapping.sources.length };
}
