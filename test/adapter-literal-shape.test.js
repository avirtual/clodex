'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

test('m0: renderer.js gates the warmth segment on caps.warmth, not on a codex literal', () => {
  const src = read('renderer/renderer.js');
  assert.ok(!src.includes("!== 'codex'"), "renderer.js carries no `!== 'codex'`");
  assert.match(src, /if \(p\.warmth && adapterFor\(seatTypeOf\(activeSession\)\)\?\.caps\.warmth\)/);
});

test('the warmth gate is open for a peer seat whose far seat is a claude', () => {
  const src = read('renderer/renderer.js');
  const m = src.match(/\n  if \((p\.warmth && [^\n]*)\) \{\n/);
  assert.ok(m, 'ENTER: the warmth gate condition is found');
  const { adapterFor } = require('../cli-adapters');
  const env = {
    sessionTypeOf: () => 'remote',
    activeSession: 'p',
    sessions: new Map([['p', { peer: { id: 'b', name: 'x' } }]]),
    peerStatuses: new Map([['b', { sessions: [{ name: 'x', type: 'claude' }] }]]),
    adapterFor,
    p: { warmth: {} },
  };
  const helperAt = src.indexOf('\nfunction seatTypeOf(');
  const helper = helperAt < 0 ? '' : src.slice(helperAt, src.indexOf('\n}\n', helperAt) + 2);
  const names = Object.keys(env);
  const gate = new Function(...names, `${helper}\nreturn (${m[1]});`)(...names.map((n) => env[n]));
  assert.ok(gate);
});

test('m0: session-manager.js resolves a restored seat type through isAgentType', () => {
  const src = read('session-manager.js');
  assert.ok(!src.includes("entry.type === 'claude' || entry.type === 'codex'"));
  assert.ok(!src.includes("rs.type === 'claude' || rs.type === 'codex'"));
  assert.ok(!src.includes("type === 'claude' ? mergedEnv.CLAUDE_CONFIG_DIR"));
  assert.strictEqual(src.split('agentType: isAgentType(entry.type) ? entry.type : null,').length - 1, 2);
});

test('m0: ipc-handlers.js gates agent-only paths through isAgentType, not a claude||codex literal', () => {
  const src = read('ipc-handlers.js');
  assert.ok(!src.includes("entry.type === 'claude' || entry.type === 'codex'"));
  assert.ok(!src.includes("entry.type !== 'claude' && entry.type !== 'codex'"));
});

test('m0: team-tickets.js reads posture and the cwd dir from the adapter', () => {
  const src = read('team-tickets.js');
  assert.ok(!src.includes('bypassFlag'));
  assert.ok(!src.includes("shape.type === 'codex'"));
  assert.ok(!src.includes('ignoreCodexDir'));
  assert.strictEqual(src.split('hasBypass(').length - 1, 2);
});
