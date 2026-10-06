'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { mkTmpRoot } = require('./lib/tmp-roots');
const { scanIntentLines } = require('../intent-segments');
const registry = require('../intent-registry');
const { createIntentRequestHandler, composeSubagentBrief } = require('../intent-socket');
const mcp = require('../cli/bin/clodex-mcp.js');

const ROOT = path.join(__dirname, '..');
const TOKENS = ['[agent:browser', 'browser-pane', 'SUBAGENT_SUBS', 'BROWSER_VERBS', 'release is for', '--confirm', "'browser'"];
const EXCLUDED = /^(plugins\/browser-pane\/|test\/|manual\/|web-dist\/)/;
const ALLOW = [
  ['renderer/web/plugin-registry.js', 'browser-pane', "the web bundle's renderer-half map names every shipped plugin with a renderer"],
  ['build/build-web.js', "'browser'", "esbuild platform: 'browser' is the web platform, not the plugin"],
];
const MUST_SCAN = ['intent-registry.js', 'intent-socket.js', 'session-manager.js', 'cli-hooks.js', 'cli/bin/clodex.js', 'cli/bin/clodex-mcp.js', 'proxy-util.js'];

function scanned() {
  return execFileSync('git', ['ls-files', '-z', '*.js'], { cwd: ROOT, encoding: 'utf8' }).split('\0').filter((f) => f && !EXCLUDED.test(f));
}

test('core carries no browser-plugin knowledge: tracked .js outside the plugin names none of its tokens', () => {
  const files = scanned();
  for (const f of MUST_SCAN) assert.ok(files.includes(f), `scan must cover ${f}`);
  const hits = [];
  for (const f of files) {
    const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
    for (const t of TOKENS) if (src.includes(t)) hits.push([f, t]);
  }
  const allowed = (f, t) => ALLOW.some(([af, at]) => af === f && at === t);
  assert.deepStrictEqual(hits.filter(([f, t]) => !allowed(f, t)), []);
  assert.deepStrictEqual(ALLOW.filter(([af, at]) => !hits.some(([f, t]) => f === af && t === at)), [], 'an allowlist row no longer needed');
});

function parse(text) {
  return scanIntentLines(text.split('\n'), {}).filter((s) => s.kind === 'intent').map((s) => s.intent);
}

test('with no plugin registered, core knows no browser verb, tool or brief', async () => {
  registry._resetPluginRows();
  assert.strictEqual(registry.pluginRowFor('browser'), null);
  assert.deepStrictEqual(registry.subagentCatalogFor({ intents: ['browser'], plugins: ['browser-pane'] }), { tools: [], briefs: [] });
  assert.strictEqual(composeSubagentBrief([]), '');
  const seen = [];
  const handle = createIntentRequestHandler({
    seat: 'h1', parse, entryOf: () => ({ intents: ['browser'], plugins: ['browser-pane'] }), sessionIdOf: () => 'main-thread',
    cred: 'h'.repeat(64), crypto, log: { warn: () => {} }, refusal: registry.subagentRefusal,
    tools: { rowFor: registry.toolRowFor, intentFor: registry.toolIntentFor, enabled: registry.intentEnabledForSeat },
    dispatch: async (intent, opts) => { seen.push(intent.raw); opts.replyTo('ok'); },
  });
  const ctl = { closed: () => false };
  assert.deepStrictEqual(await handle({ tool: 'browser', args: { verb: 'read' } }, ctl), { ok: false, status: 'refused', error: 'unknown tool: "browser"' });
  assert.deepStrictEqual(await handle({ intent: '[agent:browser read x]' }, ctl), { ok: false, error: 'no [agent:…] intent in the request' });
  assert.deepStrictEqual(seen, []);
});

test('the MCP server lists an empty catalog as no tools', async () => {
  const root = mkTmpRoot('verb-');
  fs.writeFileSync(path.join(root, 'mcp-tools.json'), JSON.stringify({ v: 1, rev: 'e', tools: [], briefs: [] }));
  const output = { write: () => {} };
  const s = mcp.createServer({ input: null, output, errOut: output, setInterval: () => null, clearInterval: () => {}, env: { CLODEX_INTENT_SOCK: path.join(root, 'i.sock'), CLODEX_INTENT_CRED: 'k1' } });
  const r = await s.handle({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
  assert.deepStrictEqual(r.result.tools, []);
});
