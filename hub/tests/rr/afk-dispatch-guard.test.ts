import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  AFK_MODE_GO_FORBIDS_DISPATCH,
  AFK_MODE_GO_FORBIDS_LIST_SUBAGENTS,
  assertCanDispatchSubagent,
  assertCanListSubagents,
  effectiveAllowNewSubagents,
} from '../../src/rr/afk/dispatch-guard.js';
import { initTaskArtifacts, writeState } from '../../src/rr/afk/store.js';
import { createRrMcpServer } from '../../src/rr/mcp-server.js';
import { RrFileStore } from '../../src/rr/store.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

describe('AFK dispatch guard (Phase-4)', () => {
  const roots: string[] = [];
  const prevAfkRoot = process.env.RR_AFK_ROOT;

  beforeEach(() => {
    const root = mkdtempSync(join(tmpdir(), 'rr-afk-guard-'));
    roots.push(root);
    process.env.RR_AFK_ROOT = root;
  });

  afterEach(() => {
    if (prevAfkRoot === undefined) delete process.env.RR_AFK_ROOT;
    else process.env.RR_AFK_ROOT = prevAfkRoot;
    roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }));
  });

  it('effectiveAllowNewSubagents: go always false; solo follows global', () => {
    expect(effectiveAllowNewSubagents({ mode: 'go' }, true)).toBe(false);
    expect(effectiveAllowNewSubagents({ mode: 'go', allow_new_subagents: true }, true)).toBe(false);
    expect(effectiveAllowNewSubagents({ mode: 'solo' }, true)).toBe(true);
    expect(effectiveAllowNewSubagents({ mode: 'solo' }, false)).toBe(false);
    expect(effectiveAllowNewSubagents({ mode: 'start', allow_new_subagents: false }, true)).toBe(false);
  });

  it('assertCanDispatchSubagent rejects mode=go masters (P4-C2)', () => {
    const artifacts = initTaskArtifacts({
      taskId: 'guard-go',
      projectRoot: process.env.RR_AFK_ROOT!,
      masterSessionId: 'master-1',
      mode: 'go',
      activate: true,
    });
    writeState('guard-go', {
      ...artifacts.state,
      mode: 'go',
      allow_new_subagents: false,
      updated_at: new Date().toISOString(),
    });

    expect(() => assertCanDispatchSubagent({ sessionId: 'master-1', afkTaskId: 'guard-go' }))
      .toThrow(AFK_MODE_GO_FORBIDS_DISPATCH);
    expect(() => assertCanListSubagents({ sessionId: 'master-1', afkTaskId: 'guard-go' }))
      .toThrow(AFK_MODE_GO_FORBIDS_LIST_SUBAGENTS);
  });

  it('assertCanDispatchSubagent allows solo masters (P4-C4)', () => {
    initTaskArtifacts({
      taskId: 'guard-solo',
      projectRoot: process.env.RR_AFK_ROOT!,
      masterSessionId: 'master-2',
      mode: 'solo',
      activate: true,
    });
    expect(() => assertCanDispatchSubagent({ sessionId: 'master-2', afkTaskId: 'guard-solo' }))
      .not.toThrow();
  });

  it('MCP dispatch_subagent_task hard-rejects go sessions', async () => {
    const storeRoot = mkdtempSync(join(tmpdir(), 'rr-mcp-go-'));
    roots.push(storeRoot);
    const store = new RrFileStore(storeRoot);
    const main = store.register({ name: 'Main' }).session;
    store.updateSession(main.sessionId, { afkTaskId: 'mcp-go' });
    const child = store.register({ name: 'Child' }).session;
    store.setSubagent(child.sessionId, true);

    const artifacts = initTaskArtifacts({
      taskId: 'mcp-go',
      projectRoot: process.env.RR_AFK_ROOT!,
      masterSessionId: main.sessionId,
      mode: 'go',
      activate: true,
    });
    writeState('mcp-go', {
      ...artifacts.state,
      mode: 'go',
      allow_new_subagents: false,
      master_session_id: main.sessionId,
      updated_at: new Date().toISOString(),
    });

    const server = createRrMcpServer(store);
    const client = new Client({ name: 'rr-test', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    const dispatched = await client.callTool({
      name: 'dispatch_subagent_task',
      arguments: {
        sessionId: main.sessionId,
        targetSessionId: child.sessionId,
        content: 'forbidden under go',
      },
    });
    expect(dispatched.isError).toBe(true);
    const text = (dispatched.content as Array<{ text: string }>)[0]!.text;
    expect(text).toContain(AFK_MODE_GO_FORBIDS_DISPATCH);

    await client.close();
    await server.close();
  });
});
