// The `this.*` seam gate for the t380 teams/tickets split.
//
// WHY THIS EXISTS AT ALL. team-tickets.js's methods are grafted onto
// SessionManager.prototype and run with `this` = the manager, so every call
// across the split — both directions — is `this.<name>(…)`. That resolves on
// the prototype chain at runtime and never appears as a free identifier, which
// means test/free-identifier-leaks.test.js CANNOT see this seam: it scans
// module-scope names. The split's whole coupling surface is invisible to every
// other gate in the repo, and the failure mode is silent — a method that misses
// the move leaves `this._x` undefined and throws a TypeError only when that
// ticket path runs, which the unit suite reaches only with a PTY.
//
// So this file is load-bearing, not belt-and-braces. It is also, deliberately,
// the inventory of the `this.*` contract between the two halves — if the split
// is ever turned into a real decoupling, this scan's output is the spec.
//
// Heuristic static scan, same genre as free-identifier-leaks.test.js: strip
// comments and string bodies (keeping template interpolations, which are code),
// collect `this.<name>(` uses and the two files' declared method sets, and
// require every use to resolve. There is no whitelist, and there should never
// need to be one: at the time of writing all 183 distinct `this.<name>(` names
// in session-manager.js resolve against its own class body, so the scan starts
// from a clean sheet and any residue is a real defect.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

// Blank out comments and string bodies. Template literals are lexed
// structurally rather than blanked: a `${this._x()}` interpolation is a real
// call and must survive, which is the same reason free-identifier-leaks.test.js
// lexes them instead of regex-blanking (a whole-literal blank there hid a live
// leak for a phase). Ticket prose is FULL of `this.`-looking text inside
// backticks, so getting this wrong fabricates uses rather than losing them.
function stripNonCode(src) {
  let out = '';
  let i = 0;
  function code(end) {
    let depth = 0;
    while (i < src.length) {
      const c = src[i], n = src[i + 1];
      if (end === '}' && c === '}' && depth === 0) return;
      if (c === '{') depth++;
      else if (c === '}') depth--;
      if (c === "'" || c === '"') { i++; while (i < src.length && src[i] !== c) i += src[i] === '\\' ? 2 : 1; i++; out += '""'; continue; }
      if (c === '`') { tpl(); continue; }
      if (c === '/' && n === '/') { while (i < src.length && src[i] !== '\n') i++; continue; }
      if (c === '/' && n === '*') { i += 2; while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i++; i += 2; continue; }
      out += c; i++;
    }
  }
  function tpl() {
    i++;
    while (i < src.length && src[i] !== '`') {
      if (src[i] === '\\') { i += 2; continue; }
      if (src[i] === '$' && src[i + 1] === '{') { i += 2; out += '('; code('}'); i++; out += ')'; continue; }
      i++;
    }
    i++; out += '``';
  }
  code(null);
  return out;
}

const usesIn = (src) =>
  new Set([...stripNonCode(src).matchAll(/this\.([A-Za-z_$][\w$]*)\s*\(/g)].map((m) => m[1]));

// The SessionManager class body's own method names: a `name(` or `name = ` head
// at exactly class-member indentation. Indentation is the discriminator that
// keeps a nested function or an object-literal method inside a body from
// counting as a class member.
function classMethods(src) {
  const lines = stripNonCode(src).split('\n');
  const at = lines.findIndex((l) => /^\s*class SessionManager\b/.test(l));
  assert.ok(at >= 0, 'class SessionManager not found — this scan is measuring nothing');
  const indent = ' '.repeat(lines[at].match(/^\s*/)[0].length + 2);
  const names = new Set();
  for (const l of lines.slice(at + 1)) {
    const m = l.match(/^(\s*)(?:static\s+)?(?:async\s+)?(?:\*\s*)?([A-Za-z_$][\w$]*)\s*[(=]/);
    if (m && m[1] === indent) names.add(m[2]);
  }
  return names;
}

// The grafted set, taken at RUNTIME rather than parsed: these are exactly the
// keys createSessionManager hands to defineProperty, so there is no gap between
// what this test measures and what the graft installs. Both destructures
// tolerate an empty object, so no deps are needed to enumerate the surface.
const { createTicketMethods } = require('../team-tickets');
const grafted = new Set(Object.keys(createTicketMethods({}, {})));

const smSrc = read('session-manager.js');
const ttSrc = read('team-tickets.js');
const coreMethods = classMethods(smSrc);

test('the scan reaches the state it is asserting about', () => {
  // Every assertion below is an ABSENCE over a filtered set, and all of those
  // are true of an empty set. A stripper that eats the file, a class head that
  // moves, or a graft that returns nothing would make this whole file pass
  // while measuring zero — so pin the inputs first.
  assert.ok(coreMethods.size > 50,
    `only ${coreMethods.size} SessionManager methods found — the class-body scan is broken`);
  for (const anchor of ['create', 'kill', '_handleIntent', '_gatedDeliver']) {
    assert.ok(coreMethods.has(anchor), `ENTER: core method ${anchor} missing from the scan`);
  }
  assert.ok(usesIn(smSrc).size > 100,
    'session-manager.js this.*() uses came back near-empty — the stripper ate the file');
});

test('every this.*() call in team-tickets.js resolves on the grafted manager', () => {
  // The bug this catches: a moved body calling a method that did NOT move and
  // does NOT exist in core either — or, after a later cleanup, calling a core
  // method that has since been deleted. Both are runtime TypeErrors on a ticket
  // path, invisible to every other gate.
  const unresolved = [...usesIn(ttSrc)]
    .filter((n) => !grafted.has(n) && !coreMethods.has(n))
    .sort();
  assert.deepStrictEqual(unresolved, [],
    `team-tickets.js calls this.<name>() that exists on neither side of the split: ${unresolved.join(', ')}`);
});

test('every this.*() call in session-manager.js resolves on the grafted manager', () => {
  // The reverse half: core keeps calling into the cluster (_handleTask from the
  // intent dispatcher, _replayTicketsOnce from create, _touchTicketActivity from
  // _emitActivity, …). A method dropped from the returned object — or renamed on
  // the way across — breaks those with nothing else watching.
  const unresolved = [...usesIn(smSrc)]
    .filter((n) => !coreMethods.has(n) && !grafted.has(n))
    .sort();
  assert.deepStrictEqual(unresolved, [],
    `session-manager.js calls this.<name>() that exists on neither side of the split: ${unresolved.join(', ')}`);
});

test('no method is defined on both sides of the split', () => {
  // The graft runs AFTER the class body, so a name present in both files wins
  // from team-tickets.js and silently shadows the class method — a half-finished
  // move (copied across, not deleted from core) reads as working and diverges
  // the moment either copy is edited. Nothing else would report it: both
  // resolve, so the two scans above stay green.
  const both = [...grafted].filter((n) => coreMethods.has(n)).sort();
  assert.deepStrictEqual(both, [],
    `defined in BOTH session-manager.js and team-tickets.js (the graft shadows the class method): ${both.join(', ')}`);
});

test('the graft installs non-enumerable properties', () => {
  // Class methods are non-enumerable; Object.assign would graft enumerable ones
  // and change what a for-in or spread over the prototype chain sees. That is a
  // behaviour change inside a move-only split, and it would never show up as a
  // failing ticket test — only as something downstream enumerating differently.
  const graftSite = stripNonCode(smSrc).match(/for \(const \[k, v\] of Object\.entries\(ticketMethods\)\)[\s\S]{0,400}/);
  assert.ok(graftSite, 'graft loop not found in session-manager.js');
  assert.ok(/Object\.defineProperty/.test(graftSite[0]),
    'graft must use Object.defineProperty, not Object.assign');
  assert.ok(/enumerable:\s*false/.test(graftSite[0]),
    'graft must install non-enumerable properties, matching class-method descriptors');
});
