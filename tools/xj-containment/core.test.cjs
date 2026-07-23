const test = require('node:test');
const assert = require('node:assert/strict');
const {
  updateSettings,
  removeXjChat,
  restoreLineByMarker,
  assertNoInjectionMarkers,
} = require('./core.cjs');

test('updateSettings disables only XJ injection/install switches', () => {
  const input = {
    'xjCursor.update.autoCheck': true,
    'xjCursor.mcpStable.enabled': true,
    unrelated: { keep: 'exactly' },
  };
  const output = updateSettings(input);
  assert.equal(output['xjCursor.rules.enabled'], false);
  assert.equal(output['xjCursor.mcpStable.enabled'], false);
  assert.equal(output['xjCursor.update.autoInstall'], false);
  assert.equal(output['xjCursor.update.autoCheck'], true);
  assert.deepEqual(output.unrelated, input.unrelated);
});

test('removeXjChat removes only the xj-chat server', () => {
  const input = {
    mcpServers: {
      alpha: { command: 'alpha' },
      'xj-chat': { command: 'xj' },
      omega: { url: 'https://example.invalid/mcp' },
    },
  };
  const { config, removed } = removeXjChat(input);
  assert.deepEqual(removed, { command: 'xj' });
  assert.deepEqual(config.mcpServers, {
    alpha: { command: 'alpha' },
    omega: { url: 'https://example.invalid/mcp' },
  });
});

test('restoreLineByMarker replaces only the marked current line', () => {
  const current = ['head', 'before /*CURSOR_MCP_LEASE_GUARD*/ return after', 'tail'].join('\n');
  const backup = ['head', 'before originalLeaseBehavior() after', 'tail'].join('\n');
  assert.equal(
    restoreLineByMarker(current, backup, 'CURSOR_MCP_LEASE_GUARD'),
    backup,
  );
});

test('restoreLineByMarker refuses zero or multiple marker occurrences', () => {
  assert.throws(() => restoreLineByMarker('clean', 'clean', 'MARK'), /exactly once/);
  assert.throws(
    () => restoreLineByMarker('MARK\nMARK', 'a\nb', 'MARK'),
    /exactly once/,
  );
});

test('assertNoInjectionMarkers rejects every known marker', () => {
  for (const marker of [
    'CURSOR_AGENTRULES_NP_START',
    'CURSOR_AGENTRULES_NP_END',
    'CURSOR_MCP_CREATE_DEDUPE',
    'CURSOR_MCP_LEASE_GUARD',
    'CURSOR_MCP_UNSUB_GRACE',
    'CURSOR_MCP_SANDBOX_GUARD',
  ]) {
    assert.throws(() => assertNoInjectionMarkers(`x ${marker} y`), new RegExp(marker));
  }
});
