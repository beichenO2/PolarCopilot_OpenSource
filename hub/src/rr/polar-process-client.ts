import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const POLARPROCESS_URL = (process.env.POLARPROCESS_URL ?? 'http://127.0.0.1:11055').replace(/\/$/, '');
const HUB_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const POLARCOPILOT_ROOT = resolve(HUB_ROOT, '..');

export const RR_CURSOR_SERVICE_PREFIX = 'rr-cursor-';

export interface PolarProcessService {
  id: string;
  name: string;
  status: string;
  pid: number | null;
  port: number | null;
}

export interface PolarProcessActionResult {
  ok: boolean;
  message?: string;
  pid?: number;
}

function polarProcessUnavailable(error: unknown): Error {
  const detail = error instanceof Error ? error.message : String(error);
  return new Error(`polarprocess_unavailable:${detail}`);
}

async function polarFetch(path: string, init?: RequestInit): Promise<Response> {
  try {
    return await fetch(`${POLARPROCESS_URL}${path}`, {
      ...init,
      signal: init?.signal ?? AbortSignal.timeout(15_000),
    });
  } catch (error) {
    throw polarProcessUnavailable(error);
  }
}

export function rrCursorServiceId(sessionId: string): string {
  return `${RR_CURSOR_SERVICE_PREFIX}${sessionId}`;
}

export function isRrCursorServiceId(serviceId: string): boolean {
  return serviceId.startsWith(RR_CURSOR_SERVICE_PREFIX);
}

export async function listPolarProcessServices(): Promise<PolarProcessService[]> {
  const response = await polarFetch('/api/services');
  if (!response.ok) {
    throw new Error(`polarprocess_list_failed:${response.status}`);
  }
  return await response.json() as PolarProcessService[];
}

export async function stopPolarProcessService(serviceId: string): Promise<PolarProcessActionResult> {
  const response = await polarFetch(`/api/services/${encodeURIComponent(serviceId)}/stop`, {
    method: 'POST',
  });
  const body = await response.json().catch(() => ({})) as PolarProcessActionResult;
  if (!response.ok && response.status !== 404) {
    throw new Error(body.message ?? `polarprocess_stop_failed:${response.status}`);
  }
  return body;
}

export async function startPolarProcessService(serviceId: string): Promise<PolarProcessActionResult> {
  const response = await polarFetch(`/api/services/${encodeURIComponent(serviceId)}/start`, {
    method: 'POST',
  });
  const body = await response.json().catch(() => ({})) as PolarProcessActionResult;
  if (!response.ok) {
    throw new Error(body.message ?? `polarprocess_start_failed:${response.status}`);
  }
  return body;
}

export async function getPolarProcessService(serviceId: string): Promise<PolarProcessService | null> {
  const services = await listPolarProcessServices();
  return services.find((service) => service.id === serviceId) ?? null;
}

export async function registerAndStartRrCursorAgent(input: {
  sessionId: string;
  name: string;
  command: string;
}): Promise<PolarProcessActionResult & { id: string }> {
  const serviceId = rrCursorServiceId(input.sessionId);
  await stopPolarProcessService(serviceId).catch(() => undefined);

  const payload = {
    id: serviceId,
    name: `Rr Cursor Agent · ${input.name}`,
    command: input.command,
    work_dir: POLARCOPILOT_ROOT,
    device_id: 'any',
    auto_start: false,
    restart_on_failure: false,
    max_restarts: 0,
    port: null,
    health_check_url: null,
    start_script_dir: '-',
  };

  const response = await polarFetch('/api/services/register-and-start', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const body = await response.json().catch(() => ({})) as PolarProcessActionResult & { id?: string };
  if (!response.ok || !body.ok) {
    throw new Error(body.message ?? `polarprocess_spawn_failed:${response.status}`);
  }
  return { ...body, id: body.id ?? serviceId };
}

export async function listManagedRrCursorAgentPids(): Promise<Set<number>> {
  const services = await listPolarProcessServices();
  const pids = new Set<number>();
  for (const service of services) {
    if (!isRrCursorServiceId(service.id)) continue;
    if (service.status !== 'running' && service.status !== 'starting') continue;
    if (typeof service.pid === 'number' && service.pid > 0) pids.add(service.pid);
  }
  return pids;
}
