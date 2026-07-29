import { randomUUID } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import * as z from 'zod/v4';
import { makePollTick } from './poll-ticks.js';
import type { RrFileStore } from './store.js';
import type { RrMessage, RrResumeContext, RrSubagentView } from './types.js';

function text(value: string) {
  return { content: [{ type: 'text' as const, text: value }] };
}

function failure(error: unknown) {
  return {
    content: [{ type: 'text' as const, text: `Rr error: ${error instanceof Error ? error.message : String(error)}` }],
    isError: true,
  };
}

function renderWaitMessage(message: RrMessage): string {
  const type = message.metadata?.type;
  if (type === 'subagent_task') {
    return `[RR_MSG · AGENT_TASK] taskId=${String(message.metadata?.taskId ?? '')}\nmasterSessionId=${String(message.metadata?.masterSessionId ?? '')}\n\n${message.content}\n\nUse report_task_progress while working, then complete_subagent_task with this taskId.`;
  }
  if (type === 'subagent_result') {
    return `[RR_MSG · AGENT_RESULT] taskId=${String(message.metadata?.taskId ?? '')} ok=${String(message.metadata?.ok ?? true)}\nsubagentSessionId=${String(message.metadata?.subagentSessionId ?? '')}\n\n${message.content}`;
  }
  return `[RR_MSG · USER_TASK]\n${message.content}`;
}

function renderSubagents(subagents: RrSubagentView[]): string {
  if (subagents.length === 0) return 'No Rr subagents are registered. Turn on the subagent switch for another Rr session, then call list_subagents again.';
  return [
    `Rr subagents (${subagents.length}):`,
    ...subagents.map((agent) => {
      const progress = agent.activeTask?.progress
        ? ` | progress=${agent.activeTask.progress.percent ?? '?'}% ${agent.activeTask.progress.text}`
        : '';
      const task = agent.activeTask ? ` | taskId=${agent.activeTask.taskId}` : '';
      return `- ${agent.sessionId} | ${agent.name} | ${agent.availability}${task}${progress}`;
    }),
  ].join('\n');
}

function renderResumeContext(resume: RrResumeContext): string {
  return [
    '[RR_RESUME]',
    `sessionId: ${resume.session.sessionId}`,
    `launchId: ${String(resume.sourceSession.launchId ?? '')}`,
    `sourceLastActiveAt: ${resume.sourceLastActiveAt}`,
    'Recovered lossless context:',
    JSON.stringify({
      sourceSession: resume.sourceSession,
      workspace: resume.workspace ?? null,
      history: resume.history,
      tasks: resume.tasks,
      topology: resume.topology,
    }, null, 2),
    `Continue this exact session. Now call wait_message("${resume.session.sessionId}") to read its inbox; write replies with the same sessionId.`,
  ].join('\n');
}

export function createRrMcpServer(store: RrFileStore): McpServer {
  const server = new McpServer({ name: 'rr-mcp-server', version: '0.1.0' });
  const ownerInstanceId = `rr-mcp-instance-${randomUUID()}`;

  server.registerTool('register_session', {
    description: 'Register this Rr agent session once at chat start. If the user sends the single message "continue", call this tool with name="continue" and no IDs to restore the latest imported XJ session, plan, tasks and subagent topology. When Hub spawn prompt includes a pre-assigned sessionId, you MUST pass that exact sessionId (and launchId if present) — never create a duplicate session.',
    inputSchema: {
      sessionId: z.string().optional(),
      name: z.string(),
      role: z.string().optional(),
      launchId: z.string().optional(),
    },
  }, async ({ sessionId, name, role, launchId }) => {
    try {
      const result = store.register({ sessionId, name, role, launchId }, ownerInstanceId);
      if (result.resume) return text(renderResumeContext(result.resume));
      return text([
        result.deduplicated ? 'Rr session reconnected.' : 'Rr session registered.',
        `sessionId: ${result.session.sessionId}`,
        `name: ${result.session.name}`,
        '[会话唯一] 请记住这个 sessionId；重连时复用它，不要创建重复会话。',
        `Now call wait_message("${result.session.sessionId}") to start the infinite local polling loop.`,
      ].join('\n'));
    } catch (error) { return failure(error); }
  });

  server.registerTool('reply_message', {
    description: 'Save a reply to the local Rr panel and update status. Call this before wait_message. Rich Markdown and native suggestions:string[] are supported.',
    inputSchema: {
      sessionId: z.string(),
      content: z.string(),
      agentStatus: z.string().optional(),
      suggestions: z.array(z.string()).optional(),
      title: z.string().optional(),
      visibility: z.enum(['public', 'internal']).optional(),
    },
  }, async ({ sessionId, content, agentStatus, suggestions, title, visibility }) => {
    try {
      store.reply(sessionId, content, { agentStatus, suggestions, title, visibility }, ownerInstanceId);
      return text(`Reply saved. Now call wait_message("${sessionId}") immediately to keep waiting.`);
    } catch (error) { return failure(error); }
  });

  server.registerTool('wait_message', {
    description: 'Block for the next Rr panel message. Call after every reply. A [POLL_TICK] is a keepalive mini task, not a stop signal; complete it briefly and call wait_message again.',
    inputSchema: {
      sessionId: z.string(),
      agentStatus: z.string().optional(),
      timeoutMs: z.number().optional(),
    },
  }, async ({ sessionId, agentStatus, timeoutMs }) => {
    try {
      if (agentStatus) store.updateSession(sessionId, { agentStatus }, ownerInstanceId);
      const configured = Number(process.env.RR_POLL_TICK_MS ?? 60_000);
      const message = await store.waitMessage(sessionId, timeoutMs ?? configured, undefined, ownerInstanceId);
      return text(message ? renderWaitMessage(message) : makePollTick(store));
    } catch (error) { return failure(error); }
  });

  server.registerTool('list_subagents', {
    description: 'List other local Rr sessions whose subagent switch is on, including idle, busy, offline, active task and progress state.',
    inputSchema: { sessionId: z.string().optional() },
  }, async ({ sessionId }) => {
    try { return text(renderSubagents(store.listSubagents(sessionId))); }
    catch (error) { return failure(error); }
  });

  server.registerTool('dispatch_subagent_task', {
    description: 'Dispatch a self-contained task to one idle local Rr subagent. The target is atomically locked busy until complete_subagent_task releases it.',
    inputSchema: {
      sessionId: z.string(),
      targetSessionId: z.string(),
      content: z.string(),
    },
  }, async ({ sessionId, targetSessionId, content }) => {
    try {
      const task = store.dispatchSubagentTask(sessionId, targetSessionId, content);
      return text(`Task dispatched. taskId=${task.taskId} targetSessionId=${targetSessionId}. Continue your own work or call wait_message for the [RR_MSG · AGENT_RESULT].`);
    } catch (error) { return failure(error); }
  });

  server.registerTool('report_task_progress', {
    description: 'For a busy Rr subagent: update the active task progress and refresh its busy heartbeat. This does not complete the task.',
    inputSchema: {
      sessionId: z.string(),
      taskId: z.string(),
      progress: z.string(),
      percent: z.number().optional(),
    },
  }, async ({ sessionId, taskId, progress, percent }) => {
    try {
      store.reportTaskProgress(sessionId, taskId, progress, percent);
      return text(`Task progress saved. taskId=${taskId}${percent === undefined ? '' : ` percent=${Math.max(0, Math.min(100, percent))}`}.`);
    } catch (error) { return failure(error); }
  });

  server.registerTool('complete_subagent_task', {
    description: 'For a busy Rr subagent: return the full task result to the master inbox and release the busy lock, then call wait_message again.',
    inputSchema: {
      sessionId: z.string(),
      taskId: z.string(),
      result: z.string(),
      ok: z.boolean().optional(),
    },
  }, async ({ sessionId, taskId, result, ok }) => {
    try {
      store.completeSubagentTask(sessionId, taskId, result, ok ?? true);
      return text(`Task completed. taskId=${taskId}. Result delivered and busy lock released. Now call wait_message("${sessionId}") again.`);
    } catch (error) { return failure(error); }
  });

  return server;
}
