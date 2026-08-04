import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  afkRoot,
  indexPath,
  legacyAfkRoot,
  migrateLegacyFlagsIfNeeded,
  initTaskArtifacts,
  listTaskSummaries,
  readIndex,
  readSummary,
  resolveActiveTasks,
  setTaskActive,
  taskDir,
  withIndexLock,
  writeIndex,
} from '../../src/rr/afk/index.js';

describe('rr afk store', () => {
  const envBackup = { ...process.env };
  const roots: string[] = [];

  afterEach(() => {
    process.env = { ...envBackup };
    roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }));
  });

  function useTempRoots(): { newRoot: string; legacyRoot: string } {
    const newRoot = mkdtempSync(join(tmpdir(), 'rr-afk-new-'));
    const legacyRoot = mkdtempSync(join(tmpdir(), 'rr-afk-legacy-'));
    roots.push(newRoot, legacyRoot);
    process.env.RR_AFK_ROOT = newRoot;
    process.env.RR_AFK_LEGACY_ROOT = legacyRoot;
    return { newRoot, legacyRoot };
  }

  it('initializes task artifacts with expected summary fields', () => {
    useTempRoots();
    const result = initTaskArtifacts({
      taskId: 'knowlever-solo',
      projectRoot: '/tmp/project',
      masterSessionId: 'rr-mcp-agent-00000000-0000-4000-8000-000000000001',
      plan: '# Plan\n',
      criteria: '- npm test\n',
      tasks: '- [ ] U1\n',
      maxLoops: 12,
    });

    expect(result.state.status).toBe('PLANNING');
    expect(result.summary).toMatchObject({
      task_id: 'knowlever-solo',
      status: 'PLANNING',
      master_session_id: 'rr-mcp-agent-00000000-0000-4000-8000-000000000001',
      current_unit: null,
      plan_revision: 0,
      loop: 0,
      allowlist: [],
      permission_request: null,
      last_command: null,
      last_verification: null,
      human_action_hint: null,
      project_root: '/tmp/project',
    });
    expect(result.state.max_loops).toBe(12);
    expect(existsSync(join(result.taskDir, 'PLAN.md'))).toBe(true);
    expect(existsSync(join(result.taskDir, 'CRITERIA.md'))).toBe(true);
    expect(existsSync(join(result.taskDir, 'TASKS.md'))).toBe(true);
    expect(existsSync(join(result.taskDir, 'TODO.md'))).toBe(true);
    expect(existsSync(join(result.taskDir, 'DECISIONS.md'))).toBe(true);
    expect(existsSync(join(result.taskDir, 'state.json'))).toBe(true);
    expect(existsSync(join(result.taskDir, 'summary.json'))).toBe(true);
    expect(existsSync(join(result.taskDir, 'events.jsonl'))).toBe(true);
  });

  it('persists mode in state and summary when provided', () => {
    useTempRoots();
    const result = initTaskArtifacts({
      taskId: 'mode-task',
      projectRoot: '/tmp/project',
      masterSessionId: null,
      mode: 'go',
    });

    expect(result.state.mode).toBe('go');
    expect(result.summary.mode).toBe('go');
    expect(readSummary('mode-task')?.mode).toBe('go');
  });

  it('tracks multiple active tasks in tasks/index.json', () => {
    useTempRoots();
    initTaskArtifacts({
      taskId: 'task-a',
      projectRoot: '/tmp/a',
      masterSessionId: null,
      activate: true,
    });
    initTaskArtifacts({
      taskId: 'task-b',
      projectRoot: '/tmp/b',
      masterSessionId: null,
      activate: true,
    });

    const index = readIndex();
    expect(index.active_tasks.sort()).toEqual(['task-a', 'task-b']);
    expect(resolveActiveTasks().sort()).toEqual(['task-a', 'task-b']);

    setTaskActive('task-a', false);
    expect(readIndex().active_tasks).toEqual(['task-b']);

    const summaries = listTaskSummaries();
    expect(summaries.map((item) => item.task_id).sort()).toEqual(['task-a', 'task-b']);
  });

  it('migrates legacy ~/.cursor/afk flags into the new root', () => {
    const { newRoot, legacyRoot } = useTempRoots();
    const legacyTaskDir = join(legacyRoot, 'my-legacy-task');
    mkdirSync(legacyTaskDir, { recursive: true });
    writeFileSync(join(legacyTaskDir, 'CRITERIA.md'), '- npm test\n', 'utf8');
    writeFileSync(join(legacyTaskDir, 'TODO.md'), '- [ ] one\n', 'utf8');
    writeFileSync(join(legacyRoot, 'ACTIVE'), '', 'utf8');
    writeFileSync(join(legacyRoot, 'MAX_LOOPS'), '25\n', 'utf8');

    const migration = migrateLegacyFlagsIfNeeded();
    expect(migration).toEqual({ migrated: true, taskId: 'my-legacy-task' });

    expect(readIndex().active_tasks).toEqual(['my-legacy-task']);
    const summary = readSummary('my-legacy-task');
    expect(summary?.status).toBe('RUNNING');
    expect(summary?.loop).toBe(0);
    expect(existsSync(join(taskDir('my-legacy-task'), 'CRITERIA.md'))).toBe(true);
    expect(readFileSync(join(taskDir('my-legacy-task'), 'CRITERIA.md'), 'utf8')).toContain('npm test');
    expect(existsSync(join(newRoot, 'tasks', 'index.json'))).toBe(true);
    expect(existsSync(join(legacyRoot, 'ACTIVE'))).toBe(true);
  });

  it('maps legacy PAUSE flag to PAUSED without activating task', () => {
    const { legacyRoot } = useTempRoots();
    const legacyTaskDir = join(legacyRoot, 'paused-task');
    mkdirSync(legacyTaskDir, { recursive: true });
    writeFileSync(join(legacyTaskDir, 'TODO.md'), '- [ ] one\n', 'utf8');
    writeFileSync(join(legacyRoot, 'PAUSE'), '', 'utf8');

    const migration = migrateLegacyFlagsIfNeeded();
    expect(migration.migrated).toBe(true);
    expect(readIndex().active_tasks).toEqual([]);
    expect(readSummary('paused-task')?.status).toBe('PAUSED');
  });

  it('does not migrate when new root already has tasks', () => {
    const { legacyRoot } = useTempRoots();
    initTaskArtifacts({
      taskId: 'existing',
      projectRoot: '/tmp/existing',
      masterSessionId: null,
    });
    writeFileSync(join(legacyRoot, 'ACTIVE'), '', 'utf8');

    expect(migrateLegacyFlagsIfNeeded()).toEqual({ migrated: false, taskId: null });
    expect(readIndex().active_tasks).toEqual(['existing']);
  });

  it('exposes canonical roots via helpers', () => {
    const { newRoot, legacyRoot } = useTempRoots();
    expect(afkRoot()).toBe(newRoot);
    expect(legacyAfkRoot()).toBe(legacyRoot);
    expect(indexPath()).toBe(join(newRoot, 'tasks', 'index.json'));
  });

  it('serializes index RMW via withIndexLock', () => {
    useTempRoots();
    const seen: string[] = [];
    withIndexLock(() => {
      seen.push('a');
      writeIndex({ active_tasks: ['locked-task'], updated_at: new Date().toISOString() });
      seen.push('b');
    });
    expect(seen).toEqual(['a', 'b']);
    expect(readIndex().active_tasks).toEqual(['locked-task']);
  });
});
