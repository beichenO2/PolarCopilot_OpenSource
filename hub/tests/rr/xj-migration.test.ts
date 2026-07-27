import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, describe, expect, it } from 'vitest';
import { createRrMcpServer } from '../../src/rr/mcp-server.js';
import { RrFileStore } from '../../src/rr/store.js';
import { auditXjSource, importXjToRr, planXjImport, verifyXjImport } from '../../src/rr/xj-migration.js';

const MAIN_ID = 'xj-mcp-agent-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const CHILD_ID = 'xj-mcp-agent-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const PENDING_ID = 'xj-mcp-pending-1700000000000-deadbeef';
const WORKSPACE_ONLY_ID = 'xj-mcp-agent-cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const LAUNCH_ID = 'xjlaunch-1700000000000-a1b2c3d4';
const TASK_ID = 't-1700000000300-feedbeef';

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function treeDigest(root: string): string {
  const records: string[] = [];
  const visit = (path: string, relativePath = '') => {
    const stat = statSync(path);
    if (stat.isDirectory()) {
      for (const name of readdirSync(path).sort()) visit(join(path, name), relativePath ? `${relativePath}/${name}` : name);
    } else if (stat.isFile()) {
      records.push(`${relativePath}\0${createHash('sha256').update(readFileSync(path)).digest('hex')}`);
    }
  };
  visit(root);
  return sha256(records.join('\n'));
}

function makeFixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'xj-migration-source-'));
  for (const dir of ['sessions', 'history', 'inbox', 'tasks', 'subagents']) mkdirSync(join(root, dir), { recursive: true });
  mkdirSync(join(root, 'inbox', MAIN_ID), { recursive: true });

  writeJson(join(root, 'sessions', `${PENDING_ID}.json`), {
    sessionId: PENDING_ID,
    name: 'Pending Main',
    launchId: LAUNCH_ID,
    launchKind: 'polling',
    launchState: 'connecting',
    claimedAt: 1_700_000_000_150,
    workspaceRoot: '/fixture/workspace',
    agentStatus: 'connecting',
    createdAt: 1_700_000_000_000,
    lastActiveAt: 1_700_000_000_000,
    lastMessageTs: 0,
    online: false,
    waiting: false,
    pendingMessages: 0,
  });
  writeJson(join(root, 'sessions', `${MAIN_ID}.json`), {
    sessionId: MAIN_ID,
    name: 'Main',
    launchId: LAUNCH_ID,
    role: 'master',
    title: 'Migration plan',
    agentStatus: 'developing',
    createdAt: 1_700_000_000_150,
    lastActiveAt: 1_700_000_000_500,
    lastMessageTs: 1_700_000_000_480,
    online: true,
    waiting: true,
    pendingMessages: 1,
    uiLocale: 'zh-cn',
    suggestions: ['continue'],
  });
  writeJson(join(root, 'sessions', `${CHILD_ID}.json`), {
    sessionId: CHILD_ID,
    name: 'Subagent',
    title: 'Child work',
    agentStatus: 'ready',
    createdAt: 1_700_000_000_160,
    lastActiveAt: 1_700_000_000_400,
    lastMessageTs: 1_700_000_000_350,
    online: true,
    waiting: false,
    pendingMessages: 0,
    uiLocale: 'zh-cn',
  });

  const mainHistory = [
    {
      msgId: 'm-1700000000200-11111111',
      from: 'user',
      to: MAIN_ID,
      seq: 1,
      ts: 1_700_000_000_200,
      type: 'task',
      content: 'Plan alpha\n- preserve every ID',
      requireReply: true,
      suggestions: ['Proceed'],
    },
    {
      msgId: 'm-1700000000400-33333333',
      from: CHILD_ID,
      to: MAIN_ID,
      seq: 3,
      ts: 1_700_000_000_400,
      type: 'result',
      content: 'Child result body',
      subtask: { kind: 'result', taskId: TASK_ID, peer: CHILD_ID, peerName: 'Subagent', ok: true },
    },
  ];
  writeFileSync(join(root, 'history', `${MAIN_ID}.jsonl`), `${mainHistory.map((row) => JSON.stringify(row)).join('\n')}\n`, 'utf8');
  writeFileSync(join(root, 'history', `${CHILD_ID}.jsonl`), `${JSON.stringify({
    msgId: 'm-1700000000300-22222222',
    from: MAIN_ID,
    to: CHILD_ID,
    seq: 2,
    ts: 1_700_000_000_300,
    type: 'task',
    content: 'Inspect child task',
    subtask: { kind: 'task', taskId: TASK_ID, peer: MAIN_ID, peerName: 'Main' },
  })}\n`, 'utf8');
  writeJson(join(root, 'inbox', MAIN_ID, 'm-1700000000480-44444444.json'), {
    msgId: 'm-1700000000480-44444444',
    from: 'panel',
    to: MAIN_ID,
    seq: 4,
    ts: 1_700_000_000_480,
    type: 'discussion',
    content: 'Unread continuation',
    requireReply: true,
  });
  writeJson(join(root, 'tasks', `${TASK_ID}.json`), {
    taskId: TASK_ID,
    masterSessionId: MAIN_ID,
    targetSessionId: CHILD_ID,
    masterName: 'Main',
    status: 'done',
    percent: 100,
    content: 'Inspect child task',
    progress: 'complete',
    result: 'Child result body',
    createdAt: 1_700_000_000_300,
    updatedAt: 1_700_000_000_390,
    completedAt: 1_700_000_000_400,
  });
  writeJson(join(root, 'subagents', `${CHILD_ID}.json`), {
    sessionId: CHILD_ID,
    enabled: true,
    updatedAt: 1_700_000_000_300,
  });
  writeJson(join(root, 'session-workspace.json'), {
    [PENDING_ID]: { ws: '/fixture/workspace', name: 'Pending Main', createdAt: 1_700_000_000_000 },
    [MAIN_ID]: { ws: '/fixture/workspace', name: 'Main', createdAt: 1_700_000_000_150 },
    [WORKSPACE_ONLY_ID]: { ws: '/fixture/legacy', name: 'Workspace orphan', createdAt: 1_699_999_999_000 },
  });
  writeFileSync(join(root, 'mcp-events.log'), [
    JSON.stringify({ schema: 1, ts: 1_700_000_000_200, pid: 1, ev: 'tool.start', name: 'wait_message', sessionTail: 'aaaaaaaa' }),
    JSON.stringify({ schema: 1, ts: 1_700_000_000_400, pid: 1, ev: 'tool.end', name: 'wait_message', sessionTail: 'aaaaaaaa', isError: false }),
  ].join('\n') + '\n', 'utf8');
  return root;
}

describe('XJ lossless migration audit', () => {
  const roots: string[] = [];
  afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

  it('inventories bodies, identifiers, timestamps, references and topology without mutation', () => {
    const source = makeFixture();
    roots.push(source);
    const audit = auditXjSource(source);

    expect(audit.counts).toEqual({
      sessions: 3,
      historyFiles: 2,
      historyRecords: 3,
      inbox: 1,
      tasks: 1,
      subagents: 1,
      workspaceRecords: 3,
      eventRecords: 2,
    });
    expect(audit.idSets.sessionIds).toEqual([CHILD_ID, MAIN_ID, PENDING_ID].sort());
    expect(audit.idSets.messageIds).toEqual([
      'm-1700000000200-11111111',
      'm-1700000000300-22222222',
      'm-1700000000400-33333333',
      'm-1700000000480-44444444',
    ]);
    expect(audit.idSets.taskIds).toEqual([TASK_ID]);
    expect(audit.idSets.launchIds).toEqual([LAUNCH_ID]);
    expect(audit.bodyHashes).toEqual([
      sha256('Plan alpha\n- preserve every ID'),
      sha256('Inspect child task'),
      sha256('Child result body'),
      sha256('Unread continuation'),
    ].sort());
    expect(audit.references.brokenRequired).toEqual([]);
    expect(audit.references.workspaceOnly).toEqual([WORKSPACE_ONLY_ID]);
    expect(audit.references.sessionOnly).toEqual([CHILD_ID]);
    expect(audit.timestamps).toContain(1_700_000_000_500);
    expect(audit.statusValues).toEqual(['connecting', 'developing', 'done', 'ready'].sort());
    expect(audit.topology.edges).toEqual(expect.arrayContaining([
      { type: 'launch_claim', from: PENDING_ID, to: MAIN_ID, relationId: LAUNCH_ID },
      { type: 'task_dispatch', from: MAIN_ID, to: CHILD_ID, relationId: TASK_ID },
      { type: 'subtask_message', from: MAIN_ID, to: CHILD_ID, relationId: TASK_ID },
      { type: 'subtask_message', from: CHILD_ID, to: MAIN_ID, relationId: TASK_ID },
    ]));
    expect(audit.latestAgentSessionId).toBe(MAIN_ID);
  });

  it('rejects a broken required task reference', () => {
    const source = makeFixture();
    roots.push(source);
    const taskPath = join(source, 'tasks', `${TASK_ID}.json`);
    writeJson(taskPath, {
      taskId: TASK_ID,
      masterSessionId: MAIN_ID,
      targetSessionId: 'xj-mcp-agent-dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      status: 'done',
      content: 'broken',
      result: '',
      progress: '',
      percent: 100,
      masterName: 'Main',
      createdAt: 1,
      updatedAt: 2,
      completedAt: 3,
    });
    expect(() => auditXjSource(source)).toThrow(/broken_required_reference/);
  });

  it('rejects subtask messages whose task or declared peer is missing or inconsistent', () => {
    const mutations: Array<(rows: Array<Record<string, unknown>>) => void> = [
      (rows) => { (rows[1]!.subtask as Record<string, unknown>).taskId = 't-1700000000999-deadbeef'; },
      (rows) => { (rows[1]!.subtask as Record<string, unknown>).peer = PENDING_ID; },
      (rows) => { (rows[1]!.subtask as Record<string, unknown>).peer = 'xj-mcp-agent-dddddddd-dddd-4ddd-8ddd-dddddddddddd'; },
    ];
    for (const mutate of mutations) {
      const source = makeFixture();
      roots.push(source);
      const path = join(source, 'history', `${MAIN_ID}.jsonl`);
      const rows = readFileSync(path, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
      mutate(rows);
      writeFileSync(path, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`, 'utf8');
      expect(() => auditXjSource(source)).toThrow(/broken_required_reference/);
    }
  });

  it('rejects unsafe XJ identifiers before creating the RR root', () => {
    const mutations: Array<(source: string) => void> = [
      (source) => {
        const path = join(source, 'tasks', `${TASK_ID}.json`);
        const task = JSON.parse(readFileSync(path, 'utf8'));
        task.taskId = '../../escaped-task';
        writeJson(path, task);
      },
      (source) => {
        const path = join(source, 'history', `${MAIN_ID}.jsonl`);
        const rows = readFileSync(path, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
        rows[0].msgId = '../escaped-message';
        writeFileSync(path, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`, 'utf8');
      },
      (source) => {
        const path = join(source, 'subagents', `${CHILD_ID}.json`);
        const marker = JSON.parse(readFileSync(path, 'utf8'));
        marker.sessionId = 'xj-mcp-agent-../../escaped-subagent';
        writeJson(path, marker);
      },
    ];

    for (const mutate of mutations) {
      const source = makeFixture();
      const parent = mkdtempSync(join(tmpdir(), 'rr-unsafe-id-'));
      const rr = join(parent, 'rr-not-created');
      const sentinel = join(parent, 'sentinel');
      roots.push(source, parent);
      writeFileSync(sentinel, 'keep', 'utf8');
      mutate(source);
      expect(() => planXjImport(source, rr)).toThrow(/invalid_(?:task|message|subagent|session|xj)_id/);
      expect(existsSync(rr)).toBe(false);
      expect(readFileSync(sentinel, 'utf8')).toBe('keep');
    }
  });
});

describe('XJ additive RR import', () => {
  const roots: string[] = [];
  afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

  function rootsForImport(): { source: string; rr: string } {
    const source = makeFixture();
    const rr = mkdtempSync(join(tmpdir(), 'rr-migration-target-'));
    roots.push(source, rr);
    for (const dir of ['sessions', 'history', 'inbox', 'processing', 'subagents', 'tasks', 'task-locks']) mkdirSync(join(rr, dir), { recursive: true });
    return { source, rr };
  }

  it('keeps a byte-identical raw mirror and exposes records under their original XJ IDs', () => {
    const { source, rr } = rootsForImport();
    const existingSessionId = 'rr-mcp-agent-eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
    const existingSessionPath = join(rr, 'sessions', `${existingSessionId}.json`);
    const existingHistoryPath = join(rr, 'history', `${existingSessionId}.jsonl`);
    writeJson(existingSessionPath, {
      sessionId: existingSessionId,
      name: 'Existing RR',
      title: 'protected',
      createdAt: 10,
      lastActiveAt: 10,
      agentStatus: 'ready',
      waiting: false,
      pendingMessages: 0,
      online: false,
      isSubagent: false,
      uiLocale: 'zh-cn',
      lastMessageTs: 0,
      status: 'offline',
    });
    writeFileSync(existingHistoryPath, '{"msgId":"rr-existing"}\n', 'utf8');
    const protectedSession = readFileSync(existingSessionPath);
    const protectedHistory = readFileSync(existingHistoryPath);

    const result = importXjToRr(planXjImport(source, rr));
    expect(result.inserted).toEqual({ sessions: 3, historyRecords: 3, inbox: 1, tasks: 1, subagents: 1 });
    expect(readFileSync(existingSessionPath)).toEqual(protectedSession);
    expect(readFileSync(existingHistoryPath)).toEqual(protectedHistory);
    expect(readFileSync(join(rr, 'compat', 'xj', 'raw', 'history', `${MAIN_ID}.jsonl`))).toEqual(
      readFileSync(join(source, 'history', `${MAIN_ID}.jsonl`)),
    );
    expect(readFileSync(join(rr, 'compat', 'xj', 'raw', 'mcp-events.log'))).toEqual(readFileSync(join(source, 'mcp-events.log')));

    const importedSession = JSON.parse(readFileSync(join(rr, 'sessions', `${MAIN_ID}.json`), 'utf8'));
    const sourceSession = JSON.parse(readFileSync(join(source, 'sessions', `${MAIN_ID}.json`), 'utf8'));
    expect(importedSession.sessionId).toBe(MAIN_ID);
    expect(importedSession.launchId).toBe(LAUNCH_ID);
    expect(importedSession.compat.raw).toEqual(sourceSession);

    const importedHistory = readFileSync(join(rr, 'history', `${MAIN_ID}.jsonl`), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    expect(importedHistory.map((message) => message.msgId)).toEqual([
      'm-1700000000200-11111111',
      'm-1700000000400-33333333',
    ]);
    expect(importedHistory[0]).toMatchObject({
      sessionId: MAIN_ID,
      msgId: 'm-1700000000200-11111111',
      content: 'Plan alpha\n- preserve every ID',
      createdAt: 1_700_000_000_200,
      metadata: { xj: { raw: { seq: 1, requireReply: true } } },
    });
    expect(JSON.parse(readFileSync(join(rr, 'tasks', `${TASK_ID}.json`), 'utf8'))).toMatchObject({
      taskId: TASK_ID,
      masterSessionId: MAIN_ID,
      targetSessionId: CHILD_ID,
      status: 'done',
      compat: { source: 'xj' },
    });
    expect(new RrFileStore(rr).getSession(MAIN_ID).sessionId).toBe(MAIN_ID);

    const verification = verifyXjImport(source, rr);
    expect(verification).toMatchObject({
      ok: true,
      rawTreeMatch: true,
      countsMatch: true,
      idSetsMatch: true,
      bodyHashesMatch: true,
      referencesMatch: true,
      timestampsAndStatusesMatch: true,
      topologyMatch: true,
    });
  });

  it('is idempotent and preserves RR messages appended after migration', () => {
    const { source, rr } = rootsForImport();
    const plan = planXjImport(source, rr);
    const first = importXjToRr(plan);
    const second = importXjToRr(plan);
    expect(first.inserted.historyRecords).toBe(3);
    expect(second.inserted).toEqual({ sessions: 0, historyRecords: 0, inbox: 0, tasks: 0, subagents: 0 });

    const historyPath = join(rr, 'history', `${MAIN_ID}.jsonl`);
    writeFileSync(historyPath, `${JSON.stringify({
      msgId: 'm-1700000000600-runtime',
      sessionId: MAIN_ID,
      from: MAIN_ID,
      to: 'panel',
      role: 'assistant',
      content: 'post-migration reply',
      createdAt: 1_700_000_000_600,
      metadata: { type: 'rr_runtime' },
    })}\n`, { encoding: 'utf8', flag: 'a' });
    const third = importXjToRr(plan);
    expect(third.inserted.historyRecords).toBe(0);
    const messages = readFileSync(historyPath, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    expect(messages.filter((message) => message.msgId === 'm-1700000000200-11111111')).toHaveLength(1);
    expect(messages.some((message) => message.msgId === 'm-1700000000600-runtime')).toBe(true);
  });

  it('never replaces a live history inode while appending imported records', () => {
    const { source, rr } = rootsForImport();
    const historyPath = join(rr, 'history', `${MAIN_ID}.jsonl`);
    const observerPath = join(rr, 'history', 'runtime-observer.jsonl');
    writeFileSync(historyPath, `${JSON.stringify({
      msgId: 'm-1700000000100-deadbeef',
      sessionId: MAIN_ID,
      from: 'panel',
      to: MAIN_ID,
      role: 'user',
      content: 'runtime-before-import',
      createdAt: 1_700_000_000_100,
      metadata: { type: 'rr_runtime' },
    })}\n`, 'utf8');
    linkSync(historyPath, observerPath);
    const inode = statSync(historyPath).ino;

    importXjToRr(planXjImport(source, rr));

    expect(statSync(historyPath).ino).toBe(inode);
    expect(statSync(observerPath).ino).toBe(inode);
    const observed = readFileSync(observerPath, 'utf8');
    expect(observed).toContain('runtime-before-import');
    expect(observed).toContain('Plan alpha');
    expect(observed).toContain('Child result body');
  });

  it('rejects a changed source on fresh reimport and leaves the RR tree byte-identical', () => {
    const { source, rr } = rootsForImport();
    importXjToRr(planXjImport(source, rr));
    const before = treeDigest(rr);
    const rawBefore = readFileSync(join(rr, 'compat', 'xj', 'raw', 'sessions', `${MAIN_ID}.json`));
    const nativeBefore = readFileSync(join(rr, 'sessions', `${MAIN_ID}.json`));
    const sourcePath = join(source, 'sessions', `${MAIN_ID}.json`);
    const changed = JSON.parse(readFileSync(sourcePath, 'utf8'));
    changed.name = 'changed after immutable import';
    writeJson(sourcePath, changed);

    expect(() => importXjToRr(planXjImport(source, rr))).toThrow(/(?:raw|source|destination)_collision/);
    expect(treeDigest(rr)).toBe(before);
    expect(readFileSync(join(rr, 'compat', 'xj', 'raw', 'sessions', `${MAIN_ID}.json`))).toEqual(rawBefore);
    expect(readFileSync(join(rr, 'sessions', `${MAIN_ID}.json`))).toEqual(nativeBefore);
  });

  it('detects RR-native route, timestamp, status and compatibility tampering', () => {
    const { source, rr } = rootsForImport();
    importXjToRr(planXjImport(source, rr));

    const sessionPath = join(rr, 'sessions', `${MAIN_ID}.json`);
    const session = JSON.parse(readFileSync(sessionPath, 'utf8'));
    session.createdAt += 1;
    session.agentStatus = 'tampered';
    writeJson(sessionPath, session);

    const historyPath = join(rr, 'history', `${MAIN_ID}.jsonl`);
    const history = readFileSync(historyPath, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    history[0].from = CHILD_ID;
    history[0].to = 'panel';
    history[0].createdAt += 1;
    history[0].compat.sourceHash = '0'.repeat(64);
    history[0].compat.raw.content = 'tampered raw compatibility body';
    writeFileSync(historyPath, `${history.map((row) => JSON.stringify(row)).join('\n')}\n`, 'utf8');

    const taskPath = join(rr, 'tasks', `${TASK_ID}.json`);
    const task = JSON.parse(readFileSync(taskPath, 'utf8'));
    task.status = 'active';
    writeJson(taskPath, task);

    const verification = verifyXjImport(source, rr);
    expect(verification.ok).toBe(false);
    expect(verification.referencesMatch).toBe(false);
    expect(verification.timestampsAndStatusesMatch).toBe(false);
    expect(verification.mismatches).toEqual(expect.arrayContaining([
      expect.stringMatching(/native_session.*createdAt/),
      expect.stringMatching(/native_message.*from/),
      expect.stringMatching(/native_message.*sourceHash/),
      expect.stringMatching(/native_task.*status/),
    ]));
  });

  it('honors an exclusive import lock before inspecting or writing destination records', () => {
    const { source, rr } = rootsForImport();
    writeFileSync(join(rr, '.xj-import.lock'), 'held by another importer', 'utf8');
    expect(() => importXjToRr(planXjImport(source, rr))).toThrow(/import_in_progress/);
    expect(readdirSync(join(rr, 'sessions'))).toEqual([]);
  });

  it('refuses an unrelated destination collision', () => {
    const { source, rr } = rootsForImport();
    writeJson(join(rr, 'sessions', `${MAIN_ID}.json`), {
      sessionId: MAIN_ID,
      name: 'unrelated record',
      compat: { source: 'other' },
    });
    expect(() => importXjToRr(planXjImport(source, rr))).toThrow(/destination_collision/);
  });

  it('rejects a symlinked RR destination ancestor without writing outside RR', () => {
    const { source, rr } = rootsForImport();
    const outside = mkdtempSync(join(tmpdir(), 'rr-migration-outside-'));
    roots.push(outside);
    rmSync(join(rr, 'sessions'), { recursive: true, force: true });
    symlinkSync(outside, join(rr, 'sessions'));

    expect(() => importXjToRr(planXjImport(source, rr))).toThrow(/unsafe_(?:destination_)?symlink/);
    expect(readdirSync(outside)).toEqual([]);
  });

  it('never overwrites a destination created after preflight', async () => {
    const { source, rr } = rootsForImport();
    const padding = join(source, 'zz-padding');
    mkdirSync(padding);
    for (let index = 0; index < 100; index += 1) writeFileSync(join(padding, `${index}.txt`), 'x');
    const signalPath = join(rr, 'compat', 'xj', 'raw');
    const target = join(rr, 'sessions', `${MAIN_ID}.json`);
    const sentinel = '{"owner":"rr-runtime"}\n';
    const child = spawn(process.execPath, ['-e', [
      "const fs=require('node:fs'); const path=require('node:path');",
      'const [signal,target,sentinel]=process.argv.slice(1);',
      "process.stdout.write('ready\\n');",
      'const timer=setInterval(()=>{if(fs.existsSync(signal)){clearInterval(timer);fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,sentinel);process.exit(0)}},1);',
      // Importing the padding tree can be CPU-bound when the full RR
      // suite runs in parallel; the assertion is about collision safety, not a
      // five-second scheduler budget.
      'setTimeout(()=>process.exit(2),30000);',
    ].join(''), signalPath, target, sentinel], { stdio: ['ignore', 'pipe', 'pipe'] });
    await once(child.stdout!, 'data');
    let thrown: unknown;
    try { importXjToRr(planXjImport(source, rr)); }
    catch (error) { thrown = error; }
    const [exitCode] = await once(child, 'exit');

    expect(exitCode).toBe(0);
    expect(String(thrown)).toMatch(/destination_collision/);
    expect(readFileSync(target, 'utf8')).toBe(sentinel);
  });
});

describe('XJ continue takeover', () => {
  const roots: string[] = [];
  afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

  async function harness() {
    const source = makeFixture();
    const rr = mkdtempSync(join(tmpdir(), 'rr-resume-target-'));
    roots.push(source, rr);
    importXjToRr(planXjImport(source, rr));
    const store = new RrFileStore(rr, { offlineAfterMs: Number.MAX_SAFE_INTEGER });
    const server = createRrMcpServer(store);
    const client = new Client({ name: 'xj-resume-test', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    return { source, rr, store, server, client };
  }

  it('resumes the latest imported agent with complete history, task, workspace and topology context', async () => {
    const { server, client } = await harness();
    const resumed = await client.callTool({ name: 'register_session', arguments: { name: 'continue' } });
    const text = (resumed.content as Array<{ text: string }>)[0]!.text;
    expect(text).toContain('[RR_RESUME]');
    expect(text).toContain(`sessionId: ${MAIN_ID}`);
    expect(text).toContain(`launchId: ${LAUNCH_ID}`);
    expect(text).toContain('Plan alpha\\n- preserve every ID');
    expect(text).toContain('Child result body');
    expect(text).toContain(TASK_ID);
    expect(text).toContain('"status": "done"');
    expect(text).toContain('"type": "task_dispatch"');
    expect(text).toContain('"ws": "/fixture/workspace"');
    expect(text).toContain(`wait_message("${MAIN_ID}")`);
    await client.close();
    await server.close();
  });

  it('continues reading and writing through the resumed XJ session inbox and history', async () => {
    const { source, rr, store, server, client } = await harness();
    const resumed = await client.callTool({ name: 'register_session', arguments: { name: 'continue' } });
    const resumeText = (resumed.content as Array<{ text: string }>)[0]!.text;
    expect(resumeText).toContain(`sessionId: ${MAIN_ID}`);

    const unread = await client.callTool({ name: 'wait_message', arguments: { sessionId: MAIN_ID, timeoutMs: 10_000 } });
    expect((unread.content as Array<{ text: string }>)[0]!.text).toContain('Unread continuation');
    await client.callTool({ name: 'reply_message', arguments: { sessionId: MAIN_ID, content: 'ack imported unread' } });

    store.enqueueUserMessage(MAIN_ID, 'post-resume route marker');
    const routed = await client.callTool({ name: 'wait_message', arguments: { sessionId: MAIN_ID, timeoutMs: 10_000 } });
    expect((routed.content as Array<{ text: string }>)[0]!.text).toContain('post-resume route marker');
    await client.callTool({ name: 'reply_message', arguments: { sessionId: MAIN_ID, content: 'post-resume reply marker' } });

    const history = store.getHistory(MAIN_ID);
    expect(history.some((message) => message.content === 'post-resume reply marker')).toBe(true);
    expect(history.filter((message) => message.compat?.source === 'xj').map((message) => message.msgId).sort()).toEqual(
      ['m-1700000000200-11111111', 'm-1700000000400-33333333'],
    );
    expect(readFileSync(join(rr, 'compat', 'xj', 'raw', 'inbox', MAIN_ID, 'm-1700000000480-44444444.json'))).toEqual(
      readFileSync(join(source, 'inbox', MAIN_ID, 'm-1700000000480-44444444.json')),
    );
    await client.close();
    await server.close();
  });

  it('derives resume topology from immutable raw data and verification detects manifest tampering', async () => {
    const { source, rr, server, client } = await harness();
    const manifestPath = join(rr, 'compat', 'xj', 'import-manifest.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    manifest.audit.topology = { subagentSessionIds: [], edges: [] };
    writeJson(manifestPath, manifest);

    const verification = verifyXjImport(source, rr);
    expect(verification.ok).toBe(false);
    expect(verification.mismatches).toContain('import_manifest');
    const resumed = await client.callTool({ name: 'register_session', arguments: { name: 'continue' } });
    const text = (resumed.content as Array<{ text: string }>)[0]!.text;
    expect(text).toContain('"type": "task_dispatch"');
    expect(text).toContain(TASK_ID);

    await client.close();
    await server.close();
  });

  it('isolates continue claims by MCP instance and redelivers an expired owner claim once', async () => {
    const source = makeFixture();
    const rr = mkdtempSync(join(tmpdir(), 'rr-resume-lease-'));
    roots.push(source, rr);
    importXjToRr(planXjImport(source, rr));

    const serverA = createRrMcpServer(new RrFileStore(rr, { offlineAfterMs: Number.MAX_SAFE_INTEGER }));
    const serverB = createRrMcpServer(new RrFileStore(rr, { offlineAfterMs: Number.MAX_SAFE_INTEGER }));
    const clientA = new Client({ name: 'resume-owner-a', version: '1.0.0' });
    const clientB = new Client({ name: 'resume-owner-b', version: '1.0.0' });
    const [clientTransportA, serverTransportA] = InMemoryTransport.createLinkedPair();
    const [clientTransportB, serverTransportB] = InMemoryTransport.createLinkedPair();
    await serverA.connect(serverTransportA);
    await serverB.connect(serverTransportB);
    await clientA.connect(clientTransportA);
    await clientB.connect(clientTransportB);

    const resumedA = await clientA.callTool({ name: 'register_session', arguments: { name: 'continue' } });
    expect(resumedA.isError).not.toBe(true);
    const firstClaim = await clientA.callTool({ name: 'wait_message', arguments: { sessionId: MAIN_ID, timeoutMs: 10_000 } });
    expect((firstClaim.content as Array<{ text: string }>)[0]!.text).toContain('Unread continuation');

    const blockedResume = await clientB.callTool({ name: 'register_session', arguments: { name: 'continue' } });
    expect(blockedResume.isError).toBe(true);
    expect((blockedResume.content as Array<{ text: string }>)[0]!.text).toMatch(/resume_session_(?:busy|leased)/);
    const blockedReply = await clientB.callTool({ name: 'reply_message', arguments: { sessionId: MAIN_ID, content: 'must not ack A' } });
    expect(blockedReply.isError).toBe(true);
    expect(readdirSync(join(rr, 'processing', MAIN_ID)).filter((name) => name.endsWith('.json'))).toHaveLength(1);

    const leasePath = join(rr, 'resume-leases', `${MAIN_ID}.json`);
    const expiredLease = JSON.parse(readFileSync(leasePath, 'utf8'));
    expiredLease.expiresAt = 0;
    writeJson(leasePath, expiredLease);

    const resumedB = await clientB.callTool({ name: 'register_session', arguments: { name: 'continue' } });
    expect(resumedB.isError).not.toBe(true);
    const statusBeforeUnauthorizedWait = new RrFileStore(rr).getSession(MAIN_ID).agentStatus;
    const staleOwnerWait = await clientA.callTool({
      name: 'wait_message',
      arguments: { sessionId: MAIN_ID, agentStatus: 'must-not-be-written', timeoutMs: 10_000 },
    });
    expect(staleOwnerWait.isError).toBe(true);
    expect(new RrFileStore(rr).getSession(MAIN_ID).agentStatus).toBe(statusBeforeUnauthorizedWait);
    const redelivered = await clientB.callTool({ name: 'wait_message', arguments: { sessionId: MAIN_ID, timeoutMs: 10_000 } });
    expect((redelivered.content as Array<{ text: string }>)[0]!.text).toContain('Unread continuation');
    const replyB = await clientB.callTool({ name: 'reply_message', arguments: { sessionId: MAIN_ID, content: 'new owner ack' } });
    expect(replyB.isError).not.toBe(true);
    expect(readdirSync(join(rr, 'processing', MAIN_ID)).filter((name) => name.endsWith('.json'))).toEqual([]);
    expect(new RrFileStore(rr).getHistory(MAIN_ID).filter((message) => message.content === 'new owner ack')).toHaveLength(1);

    await clientA.close();
    await clientB.close();
    await serverA.close();
    await serverB.close();
  });

  it('revalidates a resume lease before an in-flight waiter can claim after takeover', async () => {
    const source = makeFixture();
    const rr = mkdtempSync(join(tmpdir(), 'rr-resume-active-wait-race-'));
    roots.push(source, rr);
    importXjToRr(planXjImport(source, rr));
    rmSync(join(rr, 'inbox', MAIN_ID), { recursive: true, force: true });
    mkdirSync(join(rr, 'inbox', MAIN_ID), { recursive: true });

    const storeA = new RrFileStore(rr, { offlineAfterMs: Number.MAX_SAFE_INTEGER, resumeLeaseMs: 5_000 });
    const storeB = new RrFileStore(rr, { offlineAfterMs: Number.MAX_SAFE_INTEGER, resumeLeaseMs: 5_000 });
    storeA.register({ name: 'continue' }, 'owner-a');
    const controller = new AbortController();
    const waitingA = storeA.waitMessage(MAIN_ID, 10_000, controller.signal, 'owner-a');
    const leasePath = join(rr, 'resume-leases', `${MAIN_ID}.json`);
    const expired = JSON.parse(readFileSync(leasePath, 'utf8'));
    expired.expiresAt = 0;
    writeJson(leasePath, expired);
    storeB.register({ name: 'continue' }, 'owner-b');
    storeB.enqueueUserMessage(MAIN_ID, 'takeover-only-message');

    await expect(waitingA).rejects.toThrow(/resume_session_(?:not_owner|lease_expired)/);
    expect(storeB.claimAvailableMessageForOwner(MAIN_ID, 'owner-b')?.content).toBe('takeover-only-message');
    controller.abort();
  });
});
