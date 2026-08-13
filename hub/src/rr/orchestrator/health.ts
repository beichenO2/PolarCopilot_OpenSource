import { loadConfig } from './config.js';
import { readAfkSnapshot } from './afk-state.js';
import { isOrchestratorEnabled, readEnabledSince } from './toggle.js';
import { loadState } from './state.js';

export function readOrchestratorHealth(projectRoot?: string) {
  const config = loadConfig(projectRoot);
  const state = loadState(config.statePath);
  const afk = readAfkSnapshot(config);
  const enabled = isOrchestratorEnabled();
  return {
    ok: enabled && !state.paused && !afk.paused && !afk.done,
    enabled,
    enabledSince: readEnabledSince(),
    paused: state.paused || afk.paused,
    done: afk.done,
    afkActive: afk.active,
    loopCount: state.loopCount,
    lastTickAt: state.lastTickAt,
    lastAction: state.lastAction,
    lastSessionId: state.lastSessionId,
    hubUrl: config.hubUrl,
    projectRoot: config.projectRoot,
  };
}
