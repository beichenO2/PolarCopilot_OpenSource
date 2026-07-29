import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { armAfk, pickMasterSession, readAfkStatus } from '../../src/rr/afk-service.js';
import { RrFileStore } from '../../src/rr/store.js';
import * as polarService from '../../src/rr/orchestrator/polar-service.js';

describe('rr afk service', () => {
  const roots: string[] = [];
  const envBackup = { ...process.env };

  afterEach(() => {
    vi.restoreAllMocks();
    process.env = { ...envBackup };
    roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }));
  });

  it('picks preferred master session over others', () => {
    const store = new RrFileStore(mkdtempSync(join(tmpdir(), 'rr-afk-')));
    roots.push(store.root);
    const main = store.register({ name: 'Main' }).session;
    const sub = store.register({ name: 'Sub' }).session;
    store.setSubagent(sub.sessionId, true);
    const picked = pickMasterSession(store.listSessions(), sub.sessionId);
    expect(picked?.sessionId).toBe(main.sessionId);
  });

  it('arms ACTIVE and MAX_LOOPS under afk root', () => {
    const root = mkdtempSync(join(tmpdir(), 'rr-afk-arm-'));
    roots.push(root);
    const afkRoot = join(root, 'afk');
    const taskDir = join(afkRoot, 'my-task');
    mkdirSync(taskDir, { recursive: true });
    writeFileSync(join(taskDir, 'TODO.md'), '- [ ] one\n', 'utf8');
    writeFileSync(join(root, '.rr-orchestrator.json'), JSON.stringify({
      projectRoot: root,
      afkRoot,
      statePath: join(root, 'state.json'),
    }), 'utf8');

    process.env.PC_PROJECT_DIR = root;

    const result = armAfk({ taskSlug: 'my-task', maxLoops: 12, projectRoot: root, force: true });
    expect(result.armed).toBe(true);
    expect(existsSync(join(afkRoot, 'ACTIVE'))).toBe(true);
    expect(existsSync(join(afkRoot, 'MAX_LOOPS'))).toBe(true);
    expect(result.maxLoops).toBe(12);
  });

  it('rejects arm when ACTIVE exists without force', () => {
    const root = mkdtempSync(join(tmpdir(), 'rr-afk-block-'));
    roots.push(root);
    const afkRoot = join(root, 'afk');
    mkdirSync(afkRoot, { recursive: true });
    writeFileSync(join(afkRoot, 'ACTIVE'), '', 'utf8');
    writeFileSync(join(root, '.rr-orchestrator.json'), JSON.stringify({
      projectRoot: root,
      afkRoot,
    }), 'utf8');
    process.env.PC_PROJECT_DIR = root;

    expect(() => armAfk({ projectRoot: root })).toThrow('afk_already_active');
  });

  it('returns aggregate status snapshot', async () => {
    const root = mkdtempSync(join(tmpdir(), 'rr-afk-status-'));
    roots.push(root);
    const afkRoot = join(root, 'afk');
    const taskDir = join(afkRoot, 'task');
    mkdirSync(taskDir, { recursive: true });
    writeFileSync(join(afkRoot, 'ACTIVE'), '', 'utf8');
    writeFileSync(join(afkRoot, 'MAX_LOOPS'), '40\n', 'utf8');
    writeFileSync(join(root, 'TODO.md'), '- [ ] first\n- [x] done\n', 'utf8');
    writeFileSync(join(root, 'CRITERIA.md'), '- npm test\n', 'utf8');
    writeFileSync(join(root, '.rr-orchestrator.json'), JSON.stringify({
      projectRoot: root,
      afkRoot,
      statePath: join(root, 'state.json'),
    }), 'utf8');
    process.env.PC_PROJECT_DIR = root;

    vi.spyOn(polarService, 'readOrchestratorServiceState').mockResolvedValue({
      enabled: true,
      running: true,
      serviceStatus: 'running',
      pid: 1234,
    });

    const status = await readAfkStatus(root);
    expect(status.active).toBe(true);
    expect(status.todo.pending).toBe(1);
    expect(status.todo.done).toBe(1);
    expect(status.orchestrator.running).toBe(true);
    expect(status.loopCount).toBeGreaterThanOrEqual(0);
  });
});
