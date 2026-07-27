import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';

const cursorApp = process.env.RR_CURSOR_APP ?? '/Applications/Cursor.app';
const resources = join(cursorApp, 'Contents', 'Resources', 'app', 'out', 'vs');
const targets = [
  join(resources, 'workbench', 'workbench.desktop.main.js'),
  join(resources, 'workbench', 'workbench.glass.main.js'),
  join(resources, 'code', 'electron-utility', 'mcpProcess', 'mcpProcessMain.js'),
];
const settingsPath = process.env.RR_CURSOR_SETTINGS
  ?? join(homedir(), 'Library', 'Application Support', 'Cursor', 'User', 'settings.json');
const rrRoot = process.env.RR_STATE_ROOT ?? join(homedir(), '.rr-cursor');

const RR_MARKERS = [
  'CURSOR_RR_MCP_CREATE_DEDUPE',
  'CURSOR_RR_MCP_LEASE_GUARD',
  'CURSOR_RR_MCP_UNSUB_GRACE',
  'CURSOR_RR_MCP_SANDBOX_GUARD',
];

function hash(value) {
  return createHash('sha256').update(value).digest('hex');
}

function count(value, token) {
  return value.split(token).length - 1;
}

function replaceExactlyOnce(value, pattern, replacement, label) {
  const matches = value.match(pattern);
  if (!matches || matches.length !== 1) throw new Error(`${label}: expected exactly one pristine anchor, found ${matches?.length ?? 0}`);
  return value.replace(pattern, replacement);
}

function patchWorkbench(source, label) {
  let next = source
    .replaceAll('CURSOR_MCP_CREATE_DEDUPE', 'CURSOR_RR_MCP_CREATE_DEDUPE')
    .replaceAll('CURSOR_MCP_LEASE_GUARD', 'CURSOR_RR_MCP_LEASE_GUARD');

  if (!next.includes('CURSOR_RR_MCP_CREATE_DEDUPE')) {
    const pattern = /async createClient\(([a-zA-Z_$][\w$]*)\)\{this\.metricsService\.increment\(\{stat:"mcp\.create_client"\}\);const ([a-zA-Z_$][\w$]*)=\1\.identifier,([a-zA-Z_$][\w$]*)=this\.createClientPromises\.get\(\2\);if\(\3\)return \3;/g;
    next = replaceExactlyOnce(next, pattern, (match, arg, identifier, pending) => {
      const prefix = `async createClient(${arg}){this.metricsService.increment({stat:"mcp.create_client"});const ${identifier}=${arg}.identifier;`;
      return `${prefix}{const _rrStatus=this.statusCache()?.[${identifier}]?.type;if(_rrStatus==="connected"||_rrStatus==="initializing")return!0}const ${pending}=this.createClientPromises.get(${identifier});if(${pending})return ${pending};/*CURSOR_RR_MCP_CREATE_DEDUPE*/`;
    }, `${label}/create-dedupe`);
  }

  if (!next.includes('CURSOR_RR_MCP_LEASE_GUARD')) {
    const pattern = /_queueMcpLeaseFull\(([a-zA-Z_$][\w$]*)\)\{this\._pendingMcpLeaseFull=!0,this\._pendingMcpLeaseServerIds\.clear\(\),this\._pendingMcpLeaseReason=\1,this\._scheduleMcpExtHostNotifyFlush\(\)\}/g;
    next = replaceExactlyOnce(next, pattern, (_match, arg) => `_queueMcpLeaseFull(${arg}){/*CURSOR_RR_MCP_LEASE_GUARD*/return}`, `${label}/lease-guard`);
  }

  if (count(next, 'CURSOR_RR_MCP_CREATE_DEDUPE') !== 1) throw new Error(`${label}: create-dedupe marker count mismatch`);
  if (count(next, 'CURSOR_RR_MCP_LEASE_GUARD') !== 1) throw new Error(`${label}: lease-guard marker count mismatch`);
  return next;
}

function patchMcpProcess(source, label) {
  let next = source
    .replaceAll('CURSOR_MCP_UNSUB_GRACE', 'CURSOR_RR_MCP_UNSUB_GRACE')
    .replaceAll('CURSOR_MCP_SANDBOX_GUARD', 'CURSOR_RR_MCP_SANDBOX_GUARD');

  if (!next.includes('CURSOR_RR_MCP_UNSUB_GRACE')) {
    const pattern = /constructor\(([a-zA-Z_$][\w$]*)=([a-zA-Z_$][\w$]*)\)\{super\(\),this\.graceMs=\1,/g;
    next = replaceExactlyOnce(next, pattern, (_match, arg, fallback) => `constructor(${arg}=${fallback}){super(),this.graceMs=864e5/*CURSOR_RR_MCP_UNSUB_GRACE*/,`, `${label}/unsubscribe-grace`);
  }

  if (!next.includes('CURSOR_RR_MCP_SANDBOX_GUARD')) {
    const pattern = /async handleSandboxPolicyChange\(\)\{let /g;
    next = replaceExactlyOnce(next, pattern, 'async handleSandboxPolicyChange(){/*CURSOR_RR_MCP_SANDBOX_GUARD*/return;let ', `${label}/sandbox-guard`);
  }

  if (count(next, 'CURSOR_RR_MCP_UNSUB_GRACE') !== 1) throw new Error(`${label}: unsubscribe-grace marker count mismatch`);
  if (count(next, 'CURSOR_RR_MCP_SANDBOX_GUARD') !== 1) throw new Error(`${label}: sandbox-guard marker count mismatch`);
  return next;
}

function inspect() {
  const files = targets.map((path) => {
    if (!existsSync(path)) throw new Error(`Cursor target missing: ${path}`);
    const source = readFileSync(path, 'utf8');
    return { path, source, sha256: hash(source) };
  });
  const settings = existsSync(settingsPath) ? JSON.parse(readFileSync(settingsPath, 'utf8')) : {};
  return { files, settings };
}

function verify(snapshot) {
  const [desktop, glass, process] = snapshot.files;
  for (const [file, markers] of [
    [desktop, RR_MARKERS.slice(0, 2)],
    [glass, RR_MARKERS.slice(0, 2)],
    [process, RR_MARKERS.slice(2)],
  ]) {
    for (const marker of markers) {
      if (count(file.source, marker) !== 1) throw new Error(`${basename(file.path)}: ${marker} missing or duplicated`);
    }
    if (file.source.includes('CURSOR_MCP_CREATE_DEDUPE') || file.source.includes('CURSOR_MCP_LEASE_GUARD') || file.source.includes('CURSOR_MCP_UNSUB_GRACE') || file.source.includes('CURSOR_MCP_SANDBOX_GUARD')) {
      throw new Error(`${basename(file.path)}: legacy lifecycle marker remains`);
    }
  }
  if (snapshot.settings['xjCursor.mcpStable.enabled'] !== false) throw new Error('xjCursor.mcpStable.enabled must be false');
  if (snapshot.settings['xjCursor.update.autoInstall'] !== false) throw new Error('xjCursor.update.autoInstall must be false');
  console.log('Rr Cursor lifecycle verified: 2x create dedupe, 2x lease guard, 24h unsubscribe grace, sandbox guard');
}

if (process.argv.includes('--verify')) {
  verify(inspect());
  process.exit(0);
}

const before = inspect();
const patched = before.files.map((file, index) => ({
  ...file,
  output: index < 2 ? patchWorkbench(file.source, basename(file.path)) : patchMcpProcess(file.source, basename(file.path)),
}));

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const backupDir = join(rrRoot, 'backups', `cursor-lifecycle-${stamp}`);
mkdirSync(backupDir, { recursive: true, mode: 0o700 });
for (const file of before.files) copyFileSync(file.path, join(backupDir, basename(file.path)));
if (existsSync(settingsPath)) copyFileSync(settingsPath, join(backupDir, 'settings.json'));

for (const file of patched) {
  if (file.output === file.source) continue;
  const tmp = `${file.path}.${process.pid}.rr.tmp`;
  writeFileSync(tmp, file.output, { encoding: 'utf8', mode: 0o644 });
  renameSync(tmp, file.path);
}

const settings = {
  ...before.settings,
  'xjCursor.mcpStable.enabled': false,
  'xjCursor.update.autoInstall': false,
};
const settingsTmp = `${settingsPath}.${process.pid}.rr.tmp`;
writeFileSync(settingsTmp, `${JSON.stringify(settings, null, 4)}\n`, { encoding: 'utf8', mode: 0o600 });
renameSync(settingsTmp, settingsPath);

const after = inspect();
verify(after);
writeFileSync(join(backupDir, 'manifest.json'), `${JSON.stringify({
  installedAt: new Date().toISOString(),
  cursorApp,
  files: before.files.map((file, index) => ({
    path: file.path,
    beforeSha256: file.sha256,
    afterSha256: after.files[index].sha256,
  })),
}, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
console.log(`Rr Cursor lifecycle installed; backup: ${backupDir}`);

