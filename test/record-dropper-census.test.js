const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const CALL = /getPersistence\(\)\.remove\(|\bpersistence\.remove\(/;
const NAMED = [
  /^\s*(?:async\s+)?(?:function\s*\*?\s*)?([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{\s*$/,
  /^\s*(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[\w$]+)\s*=>\s*\{\s*$/,
  /^\s*handle\('([^']+)'/,
];
const NOT_A_NAME = new Set(['if', 'for', 'while', 'switch', 'catch', 'with', 'function']);
const count = (l, ch) => l.split(ch).length - 1;

function enclosing(lines, i) {
  let depth = 0;
  for (let j = i - 1; j >= 0; j--) {
    depth += count(lines[j], '}') - count(lines[j], '{');
    if (depth >= 0) continue;
    depth = 0;
    for (const re of NAMED) {
      const m = re.exec(lines[j]);
      if (m && !NOT_A_NAME.has(m[1])) return m[1];
    }
  }
  return '<top>';
}

function census() {
  const files = execFileSync('git', ['ls-files', '*.js'], { cwd: ROOT, encoding: 'utf-8' })
    .split('\n').filter((f) => f && !/(^|\/)test\//.test(f));
  const out = [];
  for (const f of files) {
    const lines = fs.readFileSync(path.join(ROOT, f), 'utf-8').split('\n');
    lines.forEach((l, i) => { if (CALL.test(l)) out.push(`${f}:${enclosing(lines, i)}`); });
  }
  return out;
}

test('every record-dropper call site is on the docs/sessions.md list', () => {
  assert.deepStrictEqual(census(), [
    'ipc-handlers.js:session:forget',
    'remote-wiring.js:importCreate',
    'scratch-clone.js:_scratchCloneRetire',
    'session-manager.js:onProcExit',
    'session-manager.js:kill',
    'session-manager.js:dropRecord',
    'session-manager.js:purgeWorkspace',
    'team-tickets.js:sweepReviewerGraveyard',
    'team-tickets.js:_handleTeamReview',
    'team-tickets.js:_spawnTicketSeat',
    'team-tickets.js:_spawnTicketSeat',
    'team-tickets.js:_spawnTicketSeat',
  ]);
});
