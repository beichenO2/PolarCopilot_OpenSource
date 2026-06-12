import type { Logger } from 'pino';
import type { HubStore } from '../persistence/store.js';

/** Domain-level session binding; transport maps live in `transport/http.ts`. */
export class SessionRegistry {
  constructor(
    private readonly store: HubStore,
    private readonly logger: Logger,
  ) {}

  register(mcpSessionId: string, agentId: string, label?: string | null) {
    const result = this.store.upsertSession({ mcpSessionId, agentId, label });
    if (!result.ok) {
      this.logger.warn({ mcpSessionId, agentId, reason: result.reason }, 'session register rejected');
    }
    return result;
  }

  getByMcpSession(mcpSessionId: string) {
    return this.store.getSessionByMcpId(mcpSessionId);
  }

  saveCapabilities(agentId: string, roles: string[], skills: string[]) {
    this.store.upsertAgentCapabilities(agentId, roles, skills);
  }

  findAgentsWithSkill(skill: string): string[] {
    return this.store.listAgentIdsWithSkill(skill);
  }
}
