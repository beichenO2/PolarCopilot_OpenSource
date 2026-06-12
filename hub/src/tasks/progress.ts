import type { HubReportProgressInput, HubReportProgressOutput } from '../protocol/agent.js';
import type { AgentLoopState } from '../types.js';

export class ProgressTracker {
  private readonly loops = new Map<string, AgentLoopState>();

  private key(agentId: string, taskId: string): string {
    return `${agentId}\0${taskId}`;
  }

  report(input: HubReportProgressInput): HubReportProgressOutput {
    const k = this.key(input.agent_id, input.task_id);
    const prev = this.loops.get(k) ?? { iteration: 0, phase: 'execute', status: 'working' };

    let status: AgentLoopState['status'] = prev.status;
    if (input.kind === 'error') status = 'error';
    else if (input.kind === 'done') status = 'waiting';
    else if (input.kind === 'started' || input.kind === 'progress') status = 'working';

    const iteration = input.kind === 'progress' ? prev.iteration + 1 : prev.iteration;
    const next: AgentLoopState = {
      iteration,
      phase: prev.phase,
      status,
    };
    this.loops.set(k, next);
    return { recorded: true, loop: next };
  }
}
