'use strict';
// name-dot-only.test.js — t115. Every name gate in the app shares one grammar,
// and it used to admit `.`, `..` and any longer run of dots. Those are spelled
// entirely in [a-zA-Z0-9._-], so a charset filter cannot reject them; the shape
// is `/^(?!\.+$)[a-zA-Z0-9._-]{1,64}$/`.
//
// The gates are DELIBERATELY not collapsed into one shared constant (that is a
// separate design question about renderer↔main coupling), so this file pins the
// predicate at each one independently — a copy that drifts back is the failure
// this exists to catch.
//
// Both halves matter. The reject half is the fix; the ACCEPT half is what
// catches an over-eager one, because a naive `no dots anywhere` rule also
// passes every rejection case here while breaking `my.agent` and `.hidden`.

const test = require('node:test');
const assert = require('node:assert');

const DOTS = ['.', '..', '...', '....'];
// Dots in a legal position. `.hidden` is admitted on purpose: it was legal
// before this change and nothing here is a bare filesystem write of a hidden
// file — narrowing it would be a separate decision, not a bug fix.
const LEGAL = ['a.b', 'my.agent', '.hidden', '..a', 'a..', 'plain', 'a_b-c.d'];

function assertGrammar(re, label) {
  for (const n of DOTS) {
    assert.equal(re.test(n), false, `${label} must reject ${JSON.stringify(n)}`);
  }
  for (const n of LEGAL) {
    assert.equal(re.test(n), true, `${label} must still accept ${JSON.stringify(n)}`);
  }
  // The charset half is untouched by the fix and must stay that way.
  assert.equal(re.test('bad name'), false, `${label} still rejects a space`);
  assert.equal(re.test('a/b'), false, `${label} still rejects a separator`);
  assert.equal(re.test(''), false, `${label} still rejects empty`);
}

test('catalogs AGENT_NAME_RE rejects dot-only names', () => {
  const { AGENT_NAME_RE } = require('../catalogs');
  assertGrammar(AGENT_NAME_RE, 'AGENT_NAME_RE');
});

test('memory-store MEMORY_AGENT_RE rejects dot-only names', () => {
  // Not exported (module-private by design), so it is read off the source. A
  // literal read is honest here: the point is that THIS file's copy carries the
  // fix, and an export added later would still satisfy the assertion.
  assertGrammar(reFromSource('memory-store.js', 'MEMORY_AGENT_RE'), 'MEMORY_AGENT_RE');
});

test('stores PROMPT_NAME_RE rejects dot-only names', () => {
  assertGrammar(reFromSource('stores.js', 'PROMPT_NAME_RE'), 'PROMPT_NAME_RE');
});

test('remote NAME_RE rejects dot-only names', () => {
  assertGrammar(reFromSource('remote.js', 'NAME_RE'), 'remote NAME_RE');
});

test('peer-outbox ORIGIN_RE rejects dot-only names, and validOrigin agrees', () => {
  const { ORIGIN_RE, validOrigin } = require('../peer-outbox');
  assertGrammar(ORIGIN_RE, 'ORIGIN_RE');
  // validOrigin carried its own hand-rolled `!== '.' && !== '..'` pair — the
  // only dot check in the codebase that was correct. It must still refuse, and
  // must now also refuse `...`, which its pair never covered.
  for (const n of DOTS) {
    assert.equal(validOrigin(n), false, `validOrigin must reject ${JSON.stringify(n)}`);
  }
  assert.equal(validOrigin('peer.one'), true);
});

test('relay-protocol RELAY_NAME_RE rejects dot-only names', () => {
  const { RELAY_NAME_RE } = require('../relay-protocol');
  assertGrammar(RELAY_NAME_RE, 'RELAY_NAME_RE');
});

test('team-manifest NAME_RE rejects dot-only team names', () => {
  assertGrammar(reFromSource('team-manifest.js', 'NAME_RE'), 'team-manifest NAME_RE');
});

test('renderer team-roles NAME_RE rejects dot-only template names', () => {
  const { validateAddRole } = require('../renderer/lib/team-roles');
  // Reached through the real validator rather than the constant: this is the
  // renderer copy, and the constant being right is worth less than the seam
  // that uses it being right.
  for (const n of DOTS) {
    const r = validateAddRole({ name: 'worker', template: n });
    assert.equal(r.ok, false, `template ${JSON.stringify(n)} must be refused`);
  }
  assert.equal(validateAddRole({ name: 'worker', template: 'my.template' }).ok, true);
  // ROLE_RE (1-32) is NOT part of this change: a role name never becomes a path
  // segment on its own — seats are `<team>-<role>` — so a dot-only role is
  // harmless. Asserted so the omission reads as a decision, not an oversight.
  assert.equal(validateAddRole({ name: '..', template: '' }).ok, true);
});

// ── the literal copies with no exported constant ────────────────────────────
// These gates are inline regex literals inside DOM handlers (renderer.js,
// library-drawers.js) or a CLI arg parser. There is no seam to call, so the
// source text is the only reachable evidence. A source-text pin is weak — it
// cannot prove the gate RUNS — but it does catch the drift this ticket is
// about: a copy left on the old shape.

const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');

function reFromSource(rel, constName) {
  const src = fs.readFileSync(path.join(ROOT, rel), 'utf-8');
  const m = src.match(new RegExp(`${constName}\\s*=\\s*(/\\^.*?/)`));
  assert.ok(m, `${constName} not found as a regex literal in ${rel}`);
  // eslint-disable-next-line no-eval
  return eval(m[1]);
}

test('every inline name-gate literal in the tree carries the dot-only guard', () => {
  const FILES = [
    'renderer/renderer.js',
    'renderer/library-drawers.js',
    'ipc-handlers.js',
    'stores.js',
    'scripts/clodex-team.js',
    'cli/src/verbs.js',
    'cli/src/attach.js',
    'cli/src/deploy.js',
    'plugins/memory-viewer/engine.js',
    'catalogs.js',
    'remote.js',
    'memory-store.js',
    'peer-outbox.js',
    'relay-protocol.js',
    'team-manifest.js',
    'renderer/lib/team-roles.js',
  ];
  const OLD = /\^\[a-zA-Z0-9\._-\]\{1,64\}\$/;
  const stale = [];
  for (const rel of FILES) {
    const src = fs.readFileSync(path.join(ROOT, rel), 'utf-8');
    for (const [i, line] of src.split('\n').entries()) {
      // The comment in path-confine.js quotes the OLD shape deliberately, as
      // the thing it exists to replace; only executable copies are in scope.
      if (OLD.test(line) && !line.trim().startsWith('//')) {
        stale.push(`${rel}:${i + 1}`);
      }
    }
  }
  assert.deepEqual(stale, [],
    'these name gates still use the pre-t115 shape, which admits `.` and `..`: '
    + stale.join(', '));
});

test('the headless seed script rejects dot-only names too', () => {
  // clodex-seed.sh runs on a box with no Clodex and no node module graph, so
  // its gate is a bash =~ test. ERE has no lookahead: the dot-only half MUST be
  // a second clause, and a one-for-one port of the JS regex would silently
  // match nothing useful.
  const src = fs.readFileSync(path.join(ROOT, 'peering/clodex-seed.sh'), 'utf-8');
  const gates = src.split('\n').filter((l) => l.includes('[a-zA-Z0-9._-]{1,64}$') && l.includes('=~'));
  assert.equal(gates.length, 2, 'both name gates in the seed script are present');
  for (const g of gates) {
    assert.match(g, /\^\\\.\+\$/, `seed gate must carry the dot-only clause: ${g.trim()}`);
  }
});
