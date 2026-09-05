// `[agent:spawn template:<plugin>:<stem>]` — t681 nit 4.
//
// _handleSpawnIntent's inline-name branch read getTemplates().list(), so a
// spawn intent could not name a plugin template while a role could
// (_templateShape already routes through the shared allTemplates() seam).
// This drives the real intent handler with listAllTemplates() supplying a
// plugin-only row, the shape _handleSpawnIntent's own lookup performs.

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

const { createSessionManager } = require('../session-manager');

function harness({ listAllTemplates } = {}) {
  const calls = [];
  const replies = [];
  const SessionManager = createSessionManager({
    os,
    fs,
    path,
    log: { warn() {}, info() {}, error() {} },
    getPersistence: () => ({ get: () => null, setStripLevel() {}, setAutoCompact() {} }),
    getTemplates: () => ({ list: () => [] }),
    withoutPrivilegedIntentsFor: (x) => x,
    ensureDir: () => {},
    AGENT_NAME_RE: /^[a-zA-Z0-9._-]{1,64}$/,
    DEFAULT_WORKSPACE_ID: 'default',
    listAllTemplates,
  });
  const m = new SessionManager();
  m.sessions = new Map();
  m._injectText = (_s, t) => replies.push(t);
  m._broadcast = () => {};
  m._sendToSession = () => {};
  m.create = async (...args) => { calls.push(args); return undefined; };
  return { m, calls, replies };
}

const CWD_ARG = 2; // 0-based index of cwd in create()'s signature

test('a spawn intent naming <plugin>:<stem> resolves through listAllTemplates', async () => {
  const pluginTpl = { name: 'rev:audit', id: 'rev:audit', plugin: 'rev', type: 'claude', cwd: os.tmpdir() };
  const { m, calls, replies } = harness({ listAllTemplates: () => [pluginTpl] });

  m._handleSpawnIntent(
    { name: 'lead', cwd: os.tmpdir(), workspaceId: 'default', type: 'claude' },
    { name: 'child', template: 'rev:audit' },
  );
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));

  assert.strictEqual(calls.length, 1, `create was called (replies: ${JSON.stringify(replies)})`);
  assert.strictEqual(calls[0][CWD_ARG], os.tmpdir(), 'the plugin template\'s own cwd was picked up');
});

test('without listAllTemplates, a spawn intent naming a plugin template is refused', () => {
  // CONTROL: the library-only fallback (getTemplates().list(), empty here)
  // cannot see the plugin row, so the refusal must name it as unknown rather
  // than silently resolve some other template.
  const { m, calls, replies } = harness({});

  m._handleSpawnIntent(
    { name: 'lead', cwd: os.tmpdir(), workspaceId: 'default', type: 'claude' },
    { name: 'child', template: 'rev:audit' },
  );

  assert.strictEqual(calls.length, 0, 'no session may be created for an unresolvable template');
  assert.strictEqual(replies.length, 1);
  assert.match(replies[0], /no template named "rev:audit"/);
});
