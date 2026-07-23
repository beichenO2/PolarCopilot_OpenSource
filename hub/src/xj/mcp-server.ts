import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import * as z from 'zod/v4';
import { advanceAutomation } from './automation.js';
import type { XjSkillRouter } from './skill-router.js';
import type { XjFileStore } from './store.js';

export interface XjMcpDeps {
  store: XjFileStore;
  skillRouter: XjSkillRouter;
}

function text(value: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value) }] };
}

function failure(error: unknown) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }) }],
    isError: true,
  };
}

export function createXjMcpServer({ store, skillRouter }: XjMcpDeps): McpServer {
  const server = new McpServer(
    { name: 'polarcop-xj', version: '2.0.0' },
    {
      instructions: [
        'PolarCopilot XJ is a persistent local session transport.',
        'Register once, process each message, persist replies/progress, then call wait_message again.',
        'Stop looping when the session is paused or completed.',
      ].join(' '),
    },
  );

  server.registerPrompt('continuous_session', {
    title: 'XJ 持续会话循环',
    description: '透明加载持续 wait_message 循环、进度持久化和自动技能路由说明。',
    argsSchema: {
      message: z.string().max(100_000).optional(),
      modes: z.string().max(4000).optional(),
    },
  }, ({ message, modes }) => {
    const enabled = (modes ?? '').split(',').map((value) => value.trim()).filter(Boolean);
    const skills = skillRouter.match(message ?? '', enabled);
    return {
      messages: [{
        role: 'user',
        content: { type: 'text', text: skillRouter.buildApplicationInstructions(skills) },
      }],
    };
  });

  server.registerTool('register_session', {
    description: 'Register or reconnect an XJ session using the launchId exactly as issued by HUB Web. Do not rename or transform launchId.',
    inputSchema: {
      sessionId: z.string().min(1).optional(),
      launchId: z.string().min(1).max(1024),
      name: z.string().min(1).max(200),
      role: z.string().min(1).max(200).optional(),
      title: z.string().max(200).optional(),
      modes: z.array(z.string().max(100)).max(50).optional(),
    },
  }, async ({ sessionId, launchId, name, role, title, modes }) => {
    try {
      const result = store.register({
        sessionId,
        launchId,
        name,
        role,
        title,
        modes,
      });
      const skills = result.session.modes.length > 0 ? skillRouter.match('', result.session.modes) : [];
      return text({
        ok: true,
        sessionId: result.session.id,
        name: result.session.name,
        ...result,
        matched_skills: skills,
        application_instructions: skillRouter.buildApplicationInstructions(skills),
        next_tool: 'wait_message',
      });
    } catch (error) { return failure(error); }
  });

  server.registerTool('register_legacy_session', {
    description: 'Legacy compatibility entry for pre-launchId PolarCopilot clients. New HUB prompts must use register_session instead.',
    inputSchema: {
      client_key: z.string().min(1).max(1024),
      title: z.string().max(200).optional(),
      modes: z.array(z.string().max(100)).max(50).optional(),
    },
  }, async ({ client_key, title, modes }) => {
    try {
      const result = store.register({ clientKey: client_key, title, modes });
      const skills = result.session.modes.length > 0 ? skillRouter.match('', result.session.modes) : [];
      return text({
        ok: true,
        sessionId: result.session.id,
        name: result.session.name,
        ...result,
        matched_skills: skills,
        application_instructions: skillRouter.buildApplicationInstructions(skills),
        next_tool: 'wait_message',
      });
    } catch (error) { return failure(error); }
  });

  server.registerTool('list_subagents', {
    description: 'List the two HUB-linked subagents belonging to this main XJ session.',
    inputSchema: {
      sessionId: z.string().min(1),
    },
  }, async ({ sessionId }) => {
    try {
      return text({ ok: true, subagents: store.listSubagents(sessionId) });
    } catch (error) { return failure(error); }
  });

  server.registerTool('dispatch_subagent_task', {
    description: 'Durably enqueue a task for one linked subagent. Its reply will be delivered to the main session as XJ_MSG AGENT_RESULT.',
    inputSchema: {
      sessionId: z.string().min(1),
      subagentId: z.string().min(1),
      title: z.string().min(1).max(200).optional(),
      content: z.string().min(1).max(1_000_000),
    },
  }, async ({ sessionId, subagentId, title, content }) => {
    try {
      const task = store.dispatchSubagentTask(sessionId, subagentId, content, title);
      return text({ ok: true, task, next_tool: 'wait_message' });
    } catch (error) { return failure(error); }
  });

  server.registerTool('wait_message', {
    description: 'Block until the next durable inbox message or timeout. After timeout, call wait_message again while the session remains active.',
    inputSchema: {
      sessionId: z.string().min(1).optional(),
      session_id: z.string().min(1).optional(),
      agentStatus: z.string().max(100).optional(),
      timeoutMs: z.number().int().min(1).max(86_400_000).optional(),
      timeout_ms: z.number().int().min(1).max(86_400_000).optional(),
    },
  }, async ({ sessionId, session_id, agentStatus, timeoutMs, timeout_ms }) => {
    try {
      const id = sessionId ?? session_id;
      if (!id) throw new Error('invalid_session_id');
      if (agentStatus) store.setAgentMetadata(id, { agentStatus });
      const result = await store.waitMessage(id, { timeoutMs: timeoutMs ?? timeout_ms });
      if (result.kind !== 'message' || !result.message) {
        return text({ ok: true, ...result, next_tool: result.continueWith });
      }
      const session = store.getSession(id);
      const skills = skillRouter.match(result.message.content, session.modes);
      return text({
        ok: true,
        ...result,
        matched_skills: skills,
        application_instructions: skillRouter.buildApplicationInstructions(skills),
      });
    } catch (error) { return failure(error); }
  });

  server.registerTool('reply_message', {
    description: 'Persist an assistant reply to XJ history. On success, continue with wait_message unless the session is paused or complete.',
    inputSchema: {
      sessionId: z.string().min(1).optional(),
      session_id: z.string().min(1).optional(),
      content: z.string().min(1).max(1_000_000),
      title: z.string().max(200).optional(),
      suggestions: z.array(z.string().min(1).max(4000)).max(20).optional(),
      agentStatus: z.string().max(100).optional(),
      visibility: z.string().max(100).optional(),
      evidence: z.array(z.string().max(4000)).max(200).optional(),
    },
  }, async ({ sessionId, session_id, content, title, suggestions, agentStatus, visibility, evidence }) => {
    try {
      const id = sessionId ?? session_id;
      if (!id) throw new Error('invalid_session_id');
      const message = store.reply(id, content, {
        evidence: evidence ?? [],
        ...(title ? { title } : {}),
        ...(suggestions ? { suggestions } : {}),
        ...(agentStatus ? { agentStatus } : {}),
        ...(visibility ? { visibility } : {}),
      });
      return text({ ok: true, message, next_tool: message.continueWith });
    } catch (error) { return failure(error); }
  });

  server.registerTool('report_progress', {
    description: 'Persist progress, TODO items and verification evidence for the current XJ session.',
    inputSchema: {
      sessionId: z.string().min(1).optional(),
      session_id: z.string().min(1).optional(),
      percent: z.number().min(0).max(100),
      summary: z.string().max(20_000),
      todo: z.array(z.string().max(4000)).max(500).optional(),
      evidence: z.array(z.string().max(4000)).max(500).optional(),
    },
  }, async ({ sessionId, session_id, percent, summary, todo, evidence }) => {
    try {
      const id = sessionId ?? session_id;
      if (!id) throw new Error('invalid_session_id');
      return text({ ok: true, progress: store.reportProgress(id, { percent, summary, todo, evidence }) });
    }
    catch (error) { return failure(error); }
  });

  server.registerTool('update_automation', {
    description: 'Configure or advance the bounded nightshift loop with frozen acceptance criteria and a loop limit.',
    inputSchema: {
      session_id: z.string().min(1),
      enabled: z.boolean().optional(),
      loop_limit: z.number().int().min(1).max(10_000).optional(),
      acceptance_criteria: z.array(z.string().max(4000)).max(500).optional(),
      completed_criteria: z.array(z.string().max(4000)).max(500).optional(),
      todo: z.array(z.string().max(4000)).max(500).optional(),
      outcome: z.enum(['passed', 'failed', 'blocked']).optional(),
      summary: z.string().max(20_000).optional(),
      failed_path: z.string().max(4000).optional(),
    },
  }, async ({ session_id, enabled, loop_limit, acceptance_criteria, completed_criteria, todo, outcome, summary, failed_path }) => {
    try {
      let automation = store.setAutomation(session_id, {
        enabled,
        ...(enabled ? { state: 'running' as const } : {}),
        loopLimit: loop_limit,
        acceptanceCriteria: acceptance_criteria,
        completedCriteria: completed_criteria,
        todo,
      });
      if (outcome) {
        automation = store.setAutomation(session_id, advanceAutomation(automation, {
          outcome,
          summary: summary ?? outcome,
          failedPath: failed_path,
          completedCriteria: completed_criteria,
          nextTodo: todo,
        }));
      }
      return text({ ok: true, automation, next_tool: automation.state === 'running' ? 'wait_message' : null });
    } catch (error) { return failure(error); }
  });

  server.registerTool('pause_session', {
    description: 'Pause the persistent loop without deleting history or inbox data.',
    inputSchema: { session_id: z.string().min(1) },
  }, async ({ session_id }) => {
    try { return text({ ok: true, automation: store.pause(session_id) }); }
    catch (error) { return failure(error); }
  });

  server.registerTool('resume_session', {
    description: 'Resume a paused persistent loop with the same stable session ID.',
    inputSchema: { session_id: z.string().min(1) },
  }, async ({ session_id }) => {
    try { return text({ ok: true, automation: store.resume(session_id), next_tool: 'wait_message' }); }
    catch (error) { return failure(error); }
  });

  server.registerTool('complete_session', {
    description: 'Mark a session complete after its acceptance criteria and verification gates pass.',
    inputSchema: {
      sessionId: z.string().min(1).optional(),
      session_id: z.string().min(1).optional(),
      summary: z.string().min(1).max(20_000),
      evidence: z.array(z.string().max(4000)).max(500).optional(),
    },
  }, async ({ sessionId, session_id, summary, evidence }) => {
    try {
      const id = sessionId ?? session_id;
      if (!id) throw new Error('invalid_session_id');
      const { progress, automation } = store.completeSession(id, { summary, evidence });
      return text({ ok: true, progress, automation, next_tool: null });
    } catch (error) { return failure(error); }
  });

  return server;
}
