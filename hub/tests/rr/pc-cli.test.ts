import { describe, expect, it, vi } from 'vitest';
import {
  buildHeartbeatSpec,
  buildLoopPrompt,
  joinHubPath,
  resolveAfkCall,
  resolveHubUrl,
  runPcCli,
  usageText,
} from '../../src/pc-cli.js';

describe('pc cli', () => {
  it('prints usage help text', () => {
    expect(usageText()).toContain('--task-slug SLUG');
    expect(usageText()).toContain('--session-id ID');
    expect(usageText()).toContain('--no-spawn');
    expect(usageText()).toContain('heartbeat-spec');
    expect(usageText()).toContain('PC_HUB_URL');
  });

  it('resolves hub url from PC_HUB_URL', () => {
    expect(resolveHubUrl({ PC_HUB_URL: 'http://127.0.0.1:9000/' })).toBe('http://127.0.0.1:9000');
    expect(resolveHubUrl({})).toBe('http://127.0.0.1:8040');
  });

  it('builds one-click start call with bind-self flags', () => {
    expect(resolveAfkCall('start', [
      '--session-id', 'sess-bind',
      '--no-spawn',
      '--task-slug', 'fleet-task',
      '--mode', 'solo',
      '--no-orchestrator',
    ])).toEqual({
      method: 'POST',
      path: '/api/ui/rr/afk/one-click',
      body: {
        spawnIfNeeded: false,
        startOrchestrator: false,
        sessionId: 'sess-bind',
        taskSlug: 'fleet-task',
        mode: 'solo',
      },
    });
  });

  it('builds one-click start call', () => {
    expect(resolveAfkCall('start', ['--task-slug', 'my-task', '--project', '/tmp/proj', '--force', '--no-orchestrator'])).toEqual({
      method: 'POST',
      path: '/api/ui/rr/afk/one-click',
      body: {
        spawnIfNeeded: true,
        startOrchestrator: false,
        taskSlug: 'my-task',
        projectRoot: '/tmp/proj',
        force: true,
      },
    });
  });

  it('builds one-click start call with --mode go', () => {
    expect(resolveAfkCall('start', ['--task-slug', 'go-task', '--mode', 'go', '--no-orchestrator'])).toEqual({
      method: 'POST',
      path: '/api/ui/rr/afk/one-click',
      body: {
        spawnIfNeeded: true,
        startOrchestrator: false,
        taskSlug: 'go-task',
        mode: 'go',
      },
    });
  });

  it('builds status, summary, pause, resume, tick calls', () => {
    expect(resolveAfkCall('status', ['--project', '/tmp/proj', '--json'])).toEqual({
      method: 'GET',
      path: '/api/ui/rr/afk/status?projectRoot=%2Ftmp%2Fproj',
    });
    expect(resolveAfkCall('summary', [])).toEqual({
      method: 'GET',
      path: '/api/ui/rr/afk/summary',
    });
    expect(resolveAfkCall('pause', ['task-1'])).toEqual({
      method: 'POST',
      path: '/api/ui/rr/afk/pause',
      body: { taskId: 'task-1' },
    });
    expect(resolveAfkCall('resume', [])).toEqual({
      method: 'POST',
      path: '/api/ui/rr/afk/resume',
      body: {},
    });
    expect(resolveAfkCall('done', ['task-1'])).toEqual({
      method: 'POST',
      path: '/api/ui/rr/afk/done',
      body: { taskId: 'task-1' },
    });
    expect(resolveAfkCall('tick', ['--task-id', 'task-1'])).toEqual({
      method: 'POST',
      path: '/api/ui/rr/afk/tick',
      body: { taskId: 'task-1' },
    });
  });

  it('builds inject, grant, heartbeat, report, halt calls', () => {
    expect(resolveAfkCall('inject', ['sess-1', 'hello', 'world'])).toEqual({
      method: 'POST',
      path: '/api/ui/rr/sessions/sess-1/messages',
      body: { content: 'hello world' },
    });
    expect(resolveAfkCall('grant', ['--task', 'task-1', '--path', 'a.ts', '--path', 'b.ts', '--confirmed'])).toEqual({
      method: 'POST',
      path: '/api/ui/rr/afk/task-1/grant-temporary-paths',
      body: { paths: ['a.ts', 'b.ts'], confirmed: true },
    });
    expect(resolveAfkCall('set-heartbeat', ['--task', 'task-1', '--automation-id', 'auto-9'])).toEqual({
      method: 'POST',
      path: '/api/ui/rr/afk/set-heartbeat',
      body: { taskId: 'task-1', automationId: 'auto-9' },
    });
    expect(resolveAfkCall('report', [])).toEqual({
      method: 'GET',
      path: '/api/ui/rr/afk/report',
    });
    expect(resolveAfkCall('halt', [])).toEqual({
      method: 'POST',
      path: '/api/ui/rr/afk/orchestrator/halt',
    });
  });

  it('prints heartbeat-spec and loop-prompt without fetch', async () => {
    const fetchFn = vi.fn();
    const lines: string[] = [];

    const heartbeatCode = await runPcCli(['afk', 'heartbeat-spec', '--task-id', 'task-1'], {
      stdout: (line) => lines.push(line),
      fetchFn,
    });
    expect(heartbeatCode).toBe(0);
    expect(fetchFn).not.toHaveBeenCalled();
    expect(lines.join('\n')).toContain('pc afk tick --task-id task-1');

    lines.length = 0;
    const loopCode = await runPcCli(['afk', 'loop-prompt'], {
      stdout: (line) => lines.push(line),
      fetchFn,
    });
    expect(loopCode).toBe(0);
    expect(lines.join('\n')).toContain('RR_ORCH_TICK');
  });

  it('calls hub with mocked fetch for start and status', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchFn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      return new Response(JSON.stringify({ ok: true, active: true, taskId: 'task-1', loopCount: 2, todo: { pending: 1, done: 2 } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });

    const hubUrl = 'http://127.0.0.1:8040';
    const startCode = await runPcCli(['afk', 'start', '--task-slug', 'solo'], {
      hubUrl,
      fetchFn,
      stdout: () => undefined,
    });
    expect(startCode).toBe(0);
    expect(calls[0]).toEqual({
      url: joinHubPath(hubUrl, '/api/ui/rr/afk/one-click'),
      init: {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          spawnIfNeeded: true,
          startOrchestrator: true,
          taskSlug: 'solo',
        }),
      },
    });

    const humanLines: string[] = [];
    const statusCode = await runPcCli(['afk', 'status'], {
      hubUrl,
      fetchFn,
      stdout: (line) => humanLines.push(line),
    });
    expect(statusCode).toBe(0);
    expect(calls[1]?.url).toBe(joinHubPath(hubUrl, '/api/ui/rr/afk/status'));
    expect(humanLines.join('\n')).toContain('active: true');
    expect(humanLines.join('\n')).toContain('taskId: task-1');
  });

  it('prints all activeTasks in human status output', async () => {
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({
      ok: true,
      active: true,
      taskId: 'task-a',
      loopCount: 2,
      todo: { pending: 1, done: 2 },
      orchestrator: { running: true },
      activeTasks: [
        {
          taskId: 'task-a',
          masterSessionId: 'sess-a',
          status: 'RUNNING',
          loopCount: 2,
          maxLoops: 40,
          paused: false,
          done: false,
          projectRoot: '/tmp/a',
        },
        {
          taskId: 'task-b',
          masterSessionId: 'sess-b',
          status: 'READY',
          loopCount: 0,
          maxLoops: 40,
          paused: false,
          done: false,
          projectRoot: '/tmp/b',
        },
      ],
      index: { active_tasks: ['task-a', 'task-b'], updated_at: '2026-07-30T00:00:00.000Z' },
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));

    const humanLines: string[] = [];
    const statusCode = await runPcCli(['afk', 'status'], {
      fetchFn,
      stdout: (line) => humanLines.push(line),
    });
    expect(statusCode).toBe(0);
    const output = humanLines.join('\n');
    expect(output).toContain('activeTasks (2):');
    expect(output).toContain('task-a');
    expect(output).toContain('task-b');
    expect(output).toContain('master=sess-a');
    expect(output).toContain('master=sess-b');
  });

  it('exports fixed prompt helpers', () => {
    expect(buildHeartbeatSpec()).toContain('pc afk tick');
    expect(buildHeartbeatSpec('abc')).toContain('--task-id abc');
    expect(buildLoopPrompt()).toContain('pc afk tick');
  });
});
