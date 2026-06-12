/**
 * PilotEngine — Parse input_spec → generate phases → create Hub tasks → assign agents
 *
 * Implements the "IO is All" design: user defines requirements + key tech routes,
 * engine decomposes into executable tasks for the existing Solo/Slave agent system.
 */

import type { HubStore } from '../persistence/store.js';
import type { TaskService } from '../tasks/service.js';
import type { BroadcastPublisher } from '../broadcast/publisher.js';
import type { HubDb } from '../persistence/db.js';
import { alignmentDocs } from '../persistence/db.js';
import { randomUUID } from 'node:crypto';

export interface VerifyInput {
  agent_id: string;
  git_commit?: string;
  intent: string;
  files: Array<{ path: string; op: string; lines_changed: number }>;
  summary: string;
}

export interface VerifyLayerResult {
  layer: 'blinding' | 'rule' | 'diff';
  passed: boolean;
  details: string;
  warnings?: string[];
}

export interface VerifyOutput {
  ok: boolean;
  verdict: 'pass' | 'pass_with_warnings' | 'fail';
  results: VerifyLayerResult[];
  summary: string;
}

export interface PilotPhase {
  name: string;
  description: string;
  status: 'pending' | 'running' | 'completed' | 'blocked';
  task_id?: string;
  agent_id?: string;
  deliverables?: string[];
}

/**
 * Parse a free-form input_spec into structured phases.
 *
 * Supports two formats:
 * 1. Line-delimited: each non-empty line becomes a phase
 * 2. Numbered list: "1. ...", "2. ..." etc.
 */
export function parseInputSpec(inputSpec: string): PilotPhase[] {
  if (!inputSpec.trim()) return [];

  const lines = inputSpec.split('\n').map(l => l.trim()).filter(Boolean);
  const phases: PilotPhase[] = [];

  for (const line of lines) {
    const numbered = line.match(/^\d+[.)]\s*(.+)/);
    const bullet = line.match(/^[-*]\s*(.+)/);
    const content = numbered?.[1] ?? bullet?.[1] ?? line;

    if (content.startsWith('#') || content.startsWith('---')) continue;

    const colonIdx = content.indexOf(':');
    const name = colonIdx > 0 && colonIdx < 40
      ? content.slice(0, colonIdx).trim()
      : content.slice(0, 50).trim();
    const description = colonIdx > 0 && colonIdx < 40
      ? content.slice(colonIdx + 1).trim()
      : content;

    phases.push({ name, description, status: 'pending' });
  }

  return phases;
}

const POLARPRIVATE_URL = `http://127.0.0.1:${process.env.POLARPRIVATE_PORT ?? '12790'}`;
const LLM_SERVICE = process.env.KNOWLEVER_LLM_SERVICE ?? 'llm.aliyun.codingplan';
const LLM_MODEL = process.env.PILOT_LLM_MODEL ?? 'qwen3-coder-plus';

export class EngineError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly httpStatus: number = 400,
    public readonly recoverable: boolean = true,
  ) {
    super(message);
    this.name = 'EngineError';
  }
}

export class PilotEngine {
  private sotagentUrl: string | undefined;

  private db?: HubDb;

  private errorCounts = new Map<string, number>();

  constructor(
    private store: HubStore,
    private taskService: TaskService,
    private publisher?: BroadcastPublisher,
    db?: HubDb,
  ) {
    this.db = db;
    this.discoverSoTAgent();
  }

  private boundary<T>(operation: string, fn: () => T): T {
    try {
      return fn();
    } catch (err) {
      if (err instanceof EngineError) throw err;
      const msg = err instanceof Error ? err.message : String(err);
      const count = (this.errorCounts.get(operation) ?? 0) + 1;
      this.errorCounts.set(operation, count);
      console.error(`[PilotEngine:ErrorBoundary] ${operation} failed (count=${count}): ${msg}`);
      throw new EngineError(
        `Engine operation '${operation}' failed: ${msg}`,
        'engine_internal_error',
        500,
        false,
      );
    }
  }

  private async asyncBoundary<T>(operation: string, fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof EngineError) throw err;
      const msg = err instanceof Error ? err.message : String(err);
      const count = (this.errorCounts.get(operation) ?? 0) + 1;
      this.errorCounts.set(operation, count);
      console.error(`[PilotEngine:ErrorBoundary] ${operation} failed (count=${count}): ${msg}`);
      throw new EngineError(
        `Engine operation '${operation}' failed: ${msg}`,
        'engine_internal_error',
        500,
        false,
      );
    }
  }

  private async discoverSoTAgent(): Promise<void> {
    try {
      const resp = await fetch('http://127.0.0.1:4800/api/ports', { signal: AbortSignal.timeout(3000) });
      const ports = (await resp.json()) as Array<{ port: number; service_name: string }>;
      const sot = ports.find(p => p.service_name.includes('sotagent'));
      if (sot) this.sotagentUrl = `http://127.0.0.1:${sot.port}`;
    } catch {
      // SOTAgent discovery is best-effort
    }
  }

  /**
   * Use PolarPrivate LLM Proxy to intelligently parse requirements into phases.
   * Falls back to regex-based parseInputSpec if LLM is unavailable.
   */
  async parseWithLLM(inputSpec: string, outputSpec?: string): Promise<PilotPhase[]> {
    try {
      const healthResp = await fetch(`${POLARPRIVATE_URL}/health`, { signal: AbortSignal.timeout(3000) });
      const health = (await healthResp.json()) as { vault_unlocked?: boolean };
      if (!health.vault_unlocked) throw new Error('vault_locked');

      const systemPrompt = `You are a project decomposer. Given a requirements specification, break it into sequential phases.
Each phase should be an actionable development task that a coding agent can execute.
Respond ONLY with a JSON array of objects: [{"name": "...", "description": "...", "deliverables": ["..."]}]
Keep phase count between 2-8. Each phase should be completable in 1-4 hours.`;

      const userPrompt = `Requirements:\n${inputSpec}${outputSpec ? `\n\nExpected output:\n${outputSpec}` : ''}`;

      const resp = await fetch(
        `${POLARPRIVATE_URL}/proxy/${LLM_SERVICE}/chat/completions`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: LLM_MODEL,
            messages: [
              { role: 'system', content: systemPrompt },
              { role: 'user', content: userPrompt },
            ],
            max_tokens: 2000,
            temperature: 0.3,
          }),
          signal: AbortSignal.timeout(30000),
        },
      );

      if (!resp.ok) throw new Error(`LLM proxy returned ${resp.status}`);

      const data = (await resp.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      const content = data.choices?.[0]?.message?.content ?? '';

      const jsonMatch = content.match(/\[[\s\S]*\]/);
      if (!jsonMatch) throw new Error('no_json_in_response');

      const parsed = JSON.parse(jsonMatch[0]) as Array<{
        name: string;
        description: string;
        deliverables?: string[];
      }>;

      return parsed.map(p => ({
        name: p.name,
        description: p.description,
        status: 'pending' as const,
        deliverables: p.deliverables,
      }));
    } catch {
      return parseInputSpec(inputSpec);
    }
  }

  async verify(input: VerifyInput): Promise<VerifyOutput | null> {
    const url = this.sotagentUrl ?? 'http://127.0.0.1:4800';
    try {
      const resp = await fetch(`${url}/api/verify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
        signal: AbortSignal.timeout(10000),
      });
      if (!resp.ok) return null;
      return (await resp.json()) as VerifyOutput;
    } catch {
      return null;
    }
  }

  /**
   * Start a pilot project: LLM-parse spec → create tasks → publish to agents.
   * Uses PolarPrivate LLM Proxy for intelligent decomposition, falls back to regex.
   */
  async start(projectId: string): Promise<{ phases: PilotPhase[]; taskIds: string[]; llm_used: boolean }> {
    return this.asyncBoundary('start', async () => {
    const project = this.store.getPilotProject(projectId) as { status: string; input_spec: string; output_spec: string; name: string; description: string; phases: PilotPhase[] } | undefined;
    if (!project) throw new EngineError('project_not_found', 'project_not_found', 404);
    if (project.status !== 'draft' && project.status !== 'created') {
      throw new EngineError('project_already_started', 'project_already_started', 409);
    }

    const llmPhases = await this.parseWithLLM(project.input_spec, project.output_spec);
    const hasDeliverables = llmPhases.some(p => p.deliverables && p.deliverables.length > 0);
    const llmUsed = hasDeliverables;
    const phases = llmPhases.length > 0 ? llmPhases : parseInputSpec(project.input_spec);
    if (phases.length === 0) {
      throw new EngineError('empty_input_spec', 'empty_input_spec', 400);
    }

    const taskIds: string[] = [];
    const parentTaskResult = this.taskService.createTask({
      creator_agent_id: 'pilot-engine',
      title: `[Pilot] ${project.name}`,
      description: project.description || project.input_spec,
      workflow_stage: 'execute',
      priority: 0,
      depends_on: [],
    });
    const parentTaskId = parentTaskResult.task.id;
    taskIds.push(parentTaskId);

    for (let i = 0; i < phases.length; i++) {
      const phase = phases[i]!;
      const prevCompileId = i > 0 ? taskIds[taskIds.length - 2] : undefined;
      const compileDeps: string[] = prevCompileId ? [prevCompileId] : [];

      const compileResult = this.taskService.createTask({
        creator_agent_id: 'pilot-engine',
        title: `[C${i + 1}] 编译: ${phase.name}`,
        description: `编译阶段：将 "${phase.name}" 重构为可执行任务包（14项结构+质量门槛）`,
        parent_task_id: parentTaskId,
        depends_on: compileDeps,
        workflow_stage: 'compile',
        priority: i,
      });
      taskIds.push(compileResult.task.id);

      const executeResult = this.taskService.createTask({
        creator_agent_id: 'pilot-engine',
        title: `[P${i + 1}] ${phase.name}`,
        description: phase.description,
        parent_task_id: parentTaskId,
        depends_on: [compileResult.task.id],
        workflow_stage: 'execute',
        priority: i,
      });
      phase.task_id = executeResult.task.id;
      taskIds.push(executeResult.task.id);
    }

    this.store.updatePilotProjectPhases(projectId, phases);
    this.store.updatePilotProjectStatus(projectId, 'running');

    // Pilot projects default to YOLO: auto-create alignment doc
    if (this.db) {
      try {
        const workflows = phases.map(p => ({
          name: p.name,
          steps: [p.description],
          priority: 'normal' as const,
          test_type: 'cli' as const,
        }));
        const sections = ['极限目标', '工作逻辑', '用户预期体验', '执行计划', '质量标准', '风险'].map(name => ({
          name,
          confirmed: false,
        }));
        const planMd = [
          `# YOLO 对齐方案 — ${project.name}`,
          '',
          '## 极限目标',
          project.output_spec || project.description || project.name,
          '',
          '## 工作逻辑',
          'Debug > Test > Dev',
          '',
          '## 用户预期体验',
          ...phases.map((p, i) => `${i + 1}. ${p.name}: ${p.description}`),
          '',
          '## 执行计划',
          ...phases.map((p, i) => `- [P${i + 1}] ${p.name}`),
          '',
          '## 质量标准',
          '- CLI 测试覆盖所有 Phase',
          '',
          '## 风险',
          '- Pilot 自动生成，需用户确认对齐方案',
        ].join('\n');

        const now = new Date();
        this.db.insert(alignmentDocs).values({
          id: randomUUID(),
          agentId: 'pilot-engine',
          status: 'pending_review',
          goal: project.output_spec || project.description || '',
          workLogic: 'Debug > Test > Dev',
          workflowsJson: JSON.stringify(workflows),
          planMarkdown: planMd,
          sectionsJson: JSON.stringify(sections),
          version: 1,
          pilotProjectId: projectId,
          createdAt: now,
          updatedAt: now,
        }).run();
      } catch {
        // Alignment doc creation is best-effort
      }
    }

    if (this.publisher) {
      this.publisher.publish({
        sourceAgentId: 'pilot-engine',
        topic: 'pilot.started',
        payload: {
          project_id: projectId,
          project_name: project.name,
          phase_count: phases.length,
          task_ids: taskIds,
        },
      });
    }

    return { phases, taskIds, llm_used: llmUsed };
    });
  }

  updatePhaseStatus(
    projectId: string,
    phaseIndex: number,
    status: PilotPhase['status'],
    agentId?: string,
    deliverables?: string[],
  ): { updated: boolean; projectCompleted: boolean; summary?: string } {
    return this.boundary('updatePhaseStatus', () => {
    const project = this.store.getPilotProject(projectId) as { name: string; output_spec: string; phases: PilotPhase[] } | undefined;
    if (!project) throw new EngineError('project_not_found', 'project_not_found', 404);

    const phases: PilotPhase[] = project.phases;
    if (phaseIndex < 0 || phaseIndex >= phases.length) {
      throw new EngineError('phase_index_out_of_range', 'phase_index_out_of_range', 400);
    }

    phases[phaseIndex]!.status = status;
    if (agentId) phases[phaseIndex]!.agent_id = agentId;
    if (deliverables) phases[phaseIndex]!.deliverables = deliverables;

    const allCompleted = phases.every(p => p.status === 'completed');

    this.store.updatePilotProjectPhases(projectId, phases);

    let summary: string | undefined;
    if (allCompleted) {
      this.store.updatePilotProjectStatus(projectId, 'completed');

      const allDeliverables = phases
        .flatMap((p, i) => (p.deliverables ?? []).map(d => `[P${i + 1}] ${d}`));
      summary = [
        `项目 "${project.name}" 已完成`,
        `共 ${phases.length} 个阶段`,
        allDeliverables.length > 0
          ? `产物:\n${allDeliverables.map(d => `  - ${d}`).join('\n')}`
          : '（无显式产物记录）',
        `输出规格: ${project.output_spec || '未定义'}`,
      ].join('\n');

      this.publisher?.publish({
        sourceAgentId: 'pilot-engine',
        topic: 'pilot.completed',
        payload: {
          project_id: projectId,
          project_name: project.name,
          summary,
          deliverables: allDeliverables,
        },
      });
    }

    return { updated: true, projectCompleted: allCompleted, summary };
    });
  }

  cancel(projectId: string): boolean {
    return this.boundary('cancel', () => {
    const project = this.store.getPilotProject(projectId) as { status: string } | undefined;
    if (!project) throw new EngineError('project_not_found', 'project_not_found', 404);
    if (project.status === 'completed' || project.status === 'cancelled') {
      throw new EngineError('project_not_cancellable', 'project_not_cancellable', 409);
    }

    this.store.updatePilotProjectStatus(projectId, 'cancelled');
    this.publisher?.publish({
      sourceAgentId: 'pilot-engine',
      topic: 'pilot.cancelled',
      payload: { project_id: projectId },
    });
    return true;
    });
  }

  assignAgents(projectId: string, agentIds: string[]): PilotPhase[] {
    return this.boundary('assignAgents', () => {
    const project = this.store.getPilotProject(projectId) as { phases: PilotPhase[] } | undefined;
    if (!project) throw new EngineError('project_not_found', 'project_not_found', 404);

    const phases: PilotPhase[] = project.phases;
    for (let i = 0; i < phases.length; i++) {
      if (i < agentIds.length && agentIds[i]) {
        phases[i]!.agent_id = agentIds[i];
      }
    }

    this.store.updatePilotProjectPhases(projectId, phases, agentIds);
    return phases;
    });
  }
}
