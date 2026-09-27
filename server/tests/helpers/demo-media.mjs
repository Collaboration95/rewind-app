import { rmSync } from 'node:fs';

/** Start a media scenario with an empty clip set when it supplies its own
 * inputs. Remove both sample records and bytes so they cannot become orphans. */
export function clearDemoMedia(database) {
  const paths = database
    .prepare(
      "SELECT DISTINCT output_path AS path FROM media_jobs WHERE id IN ('demo-clip', 'demo-film', 'demo-download')",
    )
    .all();
  database.exec(`
    DELETE FROM media_jobs WHERE id IN ('demo-clip', 'demo-film', 'demo-download');
    DELETE FROM contributions WHERE id = 'demo-contribution';
    DELETE FROM contribution_quota_windows WHERE id = 'fixture-quota-demo-cycle-demo-1';
  `);
  for (const { path } of paths) {
    if (path) rmSync(path, { force: true });
  }
}
