#!/usr/bin/env node
import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  applyXjCleanup,
  createXjCleanupGate,
  scanXjResidue,
  type XjCleanupGate,
  type XjCleanupResult,
  type XjResidueReport,
} from './xj-cleanup.js';

export interface XjCleanupCliOptions {
  mode: 'scan' | 'gate' | 'apply';
  home: string;
  cursorSupport: string;
  gateReportPath?: string;
  archivePath?: string;
  protectedPaths: string[];
  reportPath: string;
}

export interface XjCleanupCliReport {
  schemaVersion: 1;
  mode: 'scan' | 'gate' | 'apply';
  success: boolean;
  preScan: XjResidueReport;
  gate?: XjCleanupGate;
  cleanup?: XjCleanupResult;
  postScan: XjResidueReport;
}

function save(path: string, report: XjCleanupCliReport): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(report, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  renameSync(temporary, path);
}

export function runXjCleanupCli(options: XjCleanupCliOptions): XjCleanupCliReport {
  const preScan = scanXjResidue(options);
  let cleanup: XjCleanupResult | undefined;
  let gate: XjCleanupGate | undefined;
  if (options.mode === 'gate') {
    if (!options.archivePath) throw new Error('cleanup_archive_required');
    gate = createXjCleanupGate({ home: options.home, cursorSupport: options.cursorSupport, archivePath: options.archivePath });
  }
  if (options.mode === 'apply') {
    if (!options.gateReportPath) throw new Error('cleanup_gate_report_required');
    cleanup = applyXjCleanup({
      home: options.home,
      cursorSupport: options.cursorSupport,
      gateReportPath: options.gateReportPath,
      protectedPaths: options.protectedPaths,
    });
  }
  const postScan = scanXjResidue(options);
  const success = options.mode === 'gate' ? gate?.success === true : postScan.active.length === 0;
  const report: XjCleanupCliReport = {
    schemaVersion: 1,
    mode: options.mode,
    success,
    preScan,
    ...(gate ? { gate } : {}),
    ...(cleanup ? { cleanup } : {}),
    postScan,
  };
  save(options.reportPath, report);
  if (options.mode === 'apply' && !report.success) throw Object.assign(new Error('post_cleanup_residue'), { report });
  return report;
}

function one(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

function many(args: string[], flag: string): string[] {
  return args.flatMap((value, index) => value === flag && args[index + 1] ? [args[index + 1]!] : []);
}

function parse(args: string[]): XjCleanupCliOptions {
  const modes = [args.includes('--apply'), args.includes('--scan'), args.includes('--create-gate')].filter(Boolean).length;
  const mode = args.includes('--apply') ? 'apply' : args.includes('--scan') ? 'scan' : args.includes('--create-gate') ? 'gate' : undefined;
  if (!mode || modes !== 1) throw new Error('choose exactly one of --scan, --create-gate or --apply');
  const home = one(args, '--home') ?? homedir();
  return {
    mode,
    home,
    cursorSupport: one(args, '--cursor-support') ?? join(home, 'Library', 'Application Support', 'Cursor'),
    gateReportPath: one(args, '--gate'),
    archivePath: one(args, '--archive'),
    protectedPaths: many(args, '--protect'),
    reportPath: one(args, '--report') ?? join(process.cwd(), `xj-cleanup-${mode}.json`),
  };
}

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(entry).href) {
  try {
    const report = runXjCleanupCli(parse(process.argv.slice(2)));
    process.stdout.write(`${JSON.stringify({
      mode: report.mode,
      success: report.success,
      activeBefore: report.preScan.active.length,
      activeAfter: report.postScan.active.length,
      removed: report.cleanup?.removed.length ?? 0,
      updated: report.cleanup?.updated.length ?? 0,
      retainedHistoricalRows: report.postScan.retainedHistoricalRows.length,
    })}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
