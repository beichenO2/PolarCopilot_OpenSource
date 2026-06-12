import type { HubConfig, InterventionBehavior, WorkflowStage } from '../types.js';

export function behaviorForStage(config: HubConfig, stage: WorkflowStage): InterventionBehavior {
  return config.intervention_matrix[stage];
}
