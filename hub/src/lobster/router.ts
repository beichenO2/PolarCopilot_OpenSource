/**
 * Lobster router — POST /api/lobster/events
 *
 * Receives external event delivery requests and routes them through
 * the Hub's BroadcastPublisher to target agent inbox topics.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Router, type Request, type Response } from 'express';
import { Validator, type Schema } from '@cfworker/json-schema';
import type pino from 'pino';
import type { BroadcastPublisher } from '../broadcast/publisher.js';

export interface LobsterRouterDeps {
  publisher: BroadcastPublisher;
  logger: pino.Logger;
  /** Override schema path (for testing). */
  schemaPath?: string;
}

const DEFAULT_SCHEMA_PATH = join(
  process.env.HOME ?? '',
  'Polarisor',
  'PolarCopilot',
  'hub',
  'contracts',
  'lobster-event.schema.json',
);

let cachedValidator: Validator | undefined;

function getValidator(schemaPath: string): Validator {
  if (cachedValidator) return cachedValidator;
  const raw = readFileSync(schemaPath, 'utf-8');
  const schema = JSON.parse(raw) as Schema;
  cachedValidator = new Validator(schema, '7', false);
  return cachedValidator;
}

/** Check for path traversal attempts in agent IDs or topics. */
function isSafeIdentifier(value: string): boolean {
  return !value.includes('..') && !value.includes('/') && !value.includes('\\');
}

export function createLobsterRouter(deps: LobsterRouterDeps): Router {
  const router = Router();
  const { publisher, logger } = deps;
  const schemaPath = deps.schemaPath ?? DEFAULT_SCHEMA_PATH;

  router.post('/lobster/events', async (req: Request, res: Response) => {
    let validator: Validator;
    try {
      validator = getValidator(schemaPath);
    } catch (err) {
      logger.error({ err, schemaPath }, 'lobster: schema load failed');
      res.status(500).json({ ok: false, error: 'schema_unavailable' });
      return;
    }

    const result = validator.validate(req.body);
    if (!result.valid) {
      const errors = result.errors.map((e) => ({
        path: e.instanceLocation,
        keyword: e.keyword,
        message: e.error,
      }));
      res.status(400).json({ ok: false, error: 'invalid_payload', errors });
      return;
    }

    const event = req.body as {
      id: string;
      source: string;
      target: string;
      type: string;
      payload: unknown;
      timestamp: string;
      target_agent_id?: string;
      target_topic?: string;
    };

    // Determine routing target
    const agentId = event.target_agent_id ?? event.target;
    if (!isSafeIdentifier(agentId)) {
      res.status(400).json({ ok: false, error: 'invalid_target', message: 'target contains unsafe characters' });
      return;
    }

    const topic = event.target_topic ?? `${agentId}.inbox`;

    try {
      const pubResult = publisher.publish({
        sourceAgentId: `lobster:${event.source}`,
        topic,
        payload: event,
        idempotencyKey: `lobster:${event.id}`,
      });

      res.status(200).json({
        ok: true,
        event_id: event.id,
        topic,
        deduplicated: pubResult.deduplicated,
      });
    } catch (err) {
      logger.error({ err, eventId: event.id }, 'lobster: publish failed');
      res.status(500).json({ ok: false, error: 'publish_failed' });
    }
  });

  return router;
}
