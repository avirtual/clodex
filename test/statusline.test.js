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
  assert.ok(script.includes('/reg/dir/run/agentx/ctx'), 'side-channel path uses the per-agent run dir (clodex-paths)');
  assert.ok(script.includes('[clodex:agentx]'), 'session name prefix present');
  // enabled components appear in the printf line
  assert.ok(script.includes('$MODEL'));
  assert.ok(script.includes('$CTX_PCT'));
  // a disabled visible cost component does not appear (the side-channel var
  // ${COST_USD} does not contain the literal $COST, so this still holds)
  assert.ok(!script.includes('$COST'));
  // the raw cost ALWAYS rides the side-channel (independent of the visible
  // cost component) so a wire-off session can surface it in the statusbar
  assert.ok(script.includes('COST_USD'), 'raw cost captured for the side-channel');
  assert.ok(/printf '%s\\t%s\\t%s\\t%s\\t%s\\t%s'/.test(script), 'side-channel carries six tab-separated fields incl. cost + model');
});

test('renderClaudeStatusScript: headless suppresses the visible component line but keeps the side-channel', () => {
  const ui = fakeUi({ claude: ['model', 'cost'], claudeCommand: '' });
  const headless = renderClaudeStatusScript('h', true, ui, '/d');
  assert.ok(headless.includes('/d/run/h/ctx'), 'side-channel still written under headless');
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

test('setupClaudeHook: a wire-routed seat with no proxyBase gets the headless statusline', () => {
  const fs = require('fs');
  const { createCliHooks } = require('../cli-hooks');
  const { pathFor } = require('../clodex-paths');
  const { mkTmpRoot } = require('./lib/tmp-roots');
  const REGISTRY_DIR = mkTmpRoot('clodex-hooks-');
  const h = createCliHooks({
    REGISTRY_DIR,
    memoryStore: { list: () => [] },
    getUiSettings: () => fakeUi({ claude: ['model'], claudeCommand: '' }),
    nodeInterp: process.execPath,
  });
  h.setupClaudeHook('wired', null, null, [], [], [], 'http://127.0.0.1:7801/w/wired');
  h.setupClaudeHook('plain');
  const wired = fs.readFileSync(pathFor(REGISTRY_DIR, 'wired', 'statusline'), 'utf-8');
  const plain = fs.readFileSync(pathFor(REGISTRY_DIR, 'plain', 'statusline'), 'utf-8');
  assert.ok(wired.includes('headless: side-channel only'), 'wire-only seat renders headless');
  assert.ok(!plain.includes('headless: side-channel only'), 'an unrouted seat keeps the component line');
});

test('rebuildAllStatusScripts: a wire-routed seat with no proxyBase stays headless after a settings save', () => {
  const fs = require('fs');
  const path = require('path');
  const { createEngine } = require('../engine');
  const { pathFor, runDirFor } = require('../clodex-paths');
  const { mkTmpRoot } = require('./lib/tmp-roots');
  const tmp = mkTmpRoot('clodex-hooks-');
  const home = path.join(tmp, 'clodex-home');
  const userData = path.join(tmp, 'userdata');
  fs.mkdirSync(userData, { recursive: true });
  const eng = createEngine({ userDataPath: userData, seams: { registryDir: home }, log: { info() {}, warn() {}, error() {} } });
  fs.mkdirSync(runDirFor(home, 'w'), { recursive: true });
  fs.mkdirSync(runDirFor(home, 'p'), { recursive: true });
  eng.rebuildAllStatusScripts({ sessions: new Map([
    ['w', { agentType: 'claude', wireRouted: true, proxyBase: null }],
    ['p', { agentType: 'claude', wireRouted: false, proxyBase: null }],
  ]) });
  assert.ok(fs.readFileSync(pathFor(home, 'w', 'statusline'), 'utf-8').includes('headless: side-channel only'), 'wire-only seat stays headless');
  assert.ok(!fs.readFileSync(pathFor(home, 'p', 'statusline'), 'utf-8').includes('headless: side-channel only'), 'an unrouted seat keeps the component line');
});
