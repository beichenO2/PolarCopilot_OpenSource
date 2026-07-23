import { describe, expect, it } from 'vitest';
import { advanceAutomation } from '../../src/xj/automation.js';

describe('advanceAutomation', () => {
  const base = {
    enabled: true,
    state: 'running' as const,
    loop: 2,
    loopLimit: 5,
    acceptanceCriteria: ['tests pass', 'build passes'],
    completedCriteria: ['tests pass'],
    todo: ['run build'],
    negativeKnowledge: [],
    updatedAt: '2026-07-24T00:00:00.000Z',
  };

  it('continues with the next todo while frozen acceptance criteria are incomplete', () => {
    const next = advanceAutomation(base, { outcome: 'passed', summary: 'tests passed' });
    expect(next.state).toBe('running');
    expect(next.loop).toBe(3);
    expect(next.acceptanceCriteria).toEqual(base.acceptanceCriteria);
  });

  it('pauses at the loop limit instead of claiming completion', () => {
    const next = advanceAutomation({ ...base, loop: 4 }, { outcome: 'failed', summary: 'build failed', failedPath: 'vite build' });
    expect(next.state).toBe('paused');
    expect(next.pauseReason).toBe('loop_limit');
    expect(next.negativeKnowledge).toContain('vite build');
    expect(next.loop).toBe(5);
  });

  it('only marks done when all frozen criteria are completed', () => {
    const next = advanceAutomation(
      { ...base, completedCriteria: ['tests pass', 'build passes'], todo: [] },
      { outcome: 'passed', summary: 'all gates green' },
    );
    expect(next.state).toBe('done');
  });
});
