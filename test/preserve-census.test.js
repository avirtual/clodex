'use strict';

// Run: node --test
//
// A CENSUS pin: every persisted seat property must have a preserve DECISION.
//
// The bug this exists to stop happening a third time. An in-place restart is
// kill() + create(): kill() removes the persistence record, create() rebuilds it
// from spawn arguments, and `_preserveAcrossRestart` re-seeds only what it is
// named. So a field that (a) some setter writes onto the record and (b) create()
// does not write back is GONE after a reload, silently, with nothing anywhere
// that says so. Twice now that has shipped:
//
//   `ephemeral`      — t482 r4 (60b8271). A reloaded ticket seat came back
//                      reading as the operator's standing seat.
//   `keepWarmAlways` — t487. The operator's perpetual keep-warm hold stopped
//                      firing; the field was on no list at all.
//
// Both were found by accident, months apart, by someone chasing a symptom.
// test/preserve-across-restart.test.js pins the CALLERS (every restart seam goes
// through the helper, and carries the identity fields). Nothing pinned the
// FIELDS — that a newly persisted property was ever considered at all. This does.
//
// The shape: three sets parsed out of source text, and one assertion that the
// first is covered by the others.
//
//   CENSUS  — every field a persistence writer puts on a seat record.
//   DECIDED — ALWAYS_PRESERVE, plus each restart call site's field list, plus
//             create()'s own rebuild upsert (a field create() writes back needs
//             no preserving — it regrows by construction).
//   LEDGER  — fields deliberately NOT preserved, each with its reason here.
//
// A field in CENSUS and in none of the others fails this file, and the failure
// names the field and says what to do about it. Adding a persisted property is
// then a two-line change: the setter, and a decision recorded in one of the
// places above.
//
// WHY THE PARSERS ARE PURE FUNCTIONS OVER SOURCE STRINGS. A guard that only ever
// runs against the real repo cannot demonstrate that it discriminates — it is
// green today and would be green if its regexes matched nothing. Every function
// below takes source TEXT, so the last section runs the identical classifier
// against a synthetic module that adds a persisted field without a decision and
// asserts it is REPORTED. That is the subject; a claim about it would be worth
// nothing. (Two rounds of t486 went on exactly this distinction.)

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

// --------------------------------------------------------------- parsing

// Comments and string bodies, blanked to spaces (offsets preserved, so a caller
// can still index into the result). Prose is the larger hazard here by far: the
// upserts in this repo carry paragraphs of rationale, and an unstripped scan
// harvested English words — `does`, from "does not" — as persisted field names.
// A census whose members include words picked out of a comment reports failures
// nobody can act on, which is how a guard gets deleted.
function stripNonCode(src) {
  let out = '';
  let i = 0;
  while (i < src.length) {
    const two = src.slice(i, i + 2);
    if (two === '//') {
      const end = src.indexOf('\n', i);
      const stop = end < 0 ? src.length : end;
      out += ' '.repeat(stop - i);
      i = stop;
    } else if (two === '/*') {
      const end = src.indexOf('*/', i + 2);
      const stop = end < 0 ? src.length : end + 2;
      out += ' '.repeat(stop - i);
      i = stop;
    } else if (src[i] === "'" || src[i] === '"' || src[i] === '`') {
      const q = src[i];
      let j = i + 1;
      while (j < src.length && src[j] !== q) j += src[j] === '\\' ? 2 : 1;
      const stop = Math.min(j + 1, src.length);
      out += ' '.repeat(stop - i);
      i = stop;
    } else {
      out += src[i];
      i += 1;
    }
  }
  return out;
}

// The `{...}` starting at `from`, matched by brace counting rather than by a
// regex: every object of interest here contains nested objects and spreads, and
// a non-greedy `\{[^}]*\}` stops at the first inner brace and silently reads a
// fraction of the fields. Returns '' when the braces do not balance, which the
// callers turn into a loud failure rather than an empty field set.
//
// Counted over stripNonCode's blanked copy, sliced out of the original. A `{` in
// a comment or a string is not an object, and these upserts sit among comment
// paragraphs — counting raw characters walks the closing brace past the end of
// the literal and swallows whatever follows it.
const codeCache = new Map();
function codeOf(src) {
  if (!codeCache.has(src)) codeCache.set(src, stripNonCode(src));
  return codeCache.get(src);
}

function balancedObject(src, from) {
  const code = codeOf(src);
  const start = code.indexOf('{', from);
  if (start < 0) return '';
  let depth = 0;
  for (let i = start; i < code.length; i++) {
    if (code[i] === '{') depth += 1;
    else if (code[i] === '}') {
      depth -= 1;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  return '';
}

// Keys of an object literal: `foo: bar`, the `foo` shorthand, and the
// `...(cond ? { foo: … } : {})` spread form all count — all three land a field
// on the record.
//
// Both patterns require the name to sit in KEY POSITION — directly after a `{`
// or a `,`. Matching a bare `name:` instead sweeps in the left arm of every
// ternary (`x ? nextIntents : undefined` reads as a key named `nextIntents`),
// and those are values, not fields. The distinction is not cosmetic: a census
// carrying phantom members fails on names that cannot be decided, and the only
// available cure is to weaken the guard.
function literalKeys(objSrc) {
  const code = stripNonCode(objSrc);
  const keys = new Set();
  for (const m of code.matchAll(/[{,]\s*([A-Za-z_$][\w$]*)\s*:/g)) keys.add(m[1]);
  for (const m of code.matchAll(/[{,]\s*([A-Za-z_$][\w$]*)\s*(?=[,}])/g)) keys.add(m[1]);
  return keys;
}

// CENSUS half 1 — the setters in stores.js's `persistence` object. Scoped to
// that object literal: stores.js holds a dozen other stores (workspaces,
// reminders, notifications…) writing `entry.x =` on records that are not seats,
// and a file-wide scan would drag every one of them into the census.
function storeWrittenFields(storesSrc) {
  const at = storesSrc.indexOf('const persistence = {');
  assert.ok(at >= 0, 'cannot find the `persistence` store in stores.js — this census must not pass by failing to look');
  const body = balancedObject(storesSrc, at);
  assert.ok(body, 'the `persistence` store literal does not brace-balance — parse failure, not a pass');
  const code = stripNonCode(body);
  const fields = new Set();
  // `entry.x = …` (not `==`/`===`) and `delete entry.x`. Both directions of the
  // same decision: a setter that only ever DELETES a field still means the field
  // exists on records, and a restart still has to decide about it.
  for (const m of code.matchAll(/\b(?:entry|e)\.([A-Za-z_$][\w$]*)\s*=(?!=)/g)) fields.add(m[1]);
  for (const m of code.matchAll(/\bdelete\s+(?:entry|e)\.([A-Za-z_$][\w$]*)/g)) fields.add(m[1]);
  return fields;
}

// CENSUS half 2 — records written by an upsert literal somewhere OTHER than
// create()'s rebuild. This half is not optional: `ephemeral`, the field that
// established this bug class, has no setter in stores.js at all. It is stamped
// straight onto the record by team-tickets.js's spawn stubs, so a census built
// from stores.js alone would have been green over the original defect.
function upsertWrittenFields(src, { skipCreateRebuild = false } = {}) {
  const fields = new Set();
  for (const m of src.matchAll(/(?:getPersistence\(\)|persistence)\.upsert\(\{/g)) {
    const obj = balancedObject(src, m.index);
    assert.ok(obj, 'an upsert literal does not brace-balance — parse failure, not a pass');
    // create()'s rebuild is the one upsert that is a REGROWTH, not a write of
    // new state; it is read separately, by createRebuildFields.
    if (skipCreateRebuild && obj.includes('sessionId: resumeId || null')) continue;
    for (const k of literalKeys(obj)) fields.add(k);
  }
  return fields;
}

// DECIDED half 1 — create()'s rebuild upsert. A field here is written back on
// every spawn from the spawn arguments, so a restart cannot lose it.
// Located by scanning the upsert literals for the marker, NOT by seeking the
// marker and walking back to the nearest `.upsert({`: `sessionId: resumeId ||
// null` also appears in create()'s spawn-argument objects, which come EARLIER in
// the file than any upsert, so the walk-back finds nothing and the census reads
// create() as writing no fields at all — every one of them then reports as
// undecided. Exactly one upsert may match, or the anchor is ambiguous.
function createRebuildFields(sessionManagerSrc) {
  const matches = [];
  for (const m of sessionManagerSrc.matchAll(/(?:getPersistence\(\)|persistence)\.upsert\(\{/g)) {
    const obj = balancedObject(sessionManagerSrc, m.index);
    if (obj.includes('sessionId: resumeId || null')) matches.push(obj);
  }
  assert.strictEqual(matches.length, 1,
    `expected exactly one create() rebuild upsert, found ${matches.length} — without it every create-written `
    + 'field reads as undecided and this census reports the whole record');
  return literalKeys(matches[0]);
}

// DECIDED half 2 — ALWAYS_PRESERVE, carried whether or not a caller names it.
function alwaysPreserveFields(sessionManagerSrc) {
  const m = /const ALWAYS_PRESERVE = \[([^\]]*)\]/.exec(sessionManagerSrc);
  assert.ok(m, 'cannot find ALWAYS_PRESERVE — the census cannot report what it cannot read');
  return new Set(m[1].split(',').map((f) => f.trim().replace(/^['"`]|['"`]$/g, '')).filter(Boolean));
}

// DECIDED half 3 — the union of what the restart call sites ask for. A field
// named by only SOME call sites is still decided as far as this census goes;
// preserve-across-restart.test.js is what pins that every site names the ones
// that must be universal, and the two guards deliberately do not overlap.
function callSiteFields(sources) {
  const fields = new Set();
  let sites = 0;
  for (const src of sources) {
    for (const m of src.matchAll(/(?:manager|this)\._preserveAcrossRestart\s*\([^,]+,\s*[^,]+,\s*([^)]*)\)/g)) {
      sites += 1;
      const arg = m[1].trim();
      let list = /^\[([^\]]*)\]/.exec(arg);
      if (!list) {
        // `(name, entry, someVar)` — resolve to `const someVar = [...]`, plus any
        // later `someVar.push('x')`, which is how the fresh-restart branch works.
        const varName = /^([A-Za-z_$][\w$]*)$/.exec(arg);
        if (varName) {
          list = new RegExp(`${varName[1]}\\s*=\\s*\\[([^\\]]*)\\]`).exec(src);
          for (const p of src.matchAll(new RegExp(`${varName[1]}\\.push\\(([^)]*)\\)`, 'g'))) {
            fields.add(p[1].trim().replace(/^['"`]|['"`]$/g, ''));
          }
        }
      }
      assert.ok(list, `cannot read the field list at a _preserveAcrossRestart call site (${arg}) — this census must not pass by failing to look`);
      for (const f of list[1].split(',')) {
        const clean = f.trim().replace(/^['"`]|['"`]$/g, '');
        if (clean) fields.add(clean);
      }
    }
  }
  return { fields, sites };
}

// --------------------------------------------------------------- the ledger

// Fields that are persisted, are NOT regrown by create(), and are deliberately
// left out of every preserve list. Each needs a reason, because the default for
// anything in the census is "preserve it" — that is what both shipped bugs got
// wrong by omission.
const NOT_PRESERVED = {
  label: 'all three restart call sites re-assert it AFTER create() (`if (entry.label) setLabel`). '
    + 'Moving it into a preserve list would make two writers for one field — see ALWAYS_PRESERVE\'s header.',
  stripLevel: 'same as label: re-asserted post-create by every call site via stripLevelOf(entry) + setStripLevel.',
  stripThinking: 'not a live field — setStripLevel DELETES it, migrating records off the old boolean. '
    + 'Preserving it would resurrect exactly what that migration removes.',
  rosterSentAt: 'deliberately caller-controlled: a FRESH restart is a new conversation with no roster in it, '
    + 'so engine.restartSession pushes it only when !opts.fresh. In ALWAYS_PRESERVE a fresh restart would '
    + 'suppress the roster inject it exists to trigger.',
  archivedAt: 'an archived seat has no live process, and every restart seam is gated on '
    + '`manager.sessions.has(name)`, so no restart path runs against an archived record.',
};

// Fields that are persisted, are NOT regrown by create(), and are on no list —
// i.e. the SAME hole `ephemeral` and `keepWarmAlways` were in. Found by this
// census when it was first written (t487) and left open deliberately: deciding
// them is a behaviour change outside that ticket, and a guard that silently
// swallowed them would be the guard failing at its one job.
//
// Asserted by EXACT equality, not membership. A growable escape hatch is a place
// to put the next omission instead of deciding it; exact equality means adding a
// name here is a visible diff line someone has to justify, and FIXING one fails
// this file until the name is removed — which is the reminder that the entry was
// a defect and not a decision.
const KNOWN_UNDECIDED = {
  worktree: 'setWorktree writes the seat\'s worktree provenance; create() does not write it back. '
    + 'A reloaded ticket seat loses it — the same consequence class as `ephemeral` (accept can no longer '
    + 'find the tree to remove, so it leaks).',
  autoCompact: 'a template-set `autoCompact: false` reverts to on after a reload, silently.',
  digested: 'markDigested\'s per-conversation history restarts, so a reloaded seat re-digests.',
};

// --------------------------------------------------------------- classifier

// The whole guard as one pure function over source text, so the discrimination
// subject at the bottom can run it against a module that does not exist on disk.
function undecidedFields({ storesSrc, sessionManagerSrc, otherSrcs = [] }) {
  const census = new Set([
    ...storeWrittenFields(storesSrc),
    ...upsertWrittenFields(sessionManagerSrc, { skipCreateRebuild: true }),
    ...otherSrcs.flatMap((s) => [...upsertWrittenFields(s)]),
  ]);
  const { fields: callSite, sites } = callSiteFields([sessionManagerSrc, ...otherSrcs]);
  const decided = new Set([
    ...createRebuildFields(sessionManagerSrc),
    ...alwaysPreserveFields(sessionManagerSrc),
    ...callSite,
    ...Object.keys(NOT_PRESERVED),
  ]);
  // `name` is the record's key, not a property of it.
  decided.add('name');
  return { census, decided, sites, undecided: [...census].filter((f) => !decided.has(f)).sort() };
}

function realSources() {
  return {
    storesSrc: read('stores.js'),
    sessionManagerSrc: read('session-manager.js'),
    otherSrcs: [read('engine.js'), read('team-tickets.js')],
  };
}

// --------------------------------------------------------------- the guard

test('ENTER: the census actually sees the fields both shipped bugs were about', () => {
  // Everything below is "this set is covered by that set", and the empty set is
  // covered by anything. If the parsers stop matching, every assertion in this
  // file goes vacuous at once and the suite stays green over an unguarded
  // repo — so the two fields whose LOSS is the reason this file exists are
  // asserted present by name, as literals, before anything is concluded.
  const { census, sites } = undecidedFields(realSources());
  assert.ok(census.has('keepWarmAlways'),
    'the census cannot see `keepWarmAlways` — the stores.js setter scan has stopped matching, do not weaken this');
  assert.ok(census.has('ephemeral'),
    'the census cannot see `ephemeral` — the upsert-literal scan has stopped matching. It has no stores.js '
    + 'setter at all, so without that half this census would have been green over the ORIGINAL bug');
  assert.ok(census.size >= 20,
    `the census found only ${census.size} fields — a persistence record has far more, so the parsers are broken`);
  assert.ok(sites >= 3,
    `found only ${sites} _preserveAcrossRestart call sites — the scanner has stopped seeing them`);
});

test('every persisted seat field has a preserve decision', () => {
  const { undecided } = undecidedFields(realSources());
  const open = undecided.filter((f) => !(f in KNOWN_UNDECIDED));
  assert.deepStrictEqual(open, [],
    `these persisted seat fields have no preserve decision: ${open.join(', ')}.\n`
    + 'A field written onto a session record but never written back by create() is DROPPED by every '
    + 'in-place restart (kill() removes the record, create() rebuilds it from spawn args). That is how '
    + '`ephemeral` (t482) and `keepWarmAlways` (t487) were lost, both silently, both found by accident '
    + 'months later.\nResolve each by doing ONE of:\n'
    + '  - add it to ALWAYS_PRESERVE (session-manager.js) if no caller can regrow it and none re-asserts it;\n'
    + '  - add it to the field list at each _preserveAcrossRestart call site, if a caller must control it;\n'
    + '  - add it to NOT_PRESERVED in this file WITH the reason it is safe to drop.\n'
    + 'Do not add it to KNOWN_UNDECIDED — that list is the two-item backlog this census found, not a hatch.');
});

test('the KNOWN_UNDECIDED backlog is exactly the set this census found open', () => {
  // Exact equality in both directions. Growth means a new omission was parked
  // instead of decided; shrinkage means one was fixed and the entry is now a
  // stale claim that a live field is broken.
  //
  // It is also this file's parser canary, which is the reason not to relax it to
  // a subset check. Measured: blanking one line of storeWrittenFields' scan
  // leaves the ENTER test green (the delete-branch still matches) and the main
  // guard green (a census that shrank has nothing left to report), and THIS
  // assertion is the only one that fails.
  const { undecided } = undecidedFields(realSources());
  assert.deepStrictEqual(undecided, Object.keys(KNOWN_UNDECIDED).sort(),
    'KNOWN_UNDECIDED no longer matches what the census finds open. If you FIXED one, delete its entry here. '
    + 'If a NEW field appeared, it does not belong here — give it a real preserve decision.');
});

test('the two fields this ticket restored are carried without a caller naming them', () => {
  const always = alwaysPreserveFields(read('session-manager.js'));
  // As literals, and both: they are mutually exclusive states of ONE control
  // (ipc-handlers.js wire:hold writes each by clearing the other), so a restart
  // that carried one alone would hand the seat back holding both — and
  // rearmPlan checks `always` FIRST, so a stale keepWarmAlways outranks the
  // deadline the operator actually set.
  assert.ok(always.has('keepWarmAlways'),
    'keepWarmAlways must be carried whether or not a caller names it — it is written only by an explicit '
    + 'operator action, create() never writes it back, and the seat it protects is by definition one nobody '
    + 'is sitting at, so no turn ever arrives to notice the flag is gone');
  assert.ok(always.has('holdUntil'),
    'holdUntil must move with keepWarmAlways — preserving one alone resurrects a seat holding both');
});

// --------------------------------------------------- BEHAVIOUR, not just text

test('BEHAVIOUR: a perpetual hold survives the real preserve path', () => {
  // The parsers above read source; this drives the helper. Deliberately NOT a
  // hand-written field on a record afterwards: a fixture that stamps
  // keepWarmAlways itself passes with preservation deleted entirely.
  const { createSessionManager } = require('../session-manager');
  const store = [];
  const persistence = {
    list: () => store,
    get: (n) => store.find((e) => e.name === n) || null,
    upsert: (e) => {
      const i = store.findIndex((x) => x.name === e.name);
      if (i >= 0) store[i] = { ...store[i], ...e }; else store.push({ ...e });
    },
  };
  const SessionManager = createSessionManager({
    getRemoteServer: () => null,
    getUiSettings: () => ({ get: () => ({}) }),
    getPersistence: () => persistence,
    notifyOS: () => {},
    fs: require('node:fs'),
  });
  const m = new SessionManager();

  // Verbatim the reload site's field list — the call that was dropping the flag.
  m._preserveAcrossRestart('cx', { name: 'cx', keepWarmAlways: true, createdAt: 1 },
    ['ephemeral', 'reviewFor', 'reviewTicket', 'createdAt']);
  // create()'s rebuild spread-merges OVER the stub; that merge order is why
  // re-seeding before create() works at all.
  persistence.upsert({ name: 'cx', type: 'claude', cwd: '/proj', sessionId: 'c' });
  assert.strictEqual(persistence.get('cx').keepWarmAlways, true,
    'the perpetual flag must survive the rebuild — this is the whole defect');

  // The timed half, on its own record: a seat holds one or the other, never both.
  m._preserveAcrossRestart('tx', { name: 'tx', holdUntil: 1_700_000_000_000 }, []);
  persistence.upsert({ name: 'tx', type: 'claude', cwd: '/proj', sessionId: 'd' });
  assert.strictEqual(persistence.get('tx').holdUntil, 1_700_000_000_000,
    'a timed hold\'s deadline survives too — rearmPlan is what decides it has lapsed, and it cannot decide '
    + 'about a field that is gone');

  // And a seat that never held one is not handed a record it did not have.
  m._preserveAcrossRestart('fresh', { name: 'fresh' }, ['rosterSentAt']);
  assert.strictEqual(persistence.get('fresh'), null,
    'a seat with no hold seeds nothing — a manufactured record would hand create() an existingEntry and '
    + 'suppress the roster inject');
});

// --------------------------------------------------- DISCRIMINATION

// The subject. Everything above is green against the real repo; that is
// consistent with a guard that discriminates and equally consistent with one
// whose regexes match nothing useful. These run the SAME classifier against
// source that does not exist on disk, where the answer is known.

test('DISCRIMINATION: a new persisted field with no decision is REPORTED', () => {
  const real = realSources();
  // The realistic shape of the bug: someone adds a setter to the persistence
  // store and nothing else. It is not in create()'s rebuild, not in
  // ALWAYS_PRESERVE, not named by any call site.
  const storesSrc = real.storesSrc.replace(
    '    setKeepWarmAlways(name, on) {',
    '    setFrobnicator(name, on) {\n'
    + '      const all = this._load();\n'
    + '      const entry = all.find(s => s.name === name);\n'
    + '      if (!entry) return;\n'
    + '      if (on) entry.frobnicator = true;\n'
    + '      else delete entry.frobnicator;\n'
    + '      this._save(all);\n'
    + '    },\n'
    + '    setKeepWarmAlways(name, on) {');
  assert.notStrictEqual(storesSrc, real.storesSrc, 'ENTER: the synthetic setter was actually injected');

  const { undecided } = undecidedFields({ ...real, storesSrc });
  assert.ok(undecided.includes('frobnicator'),
    'a persisted field added with no preserve decision was NOT reported — this census does not discriminate, '
    + 'and every green above means nothing');
  // And it is the guard's own assertion that fires, not merely the helper.
  const open = undecided.filter((f) => !(f in KNOWN_UNDECIDED));
  assert.deepStrictEqual(open, ['frobnicator'],
    'the reported set must be exactly the new field — a census that reports everything discriminates no better '
    + 'than one that reports nothing');
});

test('DISCRIMINATION: a field added the OTHER way — an upsert stub, no setter — is REPORTED', () => {
  // `ephemeral`'s shape: stamped straight onto the record by a spawn stub, with
  // no stores.js setter anywhere. A census reading only stores.js is green here.
  const real = realSources();
  const ticketsSrc = real.otherSrcs[1].replace(
    'name: seat.name, ephemeral: true,',
    'name: seat.name, ephemeral: true, seatFlavour: \'spicy\',');
  assert.notStrictEqual(ticketsSrc, real.otherSrcs[1], 'ENTER: the synthetic stub field was actually injected');

  const { undecided } = undecidedFields({ ...real, otherSrcs: [real.otherSrcs[0], ticketsSrc] });
  assert.ok(undecided.includes('seatFlavour'),
    'a field stamped by a spawn stub with no setter was NOT reported — that is exactly how `ephemeral` was lost');
});

test('DISCRIMINATION: deleting the fix re-reports keepWarmAlways', () => {
  // The strongest available statement that this file guards the product change:
  // revert part 1 in the source text and the census must name the field again.
  const real = realSources();
  const sessionManagerSrc = real.sessionManagerSrc.replace(
    "const ALWAYS_PRESERVE = ['sessionIds', 'pluginGrants', 'wireLabel', 'keepWarmAlways', 'holdUntil'];",
    "const ALWAYS_PRESERVE = ['sessionIds', 'pluginGrants', 'wireLabel'];");
  assert.notStrictEqual(sessionManagerSrc, real.sessionManagerSrc,
    'ENTER: the fix was actually reverted in the copy — an unchanged string would make this test assert nothing');

  const { undecided } = undecidedFields({ ...real, sessionManagerSrc });
  assert.ok(undecided.includes('keepWarmAlways') && undecided.includes('holdUntil'),
    'with the fix reverted the census still reports both fields decided — it is not reading ALWAYS_PRESERVE');
});

test('DISCRIMINATION: a decision recorded in the LEDGER silences the report', () => {
  // The counterpart to the tests above: the census must be satisfiable. A guard
  // that fires no matter what you do is one people delete rather than obey.
  const real = realSources();
  const storesSrc = real.storesSrc.replace(
    '      if (on) entry.keepWarmAlways = true;',
    '      if (on) entry.keepWarmAlways = true;\n      entry.gadget = 1;');
  assert.notStrictEqual(storesSrc, real.storesSrc, 'ENTER: the synthetic field was actually injected');
  const before = undecidedFields({ ...real, storesSrc }).undecided;
  assert.ok(before.includes('gadget'), 'ENTER: it is reported before the decision is recorded');

  // Recording it at a call site is one of the three cures the failure message
  // names; check that cure actually works rather than trusting the message.
  const sessionManagerSrc = real.sessionManagerSrc.replace(
    "['ephemeral', 'reviewFor', 'reviewTicket', 'createdAt']",
    "['ephemeral', 'reviewFor', 'reviewTicket', 'createdAt', 'gadget']");
  assert.notStrictEqual(sessionManagerSrc, real.sessionManagerSrc, 'ENTER: the call-site list was actually widened');
  const after = undecidedFields({ ...real, storesSrc, sessionManagerSrc }).undecided;
  assert.ok(!after.includes('gadget'),
    'naming the field at a restart call site did not satisfy the census — the cure the failure message '
    + 'prescribes must be one that works');
});
