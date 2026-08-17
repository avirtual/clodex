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
//   4. addRole's WRITABLE key set      (what a def can actually land on disk)
//
// A field added to the schema and to none of these FAILS here. A field shown in
// the UI that the schema does not model FAILS here. UNREACHABLE_ROLE_FIELDS is
// now EMPTY — the one gap it ever declared (`worktree`, waiting on per-ticket
// isolation) was closed by giving that field a front door rather than by moving
// its exemption. A future gap has to add itself back explicitly, which is the
// difference between a declaration and an oversight.
//
// This is the test that makes the cut stick. Deleting it un-deletes the schema.

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const os = require('node:os');

const {
  ROLE_KEYS, EDITABLE_ROLE_FIELDS, UNREACHABLE_ROLE_FIELDS, CUT_ROLE_FIELDS,
  HONORED_CUT_FIELDS, createTeamManifest,
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

// The keys addRole can actually LAND ON DISK, measured by writing a def that
// offers everything — the whole schema, every cut field, and an invented one —
// and reading the file back raw. This is the surface `worktree` is writable
// through (`team:addRole` takes an arbitrary def), and the one the other three
// miss: they describe what the UI offers, while this is what a caller can store.
function addRoleWritableFields() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'legib-home-'));
  fs.mkdirSync(path.join(home, 'teams'), { recursive: true });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'legib-proj-'));
  // A REAL directory: `cwd` is refused at write time unless it exists under the
  // root (Clodex never creates it), so without this the addRole below throws and
  // this helper measures nothing.
  fs.mkdirSync(path.join(root, 'api'));
  const tm = createTeamManifest({ fs, clodexHome: home });
  tm.createTeam({ name: 'shop', root, lead: 'shop-lead' });
  tm.addRole('shop', 'runner', {
    // The full surviving schema...
    template: 'fable-lead', prompt: 'p', brief: 'b', dispatch: 'worktree', cwd: 'api',
    // ...every field a version bump cut EXCEPT `worktree`, which addRole now
    // refuses loudly rather than dropping (pinned in team-manifest.test.js):
    // pickRoleKeys would drop it without emitting a `dispatch`, so a def
    // carrying it would store a standing role and report success...
    instantiate: 'session', standing: 'prompts/s.md', tools: ['Read'],
    type: 'codex', ephemeral: true,
    // ...and one nobody ever declared, so the check is not a denylist.
    invented: 'x',
  });
  const raw = JSON.parse(fs.readFileSync(path.join(home, 'teams', 'shop', 'team.json'), 'utf-8'));
  assert.ok(raw.roles && raw.roles.runner, 'ENTER: the role under test reached the file — an addRole that silently wrote nothing would leave every assertion below true of an absent object');
  return Object.keys(raw.roles.runner);
}

test('legibility: addRole stores exactly the schema, dropping anything else', () => {
  assert.deepStrictEqual(
    sorted(addRoleWritableFields()),
    sorted(ROLE_KEYS),
    'addRole must write a schema-only def. A verbatim write puts `tools: ["Read"]` in team.json — '
    + 'a restriction-shaped field, on disk, enforced by nothing — and dropping it on read-back does '
    + 'not help: the file still reads as policy to the next author and to every agent that opens it',
  );
});

test('legibility: every schema field is either front-door reachable or declared unreachable', () => {
  const reachable = new Set(EDITABLE_ROLE_FIELDS);
  const declaredGap = new Set(UNREACHABLE_ROLE_FIELDS);

  // Stated, not merely implied by the union below: EVERY field is reachable
  // today. The union check alone is satisfied by any partition of the schema, so
  // a field moved from EDITABLE into the gap set would still pass it. This is
  // the assertion a future exemption has to argue with.
  assert.deepStrictEqual(sorted(declaredGap), [],
    'no role field is exempt from a front door today — adding an entry here means '
    + 'shipping a field only a hand-edit can reach, which is what this file exists to stop');

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
test('legibility: the schema is exactly the five surviving fields', () => {
  assert.deepStrictEqual(sorted(ROLE_KEYS), ['brief', 'cwd', 'dispatch', 'prompt', 'template'],
    'the role schema is five fields: the seat\'s shape source, its standing instructions, '
    + 'the human label, what dispatching a ticket to the role does, and where in the team its seats work');
  // Membership pin FIRST, then the real constant: iterating CUT_ROLE_FIELDS
  // alone would silently stop checking a field someone removed from it, and the
  // literal alone stops checking a field someone adds. `worktree` is a cut field
  // — it was replaced by `dispatch`, and re-adding the boolean would give the
  // migration two sources to disagree over.
  assert.deepStrictEqual([...CUT_ROLE_FIELDS].sort(),
    ['ephemeral', 'instantiate', 'standing', 'tools', 'type', 'worktree'],
    'the cut list itself is pinned — a field leaving it must come through here');
  for (const cut of CUT_ROLE_FIELDS) {
    assert.ok(!ROLE_KEYS.has(cut),
      `"${cut}" was cut because no single resolver consumed it on every spawn path; `
      + 'reintroducing it needs the resolver first, not a normalizeRoleDef line');
  }

  // HONORED ⊆ CUT, or the file never stops warning. migrateRoles deletes only
  // CUT_ROLE_FIELDS members, so a key honored-but-not-cut is never removed;
  // `clean` therefore never goes true, the version never stamps, and the load
  // warns forever on a file no mutator can fix.
  for (const k of HONORED_CUT_FIELDS.keys()) {
    assert.ok(CUT_ROLE_FIELDS.includes(k),
      `"${k}" is honored-but-not-cut: migrateRoles would never delete it, so the manifest `
      + 'could never stamp clean and would warn on every load forever');
    assert.ok(!ROLE_KEYS.has(k), `"${k}" is read by a compatibility branch, not modeled by the schema`);
  }
});
