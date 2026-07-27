#!/usr/bin/env node
import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  importXjToRr,
  planXjImport,
  verifyXjImport,
  type XjAudit,
  type XjImportResult,
  type XjVerificationReport,
} from './xj-migration.js';

export type XjMigrationMode = 'dry-run' | 'import' | 'verify';

export interface XjMigrationCliOptions {
  mode: XjMigrationMode;
  sourceRoot: string;
  rrRoot: string;
  reportPath: string;
}

export interface XjMigrationCliReport {
  schemaVersion: 1;
  mode: XjMigrationMode;
  success: boolean;
  sourceRoot: string;
  rrRoot: string;
  audit: XjAudit;
  importResult?: XjImportResult;
  verification?: XjVerificationReport;
}

function writeReport(path: string, report: XjMigrationCliReport): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(report, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  renameSync(temporary, path);
}

export function runXjMigrationCli(options: XjMigrationCliOptions): XjMigrationCliReport {
  const plan = planXjImport(options.sourceRoot, options.rrRoot);
  let importResult: XjImportResult | undefined;
  let verification: XjVerificationReport | undefined;
  if (options.mode === 'import') {
    importResult = importXjToRr(plan);
    verification = verifyXjImport(options.sourceRoot, options.rrRoot);
  } else if (options.mode === 'verify') {
    verification = verifyXjImport(options.sourceRoot, options.rrRoot);
  }
  const success = verification ? verification.ok : true;
  const report: XjMigrationCliReport = {
    schemaVersion: 1,
    mode: options.mode,
    success,
    sourceRoot: options.sourceRoot,
    rrRoot: options.rrRoot,
    audit: plan.audit,
    ...(importResult ? { importResult } : {}),
    ...(verification ? { verification } : {}),
  };
  writeReport(options.reportPath, report);
  if (!success) throw Object.assign(new Error(`migration_${options.mode}_failed`), { report });
  return report;
}

function valueAfter(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

function parseArgs(args: string[]): XjMigrationCliOptions {
  const modes = args.filter((arg) => ['--dry-run', '--import', '--verify'].includes(arg));
  if (modes.length !== 1) throw new Error('choose exactly one of --dry-run, --import, --verify');
  const mode: XjMigrationMode = modes[0] === '--dry-run' ? 'dry-run' : modes[0] === '--import' ? 'import' : 'verify';
  return {
    mode,
    sourceRoot: valueAfter(args, '--source') ?? join(homedir(), '.xj-cursor', 'chat'),
    rrRoot: valueAfter(args, '--rr-root') ?? join(homedir(), '.rr-cursor', 'chat'),
    reportPath: valueAfter(args, '--report') ?? join(process.cwd(), `xj-migration-${mode}.json`),
  };
}

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(entry).href) {
  try {
    const report = runXjMigrationCli(parseArgs(process.argv.slice(2)));
    process.stdout.write(`${JSON.stringify({
      mode: report.mode,
      success: report.success,
      counts: report.audit.counts,
      idCounts: Object.fromEntries(Object.entries(report.audit.idSets).map(([key, values]) => [key, values.length])),
      importResult: report.importResult,
      verification: report.verification,
    })}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

