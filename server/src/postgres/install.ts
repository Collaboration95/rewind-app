// Database-only install of a validated export (export.ts). Unlike
// deploy/restore.sh it never touches media: the SQLite file is replaced in one
// atomic rename, the previous file is kept under a new name, and a failed
// check puts the previous file back.
import { randomBytes } from 'node:crypto';
import {
  existsSync,
  linkSync,
  lstatSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
} from 'node:fs';
import { dirname, resolve } from 'node:path';

import {
  EXPORT_REPORT_SUFFIX,
  ExportError,
  fileSha256,
  syncDirectory,
  verifySqliteFile,
  type ExportOptions,
  type ExportReport,
} from './export';

export interface InstallOptions {
  /** The environment this runtime serves; it must match the export's. */
  expectedEnvironment?: string;
  checkReady: ExportOptions['checkReady'];
  /** Re-reads PostgreSQL and throws if it no longer matches the export. */
  checkSource?: (report: ExportReport) => void;
  /** Test hook: runs after the swap, as the post-install check. */
  afterSwap?: (livePath: string) => void;
  now?: () => Date;
}

export interface InstallResult {
  livePath: string;
  /** The file that was live before, or null when there was none. */
  previousPath: string | null;
  report: ExportReport;
}

function stamp(date: Date): string {
  return date
    .toISOString()
    .replaceAll(/[-:]/g, '')
    .replace(/\.\d+Z$/, 'Z');
}

function lstatOrNull(path: string) {
  try {
    return lstatSync(path);
  } catch {
    return null;
  }
}

export function readExportReport(stagedPath: string): ExportReport {
  const reportPath = `${stagedPath}${EXPORT_REPORT_SUFFIX}`;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(reportPath, 'utf8'));
  } catch {
    throw new ExportError(
      `${reportPath} is missing or unreadable. Only a file written by database-export can be installed.`,
    );
  }
  const report = parsed as Partial<ExportReport>;
  if (
    report.format !== 1 ||
    typeof report.environment !== 'string' ||
    typeof report.sqliteSha256 !== 'string' ||
    !Array.isArray(report.tables)
  ) {
    throw new ExportError(`${reportPath} is not a database-export report.`);
  }
  return report as ExportReport;
}

function verifyAgainstReport(path: string, report: ExportReport, options: InstallOptions): void {
  if (fileSha256(path) !== report.sqliteSha256) {
    throw new ExportError('The SQLite file changed after it was exported.');
  }
  verifySqliteFile(path, report.tables, options.checkReady);
}

/**
 * Put the exported file at `livePath`. The runtime that used `livePath` must
 * be stopped. `livePath` is either the previous file or the verified export;
 * never missing and never half-written.
 */
export function installExportedDatabase(
  stagedPath: string,
  livePath: string,
  options: InstallOptions,
): InstallResult {
  const staged = resolve(stagedPath);
  const live = resolve(livePath);
  if (staged === live) throw new ExportError('The export and the live database are the same path.');
  const stagedStat = lstatOrNull(staged);
  if (!stagedStat?.isFile()) throw new ExportError(`${staged} is not a regular file.`);
  const liveStat = lstatOrNull(live);
  if (liveStat && !liveStat.isFile()) {
    throw new ExportError(`${live} is not a regular file; refusing to replace it.`);
  }
  if (statSync(dirname(live)).dev !== stagedStat.dev) {
    throw new ExportError(
      'The export must be on the same filesystem as the live database so the swap is one rename.',
    );
  }

  const report = readExportReport(staged);
  if (options.expectedEnvironment && report.environment !== options.expectedEnvironment) {
    throw new ExportError(
      `The export was taken from the "${report.environment}" environment, ` +
        `not "${options.expectedEnvironment}".`,
    );
  }
  verifyAgainstReport(staged, report, options);
  options.checkSource?.(report);

  const suffix = `${stamp((options.now ?? (() => new Date()))())}-${randomBytes(2).toString('hex')}`;
  const previous = `${live}.pre-export-${suffix}`;
  if (existsSync(previous)) {
    throw new ExportError(`${previous} already exists; try again.`);
  }

  const sidecars = ['-wal', '-shm'].filter((tail) => existsSync(`${live}${tail}`));
  let keptPrevious = false;
  let movedSidecars = false;
  let swapped = false;
  try {
    if (liveStat) {
      // A hard link keeps the old inode under a second name, so `live` is
      // never absent: the rename below replaces it in one step.
      linkSync(live, previous);
      keptPrevious = true;
      // A WAL belongs to the file it was written for; it must not be
      // replayed onto the new one.
      for (const tail of sidecars) renameSync(`${live}${tail}`, `${previous}${tail}`);
      movedSidecars = true;
    }
    renameSync(staged, live);
    swapped = true;
    syncDirectory(dirname(live));
    verifyAgainstReport(live, report, options);
    options.afterSwap?.(live);
  } catch (error) {
    if (swapped) {
      // Hand the export back under its own name (it stays installable once
      // the cause is fixed) and put the old file back.
      linkSync(live, staged);
      if (keptPrevious) renameSync(previous, live);
      else rmSync(live, { force: true });
    }
    if (movedSidecars) {
      for (const tail of sidecars) renameSync(`${previous}${tail}`, `${live}${tail}`);
    }
    if (keptPrevious && existsSync(previous)) rmSync(previous, { force: true });
    syncDirectory(dirname(live));
    throw error;
  }
  renameSync(`${staged}${EXPORT_REPORT_SUFFIX}`, `${live}.export-${suffix}.json`);
  return { livePath: live, previousPath: liveStat ? previous : null, report };
}
