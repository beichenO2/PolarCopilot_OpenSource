import { getPolarProcessService, startPolarProcessService, stopPolarProcessService } from '../polar-process-client.js';
import { isOrchestratorEnabled, setOrchestratorEnabled } from './toggle.js';

export const ORCHESTRATOR_SERVICE_ID = 'rr-orchestrator';

export async function startOrchestratorService(): Promise<{ enabled: boolean; polarprocess: unknown; running: boolean }> {
  setOrchestratorEnabled(true);
  const polarprocess = await startPolarProcessService(ORCHESTRATOR_SERVICE_ID);
  const service = await getPolarProcessService(ORCHESTRATOR_SERVICE_ID);
  return {
    enabled: true,
    polarprocess,
    running: service?.status === 'running' || service?.status === 'starting',
  };
}

export async function stopOrchestratorService(): Promise<{ enabled: boolean; polarprocess: unknown; running: boolean }> {
  const polarprocess = await stopPolarProcessService(ORCHESTRATOR_SERVICE_ID);
  const service = await getPolarProcessService(ORCHESTRATOR_SERVICE_ID);
  return {
    enabled: isOrchestratorEnabled(),
    polarprocess,
    running: service?.status === 'running' || service?.status === 'starting',
  };
}

export async function haltOrchestratorService(): Promise<{ enabled: boolean; polarprocess: unknown; running: boolean }> {
  setOrchestratorEnabled(false);
  const polarprocess = await stopPolarProcessService(ORCHESTRATOR_SERVICE_ID);
  const service = await getPolarProcessService(ORCHESTRATOR_SERVICE_ID);
  return {
    enabled: false,
    polarprocess,
    running: service?.status === 'running' || service?.status === 'starting',
  };
}

export async function readOrchestratorServiceState(): Promise<{
  enabled: boolean;
  running: boolean;
  serviceStatus: string | null;
  pid: number | null;
}> {
  let service = null;
  try {
    service = await getPolarProcessService(ORCHESTRATOR_SERVICE_ID);
  } catch {
    service = null;
  }
  const running = service?.status === 'running' || service?.status === 'starting';
  return {
    enabled: isOrchestratorEnabled(),
    running,
    serviceStatus: service?.status ?? null,
    pid: service?.pid ?? null,
  };
}
