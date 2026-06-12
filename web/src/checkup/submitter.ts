/**
 * Submitter for <polar-checkup>: assemble a checkup-event payload that
 * conforms to Agent_core/contracts/checkup-event.schema.json and POST it
 * to PolarCopilot Hub.
 *
 * The Hub validates against the same schema (see hub/src/checkup/route.ts)
 * and 4xx-rejects malformed payloads, so this client side trusts the server
 * for final shape verification while keeping a thin guard on required fields.
 */

import type { Annotation } from './annotator.js';
import { CHECKUP_AGENT_ID } from './constants.js';

export interface SubmitContext {
  hubUrl: string;
  project: string;
  /** @deprecated ignored — always routes to @checkup-agent */
  agentTarget?: string;
  pageUrl: string;
  pageTitle?: string;
  userText: string;
  screenshotB64?: string;
  screenshotClip?: { x: number; y: number; width: number; height: number };
  annotations?: Annotation[];
  userSession?: {
    userId?: string;
    browser?: string;
    viewport?: { width: number; height: number };
  };
  /** Override fetch for testing. */
  fetchImpl?: typeof fetch;
  /** Override UUID generator for testing. */
  uuidImpl?: () => string;
}

export interface SubmitResult {
  ok: boolean;
  status: number;
  /** Echo from Hub on success. */
  eventId?: string;
  /** Whether Hub also forwarded to SOTAgent (best-effort). */
  forwardedToSotagent?: boolean;
  /** Server-side error envelope if any. */
  error?: unknown;
}

export class CheckupSubmitError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly serverBody: unknown,
  ) {
    super(message);
    this.name = 'CheckupSubmitError';
  }
}

function defaultUuid(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx`.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

export async function submitCheckup(ctx: SubmitContext): Promise<SubmitResult> {
  if (!ctx.project) throw new Error('project is required');
  if (!ctx.pageUrl) throw new Error('pageUrl is required');
  if (!ctx.userText) throw new Error('userText is required');

  const uuid = (ctx.uuidImpl ?? defaultUuid)();
  const fetchFn = ctx.fetchImpl ?? fetch;

  const event: Record<string, unknown> = {
    event_id: uuid,
    project: ctx.project,
    agent_target: CHECKUP_AGENT_ID,
    page_url: ctx.pageUrl,
    user_text: ctx.userText,
    timestamp: new Date().toISOString(),
  };
  if (ctx.pageTitle) event.page_title = ctx.pageTitle;
  if (ctx.screenshotB64) event.screenshot_b64 = ctx.screenshotB64;
  if (ctx.screenshotClip) event.screenshot_clip = ctx.screenshotClip;
  if (ctx.annotations && ctx.annotations.length > 0) event.annotations = ctx.annotations;
  if (ctx.userSession) {
    const us: Record<string, unknown> = {};
    if (ctx.userSession.userId) us.user_id = ctx.userSession.userId;
    if (ctx.userSession.browser) us.browser = ctx.userSession.browser;
    if (ctx.userSession.viewport) us.viewport = ctx.userSession.viewport;
    if (Object.keys(us).length > 0) event.user_session = us;
  }

  const url = `${ctx.hubUrl.replace(/\/$/, '')}/api/checkup-event`;
  const res = await fetchFn(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(event),
  });

  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    /* non-JSON body — leave null */
  }

  if (!res.ok) {
    return { ok: false, status: res.status, error: body };
  }

  const b = (body ?? {}) as {
    event_id?: string;
    forwarded_to_sotagent?: boolean;
  };
  return {
    ok: true,
    status: res.status,
    eventId: b.event_id ?? uuid,
    forwardedToSotagent: b.forwarded_to_sotagent,
  };
}
