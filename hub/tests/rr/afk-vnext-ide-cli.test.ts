import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  bindIdeConversation,
  buildCursorAgentProcessCommand,
  buildRecoveryPrompt,
  createWebTask,
  gateCheckForConversation,
  openAfkDb,
  registerNativeLane,
  resolveExecConcurrency,
  resolveNativeLane,
  type AfkDb,
} from '../../src/rr/afk/vnext/index.js';

describe('afk vnext ide/cli adapters', () => {
  const dbs: AfkDb[] = [];
  const dirs: string[] = [];
  afterEach(() => {
    while (dbs.length) dbs.pop()!.close();
    while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
  });

  function db(): AfkDb {
    const dir = mkdtempSync(join(tmpdir(), 'afk-adapter-'));
    dirs.push(dir);
    const d = openAfkDb(join(dir, 'afk.db'));
    dbs.push(d);
    return d;
  }

  it('binds two conversations to isolated tasks', () => {
    const d = db();
    const a = bindIdeConversation(d, {
      conversationId: 'c1',
      projectRoot: '/repo',
      goal: 'A',
    });
    const b = bindIdeConversation(d, {
      conversationId: 'c2',
      projectRoot: '/repo',
      goal: 'B',
    });
    expect(a.task_id).not.toBe(b.task_id);
    expect(gateCheckForConversation(d, 'c1', '/repo').ok).toBe(false);
    expect(gateCheckForConversation(d, 'c1', '/repo').task_id).toBe(a.task_id);
  });

  it('stores native subagent ids in registry by lane_key', () => {
    const d = db();
    const t = bindIdeConversation(d, { conversationId: 'c', projectRoot: '/r' });
    registerNativeLane(d, {
      taskId: t.task_id,
      laneKey: 'impl-1',
      role: 'implementer',
      nativeSubagentId: 'sub_abc',
    });
    expect(resolveNativeLane(d, t.task_id, 'impl-1')?.native_subagent_id).toBe('sub_abc');
  });

  it('budget unavailable ⇒ exec concurrency 1', () => {
    expect(resolveExecConcurrency(null)).toBe(1);
    expect(resolveExecConcurrency(Number.NaN)).toBe(1);
    expect(resolveExecConcurrency(4)).toBe(4);
  });

  it('builds PolarProcess-friendly shared start.sh command (params in argv)', () => {
    const spec = buildCursorAgentProcessCommand({
      taskId: 't1',
      nativeHandle: 'chat-99',
      resume: true,
      prompt: 'continue',
      workspace: '/repo',
      serviceId: 'afk-cli-t1',
    });
    expect(spec.id.startsWith('cursor-cli-')).toBe(true);
    expect(spec.command).toContain('Start/afk-cli/start.sh');
    expect(spec.command).toContain('chat-99');
    expect(spec.start_script_dir).toBe('Start/afk-cli');
  });

  it('web task starts QUEUED and recovery prompt is task-scoped', () => {
    const d = db();
    const t = createWebTask(d, { goal: 'ship', projectRoot: '/w' });
    expect(t.status).toBe('QUEUED');
    expect(t.surface).toBe('web');
    expect(buildRecoveryPrompt(t.task_id, t.goal)).toContain(t.task_id);
  });
});
