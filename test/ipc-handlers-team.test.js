'use strict';

// team:addRole — the OPERATOR DOOR, driven through the real handler against the
// real team-manifest on a tmp ~/.clodex.
//
// Both halves matter and only the pair is meaningful, so neither is stubbed: the
// handler decides whether to substitute a stock def, and team-manifest decides
// what a def is allowed to do. Stubbing addRole would let this file assert the
// handler's intent while the manifest quietly refused it — which is the shape of
// bug team-hand-template-portable.test.js was widened to catch once already.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createTeamManifest, STOCK_ROLE_DEFS } = require('../team-manifest');
const { registerIpcHandlers } = require('../ipc-handlers');

// A team on disk plus the handler map, wired to the REAL manifest module.
// `roles` is the team.json as authored; the returned `read()` re-reads the file
// so assertions see what was WRITTEN, not what the handler returned.
function mkDoor(roles) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ipc-team-home-'));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ipc-team-root-'));
  const dir = path.join(home, 'teams', 't');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'team.json');
  fs.writeFileSync(file, JSON.stringify({ root, lead: 'l', roles }, null, 2));

  const tm = createTeamManifest({ fs, clodexHome: home });
  const handlers = new Map();
  registerIpcHandlers({
    handle: (ch, fn) => handlers.set(ch, fn),
    on: (ch, fn) => handlers.set(ch, fn),
    log: { info() {}, error() {}, warn() {} },
    loadManifest: tm.loadManifest,
    addRole: tm.addRole,
  });
  return {
    addRole: (role, def) => handlers.get('team:addRole')(null, 't', role, def),
    read: () => JSON.parse(fs.readFileSync(file, 'utf-8')).roles,
    cleanup: () => {
      fs.rmSync(home, { recursive: true, force: true });
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

const LEAD_ONLY = { lead: { prompt: 'clodex-team-lead' } };

test('team:addRole with an EMPTY def mints the stock def — the offer card cannot write an unbriefed hand', () => {
  const d = mkDoor({ ...LEAD_ONLY });
  try {
    // Exactly what the offer card's Enable button posts.
    const res = d.addRole('hand', {});
    assert.strictEqual(res.ok, true, `expected ok (got: ${res.error})`);
    const written = d.read().hand;
    assert.ok(written, 'the hand role was written');
    // The prompt is the whole point: an empty def writes a role that exists,
    // spawns, and boots with no brief at all.
    assert.strictEqual(written.prompt, STOCK_ROLE_DEFS.hand.prompt,
      'the stock prompt reached disk, not null');
    for (const [k, v] of Object.entries(STOCK_ROLE_DEFS.hand)) {
      assert.deepStrictEqual(written[k], v, `stock field ${k} survived the write`);
    }
  } finally { d.cleanup(); }
});

test('team:addRole with a NON-EMPTY def honours it verbatim — the substitution never blends', () => {
  const d = mkDoor({ ...LEAD_ONLY });
  try {
    const res = d.addRole('hand', { prompt: 'my-own-prompt', brief: 'mine' });
    assert.strictEqual(res.ok, true, `expected ok (got: ${res.error})`);
    const written = d.read().hand;
    assert.strictEqual(written.prompt, 'my-own-prompt', 'the caller\'s prompt was kept');
    assert.strictEqual(written.brief, 'mine');
    // A BLEND is the failure this asserts against: if the stock def were merged
    // under the caller's, the caller would silently inherit the stock template.
    assert.notStrictEqual(written.template, STOCK_ROLE_DEFS.hand.template,
      'no stock field leaked in beside the caller\'s');
  } finally { d.cleanup(); }
});

test('team:addRole on a RESERVED key still ignores its caller\'s def entirely', () => {
  // The security property, not a nicety: remove-then-re-add of a reviewer is
  // only safe because the re-mint writes Clodex's def and reads nothing of the
  // caller's. A def that survived here would be an authored reviewer — the
  // bypass the mint refusal exists to close.
  const d = mkDoor({ ...LEAD_ONLY });
  try {
    const res = d.addRole('reviewer', {
      prompt: 'attacker-prompt',
      brief: 'attacker brief',
      template: 'attacker-template',
    });
    assert.strictEqual(res.ok, true, `expected ok (got: ${res.error})`);
    const written = d.read().reviewer;
    assert.ok(written, 'the reviewer role was re-minted');
    assert.notStrictEqual(written.prompt, 'attacker-prompt', 'the caller\'s prompt did NOT land');
    assert.notStrictEqual(written.brief, 'attacker brief');
    assert.notStrictEqual(written.template, 'attacker-template');
    for (const [k, v] of Object.entries(STOCK_ROLE_DEFS.reviewer)) {
      assert.deepStrictEqual(written[k], v, `stock field ${k} is what reached disk`);
    }
  } finally { d.cleanup(); }
});

test('team:addRole leaves an EXISTING role alone — the stock def cannot rewrite or refuse a live team\'s hand', () => {
  // The seed-only property, and the reason the substitution is gated on ABSENCE
  // rather than on the def being empty alone. addRole is exact-match-or-throw, so
  // an empty re-add of a role authored empty is a NO-OP today; substituting the
  // stock def there would compare {prompt, brief, template} against all-nulls and
  // throw "already exists with a different definition" — the stock def refusing a
  // live team's role. A hand added through the Add Role form with blank fields is
  // exactly this shape on disk.
  const d = mkDoor({ ...LEAD_ONLY, hand: {} });
  try {
    const res = d.addRole('hand', {});
    assert.strictEqual(res.ok, true,
      `an empty re-add of an existing role must stay a no-op (got: ${res.error})`);
    // Nothing was written: the file still holds the team's own (empty) def, and
    // the stock prompt did NOT arrive behind the operator's back.
    assert.deepStrictEqual(d.read().hand, {}, 'the team\'s own definition is untouched');
  } finally { d.cleanup(); }
});
