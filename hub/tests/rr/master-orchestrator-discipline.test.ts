import { describe, expect, it } from 'vitest';
import {
  buildInitialInjectPrompt,
  buildTickInjectPrompt,
} from '../../src/rr/afk-service.js';
import {
  buildSoloMasterOrchestratorLines,
  buildSubagentDispatchContent,
  classifyDispatchKind,
} from '../../src/rr/afk/master-orchestrator-discipline.js';
import { planNextAction } from '../../src/rr/orchestrator/planner.js';
import { defaultState } from '../../src/rr/orchestrator/state.js';
import type { OrchestratorConfig } from '../../src/rr/orchestrator/types.js';
import type { RrAfkSummary } from '../../src/rr/afk/types.js';

describe('solo master orchestrator discipline', () => {
  const baseSummary: RrAfkSummary = {
    task_id: 'solo-task',
    status: 'READY',
    master_session_id: 'master-1',
    project_root: '/tmp/proj',
    current_unit: null,
    plan_revision: 0,
    loop: 0,
    max_loops: 40,
    allowlist: [],
    permission_request: null,
    last_command: null,
    last_verification: null,
    human_action_hint: null,
    updated_at: new Date().toISOString(),
    mode: 'solo',
  };

  it('inject prompts include master-orchestrator-only rules for solo', () => {
    const initial = buildInitialInjectPrompt({
      taskId: 'solo-task',
      projectRoot: '/tmp/proj',
      summary: baseSummary,
      nextTodo: '实现登录 API',
      criteria: ['npm test'],
      mode: 'solo',
    });
    expect(initial).toContain('禁止亲自读/写仓库源代码');
    expect(initial).toContain('dispatch_subagent_task');

    const tick = buildTickInjectPrompt({
      taskId: 'solo-task',
      projectRoot: '/tmp/proj',
      summary: baseSummary,
      nextTodo: '补测试',
      criteria: ['npm test'],
    });
    expect(tick).toContain('禁止亲自读/写仓库源代码');
  });

  it('classifies implement vs research dispatch', () => {
    expect(classifyDispatchKind('调研 auth 模块')).toBe('research');
    expect(classifyDispatchKind('实现登录 API')).toBe('implement');
    expect(buildSubagentDispatchContent({
      task: '实现登录 API',
      projectRoot: '/tmp/proj',
      kind: 'implement',
    })).toContain('【子 Agent · 实现/改码】');
  });

  it('planner auto-dispatches implement todos in solo mode', () => {
    const config: OrchestratorConfig = {
      hubUrl: 'http://127.0.0.1:8040',
      projectRoot: '/tmp/proj',
      masterSessionId: null,
      masterSessionName: null,
      afkRoot: '/tmp/afk',
      pollIntervalMs: 5_000,
      idleInjectDelayMs: 1_000,
      offlineWakeDelayMs: 2_000,
      maxInjectionsPerHour: 120,
      maxLoops: 40,
      autoDispatchSubagents: true,
      loopBridge: false,
      loopSentinelPrefix: 'RR_ORCH_TICK',
      todoPaths: ['TODO.md'],
      criteriaPaths: ['CRITERIA.md'],
      verifyCommands: [],
      injectPrefix: '【测试】',
      statePath: '/tmp/state.json',
      logPath: '/tmp/events.jsonl',
    };

    const action = planNextAction({
      config,
      state: defaultState(),
      afk: {
        active: true,
        paused: false,
        done: false,
        taskDir: '/tmp/afk/tasks/solo-task',
        criteriaText: '- npm test\n',
        todoText: '- [ ] 实现登录 API\n',
        maxLoops: 40,
        primarySummary: baseSummary,
        taskId: 'solo-task',
        source: 'rr-afk',
      },
      session: {
        sessionId: 'master-1',
        name: 'Master',
        launchId: 'launch-1',
        role: 'general-purpose',
        isSubagent: false,
        waiting: true,
        status: 'waiting',
        online: true,
        lastActiveAt: Date.now() - 5_000,
        pendingMessages: 0,
      },
      history: [],
      subagents: [{
        sessionId: 'sub-1',
        name: 'Sub',
        availability: 'idle',
        online: true,
        status: 'waiting',
        waiting: true,
        isSubagent: true,
        lastActiveAt: Date.now(),
      }],
    }, Date.now());

    expect(action.kind).toBe('dispatch');
    if (action.kind === 'dispatch') {
      expect(action.content).toContain('实现登录 API');
      expect(action.content).toContain('【子 Agent · 实现/改码】');
    }
  });

  it('exports non-empty orchestrator lines', () => {
    expect(buildSoloMasterOrchestratorLines().join('\n')).toMatch(/禁止亲自读/);
  });
});
