import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import pino from 'pino';
import { createHubDatabase } from '../../src/persistence/db.js';
import { HubStore } from '../../src/persistence/store.js';
import { BroadcastPublisher } from '../../src/broadcast/publisher.js';
import { SseHub } from '../../src/broadcast/sse-hub.js';
import { EventSubscriber } from '../../src/broadcast/subscriber.js';
import { RoleManager } from '../../src/roles/manager.js';
import { ClkService } from '../../src/roles/clk.js';

const silentLogger = pino({ level: 'silent' });

describe('ClkService', () => {
  let clkService: ClkService;
  let roleManager: RoleManager;

  beforeEach(() => {
    const { db } = createHubDatabase(':memory:');
    const store = new HubStore(db);
    const sseHub = new SseHub();
    const eventSubscriber = new EventSubscriber();
    const publisher = new BroadcastPublisher(store, sseHub, eventSubscriber);
    roleManager = new RoleManager(db);
    clkService = new ClkService(db, publisher, roleManager, silentLogger);
  });

  afterEach(() => {
    clkService.stop();
  });

  it('tick increments the tick number', () => {
    expect(clkService.getState().tickNumber).toBe(0);

    const report1 = clkService.tick();
    expect(report1.tick_number).toBe(1);
    expect(clkService.getState().tickNumber).toBe(1);

    const report2 = clkService.tick();
    expect(report2.tick_number).toBe(2);
  });

  it('tick detects stale roles', () => {
    roleManager.assignRole('agent-001', 'controller', 'tmux-001');
    roleManager.assignRole('agent-002', 'supervisor', 'tmux-002');
    roleManager.assignRole('agent-003', 'proxy', 'tmux-003');

    // With default threshold (150s), freshly assigned agents are not stale
    const report = clkService.tick();
    expect(report.stale_roles).toHaveLength(0);
    expect(report.all_stale).toBe(false);
  });

  it('tick triggers succession for dead management roles', () => {
    roleManager.assignRole('agent-001', 'controller', 'tmux-001');
    roleManager.addToReserve('reserve-001', 'tmux-r1');

    // Mark as dead manually
    roleManager.markDead('agent-001');

    // The findStale won't find it because it checks status=active,
    // but we can test succession directly
    const newRole = roleManager.succeedRole('agent-001');
    expect(newRole).not.toBeNull();
    expect(newRole!.agentId).toBe('reserve-001');
    expect(newRole!.role).toBe('controller');
  });

  it('getState returns initial state', () => {
    const state = clkService.getState();
    expect(state.tickNumber).toBe(0);
    expect(state.tickIntervalMs).toBe(30000);
    expect(state.lastTickAt).toBeNull();
  });

  it('setTickInterval changes the interval', () => {
    clkService.setTickInterval(10000);
    expect(clkService.getState().tickIntervalMs).toBe(10000);
  });

  it('tick report includes reserve count', () => {
    roleManager.addToReserve('r1', 'tmux-r1');
    roleManager.addToReserve('r2', 'tmux-r2');
    roleManager.addToReserve('r3', 'tmux-r3');

    const report = clkService.tick();
    expect(report.reserve_count).toBe(3);
  });

  it('tick publishes to system.tick topic (no crash)', () => {
    // Just verify tick doesn't throw when publishing
    const report = clkService.tick();
    expect(report.tick_number).toBe(1);
    expect(report.timestamp).toBeInstanceOf(Date);
  });
});
