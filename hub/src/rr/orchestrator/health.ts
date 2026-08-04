import { loadConfig } from './config.js';
import { readActiveTaskSnapshots, readAfkSnapshot } from './afk-state.js';
import { isOrchestratorEnabled, readEnabledSince } from './toggle.js';
import { getTaskOrchestratorState, loadState } from './state.js';

export function readOrchestratorHealth(projectRoot?: string) {
  const config = loadConfig(projectRoot);
  const state = loadState(config.statePath);
  const activeTasks = readActiveTaskSnapshots(config);
  const legacyAfk = readAfkSnapshot(config);
  const enabled = isOrchestratorEnabled();

  const anyTaskActive = activeTasks.length > 0
    || (legacyAfk.active && !legacyAfk.paused && !legacyAfk.done);

  const isTaskEligible = (task: (typeof activeTasks)[number]): boolean => {
    const taskId = task.taskId ?? task.primarySummary?.task_id;
    if (!taskId) return false;
    if (task.paused || task.done || !task.active) return false;
    return !getTaskOrchestratorState(state, taskId).paused;
  };

  const eligibleActiveTasks = activeTasks.filter(isTaskEligible);
  const legacyEligible = activeTasks.length === 0
    && legacyAfk.active && !legacyAfk.paused && !legacyAfk.done;
  const anyEligibleActive = eligibleActiveTasks.length > 0 || legacyEligible;

  const allTasksDone = activeTasks.length > 0
    ? activeTasks.every((task) => task.done)
    : legacyAfk.done;

  const anyTaskPaused = activeTasks.some((task) => task.paused)
    || legacyAfk.paused;

  const anyTaskOrchestratorPaused = activeTasks.some((task) => {
    const taskId = task.taskId ?? task.primarySummary?.task_id;
    if (!taskId) return false;
    return getTaskOrchestratorState(state, taskId).paused;
  });

  const globallyPaused = state.paused;
  const paused = globallyPaused || (!anyEligibleActive && (anyTaskPaused || anyTaskOrchestratorPaused));

  return {
    ok: enabled && anyEligibleActive && !globallyPaused && !allTasksDone,
    enabled,
    enabledSince: readEnabledSince(),
    paused,
    done: allTasksDone && !anyTaskActive,
    afkActive: anyTaskActive,
    eligibleActiveTaskCount: eligibleActiveTasks.length,
    activeTaskCount: activeTasks.length,
    loopCount: state.loopCount,
    lastTickAt: state.lastTickAt,
    lastAction: state.lastAction,
    lastSessionId: state.lastSessionId,
    hubUrl: config.hubUrl,
    projectRoot: config.projectRoot,
  };
}
