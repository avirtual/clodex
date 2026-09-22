'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

test('m0: renderer.js gates the warmth segment on caps.warmth, not on a codex literal', () => {
  const src = read('renderer/renderer.js');
  assert.ok(!src.includes("!== 'codex'"), "renderer.js carries no `!== 'codex'`");
  assert.match(src, /if \(p\.warmth && adapterFor\(sessionTypeOf\(activeSession\)\)\?\.caps\.warmth\)/);
});

test('m0: session-manager.js resolves a restored seat type through isAgentType', () => {
  const src = read('session-manager.js');
  assert.ok(!src.includes("entry.type === 'claude' || entry.type === 'codex'"));
  assert.ok(!src.includes("rs.type === 'claude' || rs.type === 'codex'"));
  assert.ok(!src.includes("type === 'claude' ? mergedEnv.CLAUDE_CONFIG_DIR"));
  assert.strictEqual(src.split('agentType: isAgentType(entry.type) ? entry.type : null,').length - 1, 2);
});

test('m0: team-tickets.js reads posture and the cwd dir from the adapter', () => {
  const src = read('team-tickets.js');
  assert.ok(!src.includes('bypassFlag'));
  assert.ok(!src.includes("shape.type === 'codex'"));
  assert.ok(!src.includes('ignoreCodexDir'));
  assert.strictEqual(src.split('hasBypass(').length - 1, 2);
});
