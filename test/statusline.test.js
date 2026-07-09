// Run: node --test
// Covers statusline generation + proxy-base resolution. The ui-settings store
// and registry dir are injected, so the script output is testable with a fake
// settings object — no Electron, no real ~/.clodex.
const { test } = require('node:test');
const assert = require('node:assert');
const {
  renderClaudeStatusScript, codexStatusLineArg, normalizeProxyBase, resolveProxyBase,
} = require('../statusline');

const fakeUi = (statusline, extra = {}) => ({ get: () => ({ statusline, ...extra }) });

test('renderClaudeStatusScript: writes the ctx side-channel to the injected dir', () => {
  const ui = fakeUi({ claude: ['model', 'context'], claudeCommand: '' });
  const script = renderClaudeStatusScript('agentx', false, ui, '/reg/dir');
  assert.ok(script.startsWith('#!/bin/bash'));
  assert.ok(script.includes('/reg/dir/agentx-ctx'), 'side-channel path uses injected registryDir + name');
  assert.ok(script.includes('[clodex:agentx]'), 'session name prefix present');
  // enabled components appear in the printf line
  assert.ok(script.includes('$MODEL'));
  assert.ok(script.includes('$CTX_PCT'));
  // a disabled component does not
  assert.ok(!script.includes('$COST'));
});

test('renderClaudeStatusScript: headless suppresses the visible component line but keeps the side-channel', () => {
  const ui = fakeUi({ claude: ['model', 'cost'], claudeCommand: '' });
  const headless = renderClaudeStatusScript('h', true, ui, '/d');
  assert.ok(headless.includes('/d/h-ctx'), 'side-channel still written under headless');
  assert.ok(headless.includes('headless: side-channel only'), 'component line replaced by the headless no-op');
  assert.ok(!/printf '.*\$MODEL/.test(headless), 'no visible component printf under headless');
});

test('renderClaudeStatusScript: custom command becomes a wrapper', () => {
  const ui = fakeUi({ claude: ['model'], claudeCommand: 'my-statusline.sh' });
  const script = renderClaudeStatusScript('c', false, ui, '/d');
  assert.ok(script.includes('export CLODEX_AGENT_NAME="c"'));
  assert.ok(script.includes('my-statusline.sh'));
});

test('codexStatusLineArg: quotes and joins the codex component list', () => {
  const ui = fakeUi({ codex: ['dir', 'model', 'usage'] });
  assert.strictEqual(codexStatusLineArg(ui), 'tui.status_line=["dir","model","usage"]');
});

test('normalizeProxyBase: trims, drops trailing slashes, blank -> null', () => {
  assert.strictEqual(normalizeProxyBase('  http://x:1/  '), 'http://x:1');
  assert.strictEqual(normalizeProxyBase('http://x:1///'), 'http://x:1');
  assert.strictEqual(normalizeProxyBase(''), null);
  assert.strictEqual(normalizeProxyBase(null), null);
});

test('resolveProxyBase: tri-state — false off, string explicit, null follows pref', () => {
  const ui = fakeUi({}, { proxyEnabled: true, proxyUrl: 'http://pref:9/' });
  assert.strictEqual(resolveProxyBase(false, ui), null);
  assert.strictEqual(resolveProxyBase('http://explicit:2/', ui), 'http://explicit:2');
  assert.strictEqual(resolveProxyBase(null, ui), 'http://pref:9');
  assert.strictEqual(resolveProxyBase(undefined, ui), 'http://pref:9');
});

test('resolveProxyBase: null with the global pref disabled resolves to null', () => {
  const ui = fakeUi({}, { proxyEnabled: false, proxyUrl: 'http://pref:9' });
  assert.strictEqual(resolveProxyBase(null, ui), null);
});
