import { createHash } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/** Hash the exact exported inline scripts, including their whitespace. */
export async function renderSecurityHeaders(artifactDir, templatePath, outputPath) {
  const hashes = new Set();
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.name.endsWith('.html')) {
        const html = await readFile(path, 'utf8');
        for (const [, attributes, body] of html.matchAll(
          /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi,
        )) {
          if (!/\bsrc\s*=/i.test(attributes) && body.trim())
            hashes.add(`'sha256-${createHash('sha256').update(body).digest('base64')}'`);
        }
      }
    }
  }
  await visit(artifactDir);
  const template = await readFile(templatePath, 'utf8');
  if (!template.includes('__SCRIPT_HASHES__')) throw new Error('Missing CSP script hash marker.');
  await writeFile(outputPath, template.replace('__SCRIPT_HASHES__', [...hashes].sort().join(' ')));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  await renderSecurityHeaders(...process.argv.slice(2));
