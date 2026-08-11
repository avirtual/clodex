// Run: node --test
//
// THE LEGIBILITY GATE. A role field may exist only if a front door sets it —
// otherwise the only way to reach it is hand-editing team.json, and a field
// nobody can set from the app is one nobody can see is broken. The nine-field
// schema grew that way: each field arrived reachable-in-principle, nothing ever
// checked, and five of them ended up consumed by no resolver at all while two
// display sites existed to paper over one that lied.
//
// So the check is mechanical, not prose. Three independent surfaces must agree
// with the schema's own key set:
//
//   1. setRole's EDITABLE list         (the intent/mutator front door)
//   2. the Add Role form's inputs      (renderer/index.html)
//   3. the popover's row model         (renderer/lib/team-roles.js)
//
// A field added to the schema and to none of these FAILS here. A field shown in
// the UI that the schema does not model FAILS here. The one legitimate gap —
// `worktree`, whose current semantics are superseded by per-ticket isolation —
// is named in UNREACHABLE_ROLE_FIELDS with a reason, so the gap is a declaration
// rather than an oversight, and a second one cannot join it silently.
//
// This is the test that makes the cut stick. Deleting it un-deletes the schema.

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const {
  ROLE_KEYS, EDITABLE_ROLE_FIELDS, UNREACHABLE_ROLE_FIELDS,
} = require('../team-manifest');
const { teamRoleRows } = require('../renderer/lib/team-roles');

const sorted = (it) => [...it].sort();

// The Add Role form's schema inputs, read from the DOM the operator actually
// uses rather than from a list in this file that could agree with nothing. The
// `name` input is the role KEY, not a field of the def, so it is excluded.
function addRoleFormFields() {
  const html = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'index.html'), 'utf-8');
  const block = /<div class="team-roles-add">([\s\S]*?)<\/div>/.exec(html);
  assert.ok(block, 'ENTER: the Add Role form block was found in index.html — a renamed container would silently reduce this test to asserting nothing');
  const ids = [...block[1].matchAll(/id="team-roles-add-([a-z]+)"/g)].map((m) => m[1]);
  assert.ok(ids.length > 1, 'ENTER: the form block yielded inputs');
  return ids.filter((id) => id !== 'name' && id !== 'btn');
}

// The popover row model's SCHEMA keys: what renderRows can display per role.
// `key` and `readOnly` are presentation, not schema.
function rowModelFields() {
  const rows = teamRoleRows({ roles: { runner: {} } });
  assert.strictEqual(rows.length, 1, 'ENTER: the row model produced the row under test');
  return Object.keys(rows[0]).filter((k) => k !== 'key' && k !== 'readOnly');
}

test('legibility: every schema field is either front-door reachable or declared unreachable', () => {
  const reachable = new Set(EDITABLE_ROLE_FIELDS);
  const declaredGap = new Set(UNREACHABLE_ROLE_FIELDS);

  // No field may be in both lists — that would let a field claim exemption while
  // also being editable, and the union check below would still pass.
  for (const f of declaredGap) {
    assert.ok(!reachable.has(f), `"${f}" cannot be both editable and declared unreachable`);
  }

  assert.deepStrictEqual(
    sorted([...reachable, ...declaredGap]),
    sorted(ROLE_KEYS),
    'setRole\'s EDITABLE plus the declared-unreachable set must be EXACTLY the schema key set. '
    + 'A new field reachable from nowhere fails here, and that is the point: it is cut, not documented.',
  );
});

test('legibility: the Add Role form offers exactly the editable fields', () => {
  assert.deepStrictEqual(
    sorted(addRoleFormFields()),
    sorted(EDITABLE_ROLE_FIELDS),
    'the Add Role form and setRole\'s EDITABLE must agree — a form input for a field setRole drops '
    + 'writes nothing and says it saved; an editable field with no input is unreachable from the UI',
  );
});

test('legibility: the popover row model shows exactly the editable fields', () => {
  assert.deepStrictEqual(
    sorted(rowModelFields()),
    sorted(EDITABLE_ROLE_FIELDS),
    'the row model must show exactly what can be set — a displayed field nothing writes is the '
    + 'shape that put two compensating display sites around `instantiate`',
  );
});

// The union check above is true of any set that happens to add up. This pins the
// membership itself, so a swap (drop `brief`, add `standing`) that keeps the
// count cannot pass, and re-adding a cut field has to come through here.
test('legibility: the schema is exactly the four surviving fields', () => {
  assert.deepStrictEqual(sorted(ROLE_KEYS), ['brief', 'prompt', 'template', 'worktree'],
    'the role schema is four fields: the seat\'s shape source, its standing instructions, '
    + 'the human label, and the isolation prior');
  for (const cut of ['instantiate', 'standing', 'tools', 'type', 'ephemeral']) {
    assert.ok(!ROLE_KEYS.has(cut),
      `"${cut}" was cut because no single resolver consumed it on every spawn path; `
      + 'reintroducing it needs the resolver first, not a normalizeRoleDef line');
  }
});
