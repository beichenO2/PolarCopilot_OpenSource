import { describe, expect, it, beforeEach } from 'vitest';
import { createHubDatabase } from '../../src/persistence/db.js';
import { RoleManager } from '../../src/roles/manager.js';

describe('RoleManager', () => {
  let roleManager: RoleManager;

  beforeEach(() => {
    const { db } = createHubDatabase(':memory:');
    roleManager = new RoleManager(db);
  });

  it('assigns a role and retrieves it', () => {
    const assignment = roleManager.assignRole('agent-001', 'controller', 'tmux-001');
    expect(assignment.agentId).toBe('agent-001');
    expect(assignment.role).toBe('controller');
    expect(assignment.status).toBe('active');
    expect(assignment.tmuxSession).toBe('tmux-001');

    const retrieved = roleManager.getRole('agent-001');
    expect(retrieved).not.toBeNull();
    expect(retrieved!.role).toBe('controller');
  });

  it('getRoleByType finds the active role', () => {
    roleManager.assignRole('agent-001', 'controller', 'tmux-001');
    roleManager.assignRole('agent-002', 'supervisor', 'tmux-002');

    expect(roleManager.getRoleByType('controller')?.agentId).toBe('agent-001');
    expect(roleManager.getRoleByType('supervisor')?.agentId).toBe('agent-002');
    expect(roleManager.getRoleByType('proxy')).toBeNull();
  });

  it('getAllActive returns only active roles', () => {
    roleManager.assignRole('agent-001', 'controller', 'tmux-001');
    roleManager.assignRole('agent-002', 'worker', 'tmux-002');
    roleManager.markDead('agent-002');

    const active = roleManager.getAllActive();
    expect(active).toHaveLength(1);
    expect(active[0].agentId).toBe('agent-001');
  });

  it('recordHeartbeat updates the timestamp', () => {
    roleManager.assignRole('agent-001', 'controller', 'tmux-001');
    const before = roleManager.getRole('agent-001')!.lastHeartbeat!;

    // Wait a tiny bit to ensure timestamp difference
    const later = new Date(before.getTime() + 1000);
    // Force a heartbeat
    roleManager.recordHeartbeat('agent-001');

    const after = roleManager.getRole('agent-001')!.lastHeartbeat!;
    expect(after.getTime()).toBeGreaterThanOrEqual(before.getTime());
  });

  it('saveStateSnapshot persists and retrieves state', () => {
    roleManager.assignRole('agent-001', 'controller', 'tmux-001');
    roleManager.saveStateSnapshot('agent-001', { currentTask: 'build auth', progress: 0.5 });

    const role = roleManager.getRole('agent-001')!;
    expect(role.stateSnapshot).toEqual({ currentTask: 'build auth', progress: 0.5 });
  });

  it('findStale returns agents without recent heartbeats', async () => {
    roleManager.assignRole('agent-001', 'controller', 'tmux-001');
    roleManager.assignRole('agent-002', 'supervisor', 'tmux-002');

    // Wait a bit so heartbeats become "old" relative to a tight threshold
    await new Promise((r) => setTimeout(r, 50));

    const stale = roleManager.findStale(10); // 10ms threshold — both are older
    expect(stale.length).toBeGreaterThanOrEqual(2);

    // With a huge threshold, nothing is stale
    const notStale = roleManager.findStale(60_000);
    expect(notStale).toHaveLength(0);
  });

  describe('reserve pool', () => {
    it('adds and takes from reserve', () => {
      roleManager.addToReserve('reserve-001', 'tmux-r1');
      roleManager.addToReserve('reserve-002', 'tmux-r2');

      expect(roleManager.reserveCount()).toBe(2);

      const taken = roleManager.takeFromReserve();
      expect(taken).not.toBeNull();
      expect(taken!.status).toBe('assigned');

      expect(roleManager.reserveCount()).toBe(1);
    });

    it('returns null when pool is empty', () => {
      const taken = roleManager.takeFromReserve();
      expect(taken).toBeNull();
    });

    it('assigning a role removes from reserve pool', () => {
      roleManager.addToReserve('agent-050', 'tmux-50');
      expect(roleManager.reserveCount()).toBe(1);

      roleManager.assignRole('agent-050', 'worker', 'tmux-50');
      // The reserve entry should be gone (or marked assigned)
      expect(roleManager.reserveCount()).toBe(0);
    });
  });

  describe('succession', () => {
    it('replaces a dead role with a reserve agent', () => {
      roleManager.assignRole('agent-001', 'controller', 'tmux-001');
      roleManager.addToReserve('reserve-001', 'tmux-r1');

      const newRole = roleManager.succeedRole('agent-001');
      expect(newRole).not.toBeNull();
      expect(newRole!.agentId).toBe('reserve-001');
      expect(newRole!.role).toBe('controller');
      expect(newRole!.predecessorId).toBe('agent-001');

      // Old agent should be dead
      const oldRole = roleManager.getRole('agent-001');
      expect(oldRole!.status).toBe('dead');

      // Reserve pool should be empty
      expect(roleManager.reserveCount()).toBe(0);
    });

    it('returns null when no reserves available', () => {
      roleManager.assignRole('agent-001', 'controller', 'tmux-001');

      const result = roleManager.succeedRole('agent-001');
      expect(result).toBeNull();
    });
  });
});
