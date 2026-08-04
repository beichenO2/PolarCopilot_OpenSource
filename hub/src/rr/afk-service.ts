import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import {
  appendEvent,
  initTaskArtifacts,
  listTaskSummaries,
  markTaskDone,
  migrateLegacyFlagsIfNeeded,
  pauseAll,
  pauseTask,
  readIndex,
  readState,
  readSummary,
  resumeTask,
  activateTaskWithAdmissionCap,
  setTaskActive,
  taskDir as afkTaskDir,
  writeState,
} from './afk/index.js';
import type { RrAfkMode, RrAfkSummary, RrAfkTaskIndex } from './afk/types.js';
import { completeViaGate } from './afk/vnext/bridge.js';
import { canSpawnAgent } from './afk/budget-gate.js';
import {
  buildSoloMasterOrchestratorLines,
  buildSoloMasterReplyFormat,
  isSoloMasterOrchestratorMode,
} from './afk/master-orchestrator-discipline.js';
import { grantTemporaryPaths, type RrAfkGrantResult } from './afk/grant.js';
import { releasePolarBudgetLease, fetchPolarBudget, resolveAfkAdmissionCap } from './polar-budget.js';
import { parseCriteriaSummary, parseTodoItems, readAfkSnapshot } from './orchestrator/afk-state.js';
import { globalConfigPath, loadConfig, patchGlobalConfig } from './orchestrator/config.js';
import { readOrchestratorHealth } from './orchestrator/health.js';
import { resolveInjectFanOutCap } from './orchestrator/runner.js';
import {
  haltOrchestratorService,
  readOrchestratorServiceState,
  startOrchestratorService,
} from './orchestrator/polar-service.js';
import { loadState } from './orchestrator/state.js';
import type { RrFileStore } from './store.js';
import type { RrSession } from './types.js';

export { grantTemporaryPaths, type RrAfkGrantResult };
export type { RrAfkMode };

export interface RrAfkArmInput {
  taskDir?: string;
  taskSlug?: string;
  maxLoops?: number;
  force?: boolean;
  projectRoot?: string;
  masterSessionId?: string;
}

export interface RrAfkOneClickInput extends RrAfkArmInput {
  sessionId?: string;
  spawnIfNeeded?: boolean;
  startOrchestrator?: boolean;
  workspace?: string;
  headless?: boolean;
  waitUntilOnline?: boolean;
  mode?: RrAfkMode | string;
}

export interface RrAfkSpawnEnqueue {
  (
    session: RrSession,
    options?: {
      workspace?: string;
      headless?: boolean;
      waitUntilOnline?: boolean;
      label?: string;
    },
  ): Promise<unknown>;
}

export interface RrAfkServiceDeps {
  spawnEnqueue?: RrAfkSpawnEnqueue;
}

export interface RrAfkTodoProgress {
  total: number;
  pending: number;
  done: number;
  pendingItems: string[];
}

export interface RrAfkArmedResult {
  taskId: string;
  taskDir: string;
  maxLoops: number;
  masterSessionId: string;
  activated: boolean;
}

export interface RrAfkActiveTaskStatus {
  taskId: string;
  masterSessionId: string | null;
  status: RrAfkSummary['status'];
  loopCount: number;
  maxLoops: number;
  paused: boolean;
  done: boolean;
  mode?: RrAfkMode;
  projectRoot: string;
}

export interface RrAfkStatus {
  ok: boolean;
  active: boolean;
  paused: boolean;
  done: boolean;
  maxLoops: number;
  loopCount: number;
  taskDir: string | null;
  taskId: string | null;
  /** All concurrently active AFK tasks with dedicated master bindings */
  activeTasks: RrAfkActiveTaskStatus[];
  todo: RrAfkTodoProgress;
  criteria: { count: number; summary: string[] };
  orchestrator: {
    enabled: boolean;
    running: boolean;
    serviceStatus: string | null;
    masterSessionId: string | null;
    lastAction: string | null;
    lastInjectAt: number | null;
    lastSessionId: string | null;
  };
  projectRoot: string;
  health: ReturnType<typeof readOrchestratorHealth>;
  summaries: RrAfkSummary[];
  index: RrAfkTaskIndex;
}

export interface RrAfkDecisionsReportItem {
  taskId: string;
  excerpt: string;
  lineCount: number;
}

const INITIAL_INJECT_PREFIX = '【Rr AFK · 首条注入】';
const TICK_INJECT_PREFIX = '【Rr AFK · 续跑】';

function countTodoProgress(todoText: string | null): RrAfkTodoProgress {
  if (!todoText) {
    return { total: 0, pending: 0, done: 0, pendingItems: [] };
  }
  const lines = todoText.split('\n').map((line) => line.trim());
  const pendingItems = parseTodoItems(todoText);
  const pending = pendingItems.length;
  const done = lines.filter((line) => /^[-*]\s+\[x\]/i.test(line)).length;
  return {
    total: pending + done,
    pending,
    done,
    pendingItems: pendingItems.slice(0, 8),
  };
}

function resolveTaskId(input: RrAfkArmInput): string {
  if (input.taskSlug?.trim()) return input.taskSlug.trim();
  if (input.taskDir?.trim()) return basename(input.taskDir.trim());
  return `afk-${Date.now().toString(36)}`;
}

async function resolveAdmissionCap(): Promise<number> {
  const budget = await fetchPolarBudget();
  return resolveAfkAdmissionCap(budget);
}

function readTaskArtifact(taskId: string, name: string): string | null {
  const path = join(afkTaskDir(taskId), name);
  if (!existsSync(path)) return null;
  return readFileSync(path, 'utf8');
}

function primaryActiveSummary(summaries: RrAfkSummary[], index: RrAfkTaskIndex): RrAfkSummary | null {
  for (const taskId of index.active_tasks) {
    const match = summaries.find((item) => item.task_id === taskId);
    if (match) return match;
  }
  return summaries[0] ?? null;
}

function buildStatusMachineLines(): string[] {
  return [
    '## 状态机',
    'PLANNING → READY → RUNNING → UNIT_DONE → READY_TO_MERGE → DONE',
    '任意阶段可转 PAUSED / NEEDS_HUMAN / BLOCKED；NEEDS_HUMAN 等待人工 grant 后回到 READY。',
  ];
}

function buildDecisionsDiscipline(): string[] {
  return [
    '## DECISIONS 纪律',
    '- 非显然选择写入 tasks/<taskId>/DECISIONS.md（时间 + 单元 + 决策 + 理由）。',
    '- 不要重复 survey；每轮必须有可验证产物变化。',
  ];
}

function buildReplyFormat(mode?: RrAfkMode): string[] {
  if (isSoloMasterOrchestratorMode(mode)) {
    return buildSoloMasterReplyFormat();
  }
  return [
    '## reply 格式（每单元）',
    '1. 状态一行（含 taskId / unit / status）',
    '2. 本轮命令与关键改动',
    '3. 验证输出（无法验证标 NOT RUN）',
    '4. 下一单元计划',
    '5. reply_message 后立刻 wait_message',
  ];
}

/**
 * Normalize AFK mode from CLI/API input.
 * Default is `solo` to preserve historical one-click AFK unattended behavior
 * (never-ask, loop until done) when callers omit `--mode`.
 */
export function normalizeAfkMode(raw?: string | null): RrAfkMode {
  if (!raw || !raw.trim()) return 'solo';
  const normalized = raw.trim().toLowerCase();
  if (normalized === 'start' || normalized === 'solo' || normalized === 'go') {
    return normalized;
  }
  throw new Error(`invalid_afk_mode:${raw}`);
}

/**
 * Task-scoped mode side-effects (Phase-4).
 * Go must NOT patch global allowNewSubagents — that stomps parallel solo/start tasks.
 * Returns fields to persist on state/summary instead.
 */
export function applyAfkModeConfig(mode: RrAfkMode): { allow_new_subagents?: boolean } {
  if (mode === 'go') {
    return { allow_new_subagents: false };
  }
  return {};
}

function buildModeSection(mode: RrAfkMode): string[] {
  switch (mode) {
    case 'go':
      return [
        '## Mode=go（单主 · 无限 MCP · 禁止 Subagent）',
        '- 本任务 Mode=go：禁止 list_subagents / dispatch_subagent_task；不得开子 Agent 池。',
        '- spawn subCount=0；仅单主会话完成全部工作。',
        '- 无限 MCP：reply_message 后立刻 wait_message；KEEPALIVE/POLL_TICK 不是停止信号。',
        '- 全程使用原 sessionId；禁止裸 register_session 新建重复 tab。',
        '- 断线恢复：直接 wait_message(原 sessionId)，不要重新 register。',
      ];
    case 'solo':
      return [
        '## Mode=solo（无人值守 · never-ask · 主会话纯编排）',
        '- 本任务 Mode=solo：不向用户提问；缺口按业内最优自决并写入 DECISIONS.md。',
        '- Subagent 遵循面板 allowNewSubagents 与 PolarBudget；可 dispatch 已打开「子 Agent」开关的 idle 会话。',
        ...buildSoloMasterOrchestratorLines(),
      ];
    case 'start':
      return [
        '## Mode=start（协作立项）',
        '- 本任务 Mode=start：可与用户商讨范围/判据/授权；方案级分歧优先回访。',
        '- Subagent 策略由商讨决定；遵循面板 allowNewSubagents 与 PolarBudget。',
      ];
  }
}

export function buildInitialInjectPrompt(input: {
  taskId: string;
  projectRoot: string;
  summary: RrAfkSummary;
  nextTodo: string | null;
  criteria: string[];
  mode?: RrAfkMode;
}): string {
  const mode = input.mode ?? input.summary.mode ?? 'solo';
  const lines = [
    INITIAL_INJECT_PREFIX,
    '',
    `taskId: ${input.taskId}`,
    `projectRoot: ${input.projectRoot}`,
    `status: ${input.summary.status}`,
    `current_unit: ${input.summary.current_unit ?? '(unset)'}`,
    '',
    ...buildModeSection(mode),
    '',
    ...buildStatusMachineLines(),
    '',
    '## 当前 allowlist',
    ...(input.summary.allowlist.length > 0
      ? input.summary.allowlist.map((path) => `- ${path}`)
      : ['- (empty — stay within repo defaults)']),
    '',
    ...buildDecisionsDiscipline(),
    '',
    ...buildReplyFormat(mode),
  ];
  if (input.nextTodo) {
    lines.push('', '## 本轮首选原子任务', input.nextTodo);
  }
  if (input.criteria.length > 0) {
    lines.push('', '## 验收判据（摘要）', ...input.criteria.map((line) => `- ${line}`));
  }
  return lines.join('\n');
}

export function buildTickInjectPrompt(input: {
  taskId: string;
  projectRoot: string;
  summary: RrAfkSummary;
  nextTodo: string | null;
  criteria: string[];
  reason?: string;
}): string {
  const mode = input.summary.mode ?? 'solo';
  const lines = [
    TICK_INJECT_PREFIX,
    '',
    `taskId: ${input.taskId}`,
    `projectRoot: ${input.projectRoot}`,
    `status: ${input.summary.status}`,
    `unit: ${input.summary.current_unit ?? '(unset)'}`,
    `loop: ${input.summary.loop}`,
    `plan_revision: ${input.summary.plan_revision}`,
    ...(input.reason ? [`trigger: ${input.reason}`] : []),
    '',
    ...(isSoloMasterOrchestratorMode(mode) ? buildSoloMasterOrchestratorLines() : []),
    '',
    ...buildStatusMachineLines(),
    '',
    '## allowlist',
    ...(input.summary.allowlist.length > 0
      ? input.summary.allowlist.map((path) => `- ${path}`)
      : ['- (empty)']),
    '',
    ...buildDecisionsDiscipline(),
    '',
    ...buildReplyFormat(mode),
  ];
  if (input.nextTodo) {
    lines.push('', '## 本轮首选原子任务', input.nextTodo);
  }
  if (input.criteria.length > 0) {
    lines.push('', '## 验收判据（摘要）', ...input.criteria.map((line) => `- ${line}`));
  }
  return lines.join('\n');
}

export function pickMasterSession(sessions: RrSession[], preferredId?: string | null, taskId?: string): RrSession | null {
  const masters = sessions.filter((session) => !session.isSubagent);

  const boundToOther = (session: RrSession): boolean =>
    Boolean(taskId && session.afkTaskId && session.afkTaskId !== taskId);

  if (preferredId) {
    const preferred = masters.find((session) => session.sessionId === preferredId);
    if (preferred) {
      if (boundToOther(preferred)) return null;
      return preferred;
    }
  }

  const reusable = masters.filter((session) => !boundToOther(session) && (!session.afkTaskId || session.afkTaskId === taskId));
  const online = reusable
    .filter((session) => session.online || session.status === 'waiting')
    .sort((a, b) => b.lastActiveAt - a.lastActiveAt);
  if (online.length > 0) return online[0] ?? null;
  return reusable.sort((a, b) => b.lastActiveAt - a.lastActiveAt)[0] ?? null;
}

export interface RrAfkTickResult {
  taskId: string;
  sessionId: string;
  messageId: string;
}

function buildActiveTaskStatuses(summaries: RrAfkSummary[], index: ReturnType<typeof readIndex>): RrAfkActiveTaskStatus[] {
  return index.active_tasks.map((taskId) => {
    const summary = summaries.find((item) => item.task_id === taskId);
    const state = readState(taskId);
    const status = summary?.status ?? state?.status ?? 'PLANNING';
    return {
      taskId,
      masterSessionId: summary?.master_session_id ?? state?.master_session_id ?? null,
      status,
      loopCount: summary?.loop ?? state?.loop ?? 0,
      maxLoops: state?.max_loops ?? 40,
      paused: status === 'PAUSED',
      done: status === 'DONE',
      mode: summary?.mode ?? state?.mode,
      projectRoot: summary?.project_root ?? state?.project_root ?? '',
    };
  });
}

export async function readAfkStatus(projectRoot?: string): Promise<RrAfkStatus> {
  migrateLegacyFlagsIfNeeded();
  const config = loadConfig(projectRoot);
  const summaries = listTaskSummaries();
  const index = readIndex();
  const primary = primaryActiveSummary(summaries, index);

  const legacyAfk = readAfkSnapshot(config);
  const state = loadState(config.statePath);
  const health = readOrchestratorHealth(config.projectRoot);
  const service = await readOrchestratorServiceState();

  const taskId = primary?.task_id ?? null;
  const taskDirPath = taskId ? afkTaskDir(taskId) : legacyAfk.taskDir;
  const todoText = taskId ? readTaskArtifact(taskId, 'TODO.md') : legacyAfk.todoText;
  const criteriaText = taskId ? readTaskArtifact(taskId, 'CRITERIA.md') : legacyAfk.criteriaText;
  const criteriaSummary = parseCriteriaSummary(criteriaText);

  const activeFromIndex = index.active_tasks.length > 0;
  const primaryStatus = primary?.status;
  const legacyActive = legacyAfk.active && !legacyAfk.done && !legacyAfk.paused;
  const ssotActive = Boolean(primary && primaryStatus !== 'DONE' && primaryStatus !== 'PAUSED');
  const active = legacyActive || activeFromIndex || ssotActive;
  const paused = legacyAfk.paused || state.paused || primaryStatus === 'PAUSED';
  const done = legacyAfk.done || primaryStatus === 'DONE';
  const maxLoops = primary
    ? (readState(taskId!)?.max_loops ?? config.maxLoops)
    : legacyAfk.maxLoops;
  const loopCount = primary?.loop ?? state.loopCount;
  const activeTasks = buildActiveTaskStatuses(summaries, index);

  return {
    ok: health.ok && service.running,
    active,
    paused,
    done,
    maxLoops,
    loopCount,
    taskDir: taskDirPath,
    taskId,
    activeTasks,
    todo: countTodoProgress(todoText),
    criteria: { count: criteriaSummary.length, summary: criteriaSummary.slice(0, 6) },
    orchestrator: {
      enabled: service.enabled,
      running: service.running,
      serviceStatus: service.serviceStatus,
      masterSessionId: primary?.master_session_id ?? config.masterSessionId,
      lastAction: state.lastAction,
      lastInjectAt: state.lastInjectedAt,
      lastSessionId: state.lastSessionId,
    },
    projectRoot: config.projectRoot,
    health,
    summaries,
    index,
  };
}

/** Legacy arm path — kept for /afk/arm backward compatibility with flag files. */
export async function armAfk(input: RrAfkArmInput = {}): Promise<{
  armed: true;
  afkRoot: string;
  taskDir: string | null;
  maxLoops: number;
  masterSessionId: string | null;
}> {
  migrateLegacyFlagsIfNeeded();
  const resolvedTaskId = input.taskSlug?.trim()
    || (input.taskDir?.trim() ? basename(input.taskDir.trim()) : null);
  const admissionCap = resolvedTaskId ? await resolveAdmissionCap() : undefined;

  const config = loadConfig(input.projectRoot);
  const afkRoot = config.afkRoot;
  mkdirSync(afkRoot, { recursive: true, mode: 0o700 });

  const activePath = join(afkRoot, 'ACTIVE');
  const activeExists = existsSync(activePath);

  if (activeExists && !input.force) {
    if (!resolvedTaskId) {
      throw new Error('afk_already_active');
    }
    const index = readIndex();
    if (index.active_tasks.includes(resolvedTaskId)) {
      throw new Error('afk_already_active');
    }
  }

  for (const flag of ['PAUSE', 'DONE', 'ERROR_RETRY']) {
    rmSync(join(afkRoot, flag), { force: true });
  }

  const maxLoops = input.maxLoops ?? config.maxLoops ?? 40;
  writeFileSync(join(afkRoot, 'MAX_LOOPS'), `${maxLoops}\n`, 'utf8');

  let resolvedTaskDir: string | null = null;
  if (input.taskDir) resolvedTaskDir = input.taskDir;
  else if (input.taskSlug) resolvedTaskDir = join(afkRoot, input.taskSlug);
  else resolvedTaskDir = readAfkSnapshot(config).taskDir;

  if (resolvedTaskId && (readState(resolvedTaskId) || existsSync(afkTaskDir(resolvedTaskId)))) {
    if (admissionCap !== undefined) {
      const admission = activateTaskWithAdmissionCap(resolvedTaskId, admissionCap, input.force);
      if (!admission.ok) throw new Error(admission.reason);
    } else {
      setTaskActive(resolvedTaskId, true);
    }
  }

  const indexAfter = readIndex();
  if (indexAfter.active_tasks.length > 0 || !activeExists || input.force) {
    writeFileSync(activePath, '', 'utf8');
  }

  if (resolvedTaskDir && existsSync(resolvedTaskDir)) {
    const currentLink = join(afkRoot, 'current');
    rmSync(currentLink, { recursive: true, force: true });
    try {
      symlinkSync(resolvedTaskDir, currentLink);
    } catch {
      // best-effort
    }
  } else if (indexAfter.active_tasks.length > 0) {
    const primaryId = indexAfter.active_tasks[0]!;
    const primaryDir = afkTaskDir(primaryId);
    if (existsSync(primaryDir)) {
      const currentLink = join(afkRoot, 'current');
      rmSync(currentLink, { recursive: true, force: true });
      try {
        symlinkSync(primaryDir, currentLink);
      } catch {
        // best-effort
      }
    }
  }

  const masterSessionId = input.masterSessionId ?? null;
  if (masterSessionId && resolvedTaskId) {
    const existing = readState(resolvedTaskId);
    if (existing) {
      writeState(resolvedTaskId, {
        ...existing,
        master_session_id: masterSessionId,
        updated_at: new Date().toISOString(),
      });
    }
  }
  // Per-task master binding lives in task state — do not overwrite global masterSessionId (mirror oneClick).

  return {
    armed: true,
    afkRoot,
    taskDir: resolvedTaskDir && existsSync(resolvedTaskDir) ? resolvedTaskDir : null,
    maxLoops,
    masterSessionId,
  };
}

export function configureMasterSession(sessionId: string, projectRoot?: string): string {
  patchGlobalConfig({
    masterSessionId: sessionId,
    ...(projectRoot ? { projectRoot } : {}),
  });
  return sessionId;
}

async function ensureMasterSession(
  store: RrFileStore,
  input: RrAfkOneClickInput,
  deps: RrAfkServiceDeps,
  taskId: string,
): Promise<RrSession> {
  const sessions = store.listSessions();
  const preferredId = input.sessionId ?? input.masterSessionId ?? null;
  // Explicit sessionId that does not exist must not fall back to "any master" when
  // spawn is disabled — otherwise live smoke / mis-aimed one-click can arm AFK on
  // an unrelated session.
  if (preferredId && input.spawnIfNeeded === false) {
    const exact = sessions.find((session) => !session.isSubagent && session.sessionId === preferredId);
    if (!exact) throw new Error('no_master_session');
    if (exact.afkTaskId && exact.afkTaskId !== taskId) {
      throw new Error('session_bound_to_other_task');
    }
    return exact;
  }

  const boundMaster = pickMasterSession(sessions, preferredId, taskId);
  if (boundMaster) {
    if (boundMaster.afkTaskId && boundMaster.afkTaskId !== taskId) {
      throw new Error('session_bound_to_other_task');
    }
    return boundMaster;
  }

  if (preferredId) throw new Error('no_master_session');

  if (input.spawnIfNeeded === false) throw new Error('no_master_session');

  const gate = await canSpawnAgent({
    estimatedJobs: 1,
    acquireLease: true,
    waitForLeaseMs: Number(process.env.RR_BUDGET_WAIT_MS ?? 1_800_000),
    owner: `rr-afk-spawn:${taskId}`,
  });
  if (!gate.allowed) {
    throw new Error(`budget_spawn_deferred:${gate.reason}`);
  }

  const created = store.register({
    launchId: `rrlaunch-afk-${taskId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    name: `Rr Agent · AFK · ${taskId}`,
    role: 'general-purpose',
    afkTaskId: taskId,
  });
  const master = created.session;

  if (deps.spawnEnqueue) {
    try {
      await deps.spawnEnqueue(master, {
        workspace: input.workspace ?? input.projectRoot,
        headless: input.headless,
        waitUntilOnline: input.waitUntilOnline ?? false,
        label: master.name,
      });
    } finally {
      // Short lease: release once spawn is queued; orchestrator owns long-run capacity.
      if (gate.leaseId) {
        await releasePolarBudgetLease(gate.leaseId);
      }
    }
  } else if (gate.leaseId) {
    await releasePolarBudgetLease(gate.leaseId);
  }

  return master;
}

export async function oneClickAfk(
  store: RrFileStore,
  input: RrAfkOneClickInput = {},
  deps: RrAfkServiceDeps = {},
): Promise<{
  ok: true;
  sessionId: string;
  armed: RrAfkArmedResult;
  orchestrator: Awaited<ReturnType<typeof startOrchestratorService>>;
  status: RrAfkStatus;
}> {
  migrateLegacyFlagsIfNeeded();

  const projectRoot = input.projectRoot ?? loadConfig().projectRoot;
  const mode = normalizeAfkMode(input.mode);
  const taskId = resolveTaskId(input);
  const admissionCap = await resolveAdmissionCap();

  // Defer applyAfkModeConfig until master session is ready — avoid polluting
  // global allowNewSubagents/autoDispatch when spawn/budget fails mid-flight.
  const master = await ensureMasterSession(store, input, deps, taskId);

  store.updateSession(master.sessionId, { title: `AFK · ${taskId}`, afkTaskId: taskId });

  const artifacts = initTaskArtifacts({
    taskId,
    projectRoot,
    masterSessionId: master.sessionId,
    maxLoops: input.maxLoops,
    activate: true,
    admissionCap,
    admissionForce: input.force,
    mode,
  });

  // Per-task master binding lives in task state/summary — do not overwrite global masterSessionId
  // (would stomp parallel solo/start tasks sharing one orchestrator).

  const orchestrator = input.startOrchestrator === false
    ? {
      enabled: (await readOrchestratorServiceState()).enabled,
      polarprocess: null,
      running: (await readOrchestratorServiceState()).running,
    }
    : await startOrchestratorService();

  const modePolicy = applyAfkModeConfig(mode);

  const todoText = readTaskArtifact(taskId, 'TODO.md');
  const criteriaText = readTaskArtifact(taskId, 'CRITERIA.md');
  const nextTodo = parseTodoItems(todoText)[0] ?? null;
  const criteria = parseCriteriaSummary(criteriaText);

  const injectContent = buildInitialInjectPrompt({
    taskId,
    projectRoot,
    summary: artifacts.summary,
    nextTodo,
    criteria,
    mode,
  });
  store.enqueueUserMessage(master.sessionId, injectContent);
  appendEvent(taskId, { kind: 'initial_inject', detail: { sessionId: master.sessionId, mode } });

  writeState(taskId, {
    ...artifacts.state,
    status: 'READY',
    master_session_id: master.sessionId,
    mode,
    ...modePolicy,
    updated_at: new Date().toISOString(),
  });

  const status = await readAfkStatus(projectRoot);
  return {
    ok: true,
    sessionId: master.sessionId,
    armed: {
      taskId,
      taskDir: artifacts.taskDir,
      maxLoops: artifacts.state.max_loops,
      masterSessionId: master.sessionId,
      activated: true,
    },
    orchestrator,
    status,
  };
}

export function pauseAfk(taskId?: string): { paused: RrAfkSummary[]; index: RrAfkTaskIndex } {
  migrateLegacyFlagsIfNeeded();
  if (!taskId) {
    pauseAll();
    return { paused: listTaskSummaries().filter((item) => item.status === 'PAUSED'), index: readIndex() };
  }
  const state = pauseTask(taskId);
  if (!state) throw new Error('afk_task_not_found');
  return { paused: [readSummary(taskId)!], index: readIndex() };
}

export async function resumeAfk(
  taskId?: string,
  input: { force?: boolean } = {},
): Promise<{ resumed: RrAfkSummary[]; index: RrAfkTaskIndex }> {
  migrateLegacyFlagsIfNeeded();
  const admissionCap = await resolveAdmissionCap();
  const index = readIndex();
  const targets = taskId ? [taskId] : [...index.active_tasks];
  if (targets.length === 0) {
    const summaries = listTaskSummaries().filter((item) => item.status === 'PAUSED');
    if (summaries.length === 0) throw new Error('afk_task_not_found');
    targets.push(summaries[0]!.task_id);
  }

  const resumed: RrAfkSummary[] = [];
  for (const id of targets) {
    const state = resumeTask(id, { admissionCap, force: input.force });
    if (state) resumed.push(readSummary(id)!);
  }
  if (resumed.length === 0) throw new Error('afk_task_not_found');
  return { resumed, index: readIndex() };
}

export function doneAfk(
  taskId: string,
  opts?: { evidence?: { command: string; exitCode: number; salient: string } },
): { done: RrAfkSummary; index: RrAfkTaskIndex; gate: { required_total: number; required_pass: number } } {
  migrateLegacyFlagsIfNeeded();
  const existing = readState(taskId);
  if (!existing) throw new Error('afk_task_not_found');

  // Completion gate — never mark DONE without frozen criteria + evidence (vNext).
  const evidence =
    opts?.evidence ??
    (existing.last_verification &&
    typeof existing.last_verification === 'object' &&
    existing.last_verification !== null &&
    'exit_code' in (existing.last_verification as object)
      ? {
          command: String((existing.last_verification as { command?: string }).command ?? existing.last_command ?? 'verify'),
          exitCode: Number((existing.last_verification as { exit_code?: number }).exit_code ?? 1),
          salient: String((existing.last_verification as { salient?: string }).salient ?? ''),
        }
      : undefined);

  const { report } = completeViaGate(taskId, {
    projectRoot: existing.project_root,
    evidence,
  });

  const state = markTaskDone(taskId);
  if (!state) throw new Error('afk_task_not_found');
  const index = readIndex();
  if (index.active_tasks.length === 0) {
    const config = loadConfig();
    rmSync(join(config.afkRoot, 'ACTIVE'), { force: true });
    rmSync(join(config.afkRoot, 'DONE'), { force: true });
  }
  return {
    done: readSummary(taskId)!,
    index,
    gate: { required_total: report.required_total, required_pass: report.required_pass },
  };
}

export function setTaskHeartbeat(taskId: string, automationId: string): RrAfkSummary {
  const state = readState(taskId);
  if (!state) throw new Error('afk_task_not_found');
  writeState(taskId, {
    ...state,
    heartbeat: { automation_id: automationId },
    updated_at: new Date().toISOString(),
  });
  appendEvent(taskId, { kind: 'heartbeat_set', detail: { automationId } });
  return readSummary(taskId)!;
}

function tickOneTask(
  store: RrFileStore,
  summary: RrAfkSummary,
  reason: string,
): RrAfkTickResult {
  if (!summary.master_session_id) throw new Error('no_master_session');

  const projectRoot = summary.project_root ?? loadConfig().projectRoot;
  const todoText = readTaskArtifact(summary.task_id, 'TODO.md');
  const criteriaText = readTaskArtifact(summary.task_id, 'CRITERIA.md');
  const injectContent = buildTickInjectPrompt({
    taskId: summary.task_id,
    projectRoot,
    summary,
    nextTodo: parseTodoItems(todoText)[0] ?? null,
    criteria: parseCriteriaSummary(criteriaText),
    reason,
  });

  const message = store.enqueueUserMessage(summary.master_session_id, injectContent);
  appendEvent(summary.task_id, { kind: 'tick_inject', detail: { sessionId: summary.master_session_id, reason } });
  return { taskId: summary.task_id, sessionId: summary.master_session_id, messageId: message.msgId };
}

export async function tickAfk(
  store: RrFileStore,
  taskId?: string,
  reason = 'manual tick via Hub',
): Promise<RrAfkTickResult | { ticks: RrAfkTickResult[]; deferred?: string[] }> {
  migrateLegacyFlagsIfNeeded();
  const summaries = listTaskSummaries();
  const index = readIndex();

  if (taskId) {
    const summary = summaries.find((item) => item.task_id === taskId);
    if (!summary) throw new Error('afk_task_not_found');
    return tickOneTask(store, summary, reason);
  }

  let targetIds = index.active_tasks.length > 0
    ? index.active_tasks
    : (() => {
      const primary = primaryActiveSummary(summaries, index);
      return primary ? [primary.task_id] : [];
    })();

  if (targetIds.length > 1) {
    const budget = await fetchPolarBudget();
    const cap = resolveInjectFanOutCap(budget);
    targetIds = [...targetIds].sort((leftId, rightId) => {
      const left = summaries.find((item) => item.task_id === leftId);
      const right = summaries.find((item) => item.task_id === rightId);
      const leftAt = left?.updated_at ?? '';
      const rightAt = right?.updated_at ?? '';
      if (leftAt !== rightAt) return leftAt.localeCompare(rightAt);
      return leftId.localeCompare(rightId);
    });
    const deferred = targetIds.slice(cap);
    targetIds = targetIds.slice(0, cap);
    const ticks: RrAfkTickResult[] = [];
    for (const id of targetIds) {
      const summary = summaries.find((item) => item.task_id === id);
      if (!summary?.master_session_id) continue;
      ticks.push(tickOneTask(store, summary, reason));
    }
    if (ticks.length === 0) throw new Error('afk_task_not_found');
    if (ticks.length === 1 && deferred.length === 0) return ticks[0]!;
    return { ticks, ...(deferred.length > 0 ? { deferred } : {}) };
  }

  const ticks: RrAfkTickResult[] = [];
  for (const id of targetIds) {
    const summary = summaries.find((item) => item.task_id === id);
    if (!summary?.master_session_id) continue;
    ticks.push(tickOneTask(store, summary, reason));
  }
  if (ticks.length === 0) throw new Error('afk_task_not_found');
  if (ticks.length === 1) return ticks[0]!;
  return { ticks };
}

export function readDecisionsReport(limitPerTask = 12): RrAfkDecisionsReportItem[] {
  migrateLegacyFlagsIfNeeded();
  const items: RrAfkDecisionsReportItem[] = [];
  for (const summary of listTaskSummaries()) {
    const text = readTaskArtifact(summary.task_id, 'DECISIONS.md');
    if (!text) continue;
    const lines = text.split('\n').filter((line) => line.trim() && !line.startsWith('#'));
    if (lines.length === 0) continue;
    items.push({
      taskId: summary.task_id,
      excerpt: lines.slice(-limitPerTask).join('\n').slice(0, 1200),
      lineCount: lines.length,
    });
  }
  return items;
}

export async function startAfkOrchestrator() {
  return startOrchestratorService();
}

export async function haltAfkOrchestrator(): Promise<{
  enabled: boolean;
  polarprocess: unknown;
  running: boolean;
  paused: string[];
  index: RrAfkTaskIndex;
}> {
  migrateLegacyFlagsIfNeeded();
  const pausedStates = pauseAll();
  const config = loadConfig();
  rmSync(join(config.afkRoot, 'ACTIVE'), { force: true });
  const orchestrator = await haltOrchestratorService();
  return {
    ...orchestrator,
    paused: pausedStates.map((state) => state.task_id),
    index: readIndex(),
  };
}

export function readAfkSummaryList(): { summaries: RrAfkSummary[]; index: RrAfkTaskIndex } {
  migrateLegacyFlagsIfNeeded();
  return { summaries: listTaskSummaries(), index: readIndex() };
}
