// Census guard for the `mint` axis (t63/t71). `SessionManager.create()`'s 20th
// positional parameter distinguishes the mint front door from every restore path,
// and it DEFAULTS FALSE — deliberately, because false is the safe direction (a
// spurious freeze is repairable by the delta channel; a spurious regenerate is the
// 111k-139k token bust the prompt cache exists to prevent). The cost of that safe
// default is that a NEW call site which forgets the parameter is silently wrong:
// it compiles, it runs, it just quietly freezes a prompt it should have
// regenerated. remote-wiring.js's peer `createSession` was exactly that — it
// shipped mint-less for a release and nothing anywhere noticed.
//
// So this test is a CENSUS, not an inference. It enumerates every `.create(` call
// in the tree and asserts the set against a hand-maintained table below.
//
// ── WHAT THIS TEST MUST NEVER DO ─────────────────────────────────────────────
// It must never DECIDE whether a site is a mint. There is no predicate here that
// says "a front door looks like X" — such a predicate would be a copy of the one
// in the product, and a test containing the same boolean the product contains is
// asserting against itself (t63 shipped 15 green tests that did precisely that,
// and a revert proved they pinned nothing). The table is filled in BY A HUMAN who
// read the call site. The whole value of this test is the forced pause when the
// census stops matching — it makes someone open the new site and think. If you
// are ever tempted to "improve" this by deriving `mint` from the surrounding
// code, you are deleting the only thing it does.
//
// ── WHY THE TABLE CARRIES A LABEL, AND WHY THE LABEL IS CHECKED BY A HUMAN ────
// The t63 survey of these same call sites was wrong in three ways: it missed
// remote-wiring.js (the actual defect), it missed session-restore.js (correct by
// default, so invisible), and — the finding — it MISLABELLED engine.js's
// restartSession as "restore-on-launch". That third error is what hid the second:
// the table named the path it omitted, so every reader (including its author)
// ticked off "restore-on-launch — covered" and moved on. State that generally,
// because it is the real hazard in any audit table: the failure mode is not
// "forgot a row", it is "named one row after a different thing". A census can
// only catch the first. Labels below must be read against the code, not trusted.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

// Walk the argument list of a call whose '(' sits at src[open], returning the
// top-level argument texts. Comment- and string-aware so a comma inside a comment
// or a quoted string can't split an argument — both occur in these call sites
// (remote-wiring.js interleaves multi-line prose comments between arguments).
//
// LOCALIZED on purpose: the first version of this scan stripped comments and
// strings across the WHOLE FILE first, and a regex literal containing an
// apostrophe opened a phantom string that swallowed ipc-handlers.js's deploy-fix
// site entirely — the scan then reported 10 sites and looked perfectly healthy.
// Starting at the call and walking forward can't drift that way.
function callArgs(src, open) {
  const args = [];
  let depth = 0;
  let cur = '';
  let i = open;
  while (i < src.length) {
    const c = src[i];
    const d = src[i + 1];
    if (c === '/' && d === '/') { while (i < src.length && src[i] !== '\n') i++; continue; }
    if (c === '/' && d === '*') { i += 2; while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i++; i += 2; continue; }
    if (c === '"' || c === "'" || c === '`') {
      const q = c;
      cur += c; i++;
      while (i < src.length && src[i] !== q) {
        if (src[i] === '\\') { cur += src[i]; i++; }
        cur += src[i]; i++;
      }
      cur += q; i++; continue;
    }
    if ('([{'.includes(c)) { depth++; if (depth === 1) { i++; continue; } }
    if (')]}'.includes(c)) {
      depth--;
      if (depth === 0) { if (cur.trim()) args.push(cur.trim()); return args; }
    }
    if (c === ',' && depth === 1) { args.push(cur.trim()); cur = ''; i++; continue; }
    cur += c; i++;
  }
  return args;
}

// Every [start, end) range in `src` that is a comment (t78). Used ONLY to reject
// matches that sit inside prose — a `<word>.create(` written in a comment is not
// a call site, and before this the census counted one (cli-hooks.js's paragraph
// about this very test). That comment was reworded to dodge the regex rather than
// the scanner being fixed, which left the census's correctness resting on a
// comment in an unrelated file continuing to avoid a phrase: cli-hooks.js:54 still
// carries `<word>.create(` and is only missed because `>` is not a `\w` character.
// One word changed there and the count is silently wrong again.
//
// THIS IS DELIBERATELY NOT THE WHOLE-FILE STRIP THAT FAILED BEFORE. The header on
// callArgs above records what happened when a previous version stripped comments
// and strings across the whole file: a regex literal containing an apostrophe was
// read as an opening quote, the phantom string swallowed ipc-handlers.js's
// deploy-fix call site, and the census reported 10 and looked perfectly healthy.
// So the difference that matters here is REGEX-LITERAL AWARENESS, not the scan
// being localized:
//   * a `/` is only a regex start when the previous significant character says an
//     operand is expected (the standard heuristic — after `(,=:[!&|?{};` or an
//     operator, never after an identifier or `)`), which keeps division from
//     opening a phantom regex;
//   * quotes INSIDE a regex literal are consumed by the regex scan and never open
//     a string, which is exactly the failure above;
//   * character classes are tracked, so a `/` inside `[...]` does not end it.
// Nothing is deleted from the source and no offsets are rewritten: this returns
// ranges and the scan below skips matches inside them. A drifting range can only
// ever hide a site, never invent one — and the count assertion in the test is what
// catches that, which is why the phantom-string shape must fail there BY MESSAGE.
function commentRanges(src) {
  const ranges = [];
  // The previous significant (non-whitespace, non-comment) character. Regex-vs-
  // division turns entirely on this.
  let prev = '';
  const OPERAND_EXPECTED = /[(,=:[!&|?{};+\-*%~^<>]/;
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    const d = src[i + 1];
    if (c === '/' && d === '/') {
      const s = i;
      while (i < src.length && src[i] !== '\n') i++;
      ranges.push([s, i]);
      continue;
    }
    if (c === '/' && d === '*') {
      const s = i;
      i += 2;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i++;
      i = Math.min(i + 2, src.length);
      ranges.push([s, i]);
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      const q = c;
      i++;
      while (i < src.length && src[i] !== q) { if (src[i] === '\\') i++; i++; }
      i++;
      prev = q;
      continue;
    }
    if (c === '/' && (prev === '' || OPERAND_EXPECTED.test(prev))) {
      i++;
      let inClass = false;
      while (i < src.length) {
        const ch = src[i];
        if (ch === '\\') { i += 2; continue; }
        if (ch === '\n') break;          // unterminated → it was not a regex
        if (ch === '[') inClass = true;
        else if (ch === ']') inClass = false;
        else if (ch === '/' && !inClass) break;
        i++;
      }
      i++;
      prev = '/';
      continue;
    }
    if (!/\s/.test(c)) prev = c;
    i++;
  }
  return ranges;
}

// Collect every `<recv>.create(` in the root modules, in file then source order.
// `Object.create` is excluded by name (it is not this method). Root *.js only:
// renderer/ has no session manager, and web-dist/ is a build artifact full of
// bundled `Object.create`.
function census() {
  const out = [];
  for (const file of fs.readdirSync(ROOT).filter(f => f.endsWith('.js')).sort()) {
    const src = fs.readFileSync(path.join(ROOT, file), 'utf8');
    const re = /(\w+)\.create\s*\(/g;
    const comments = commentRanges(src);
    const inComment = (idx) => comments.some(([s, e]) => idx >= s && idx < e);
    let m;
    while ((m = re.exec(src))) {
      if (m[1] === 'Object') continue;
      // Prose is not a call site. See commentRanges above for why this is a
      // range check rather than a strip.
      if (inComment(m.index)) continue;
      const args = callArgs(src, m.index + m[0].length - 1);
      out.push({
        file,
        line: src.slice(0, m.index).split('\n').length,
        recv: m[1],
        arity: args.length,
        // The 20th positional IS the mint flag. Absent (arity < 20) means the
        // parameter default applies, which is false — that is the OUTPUT of the
        // call site being observed, not a judgement about it.
        mint: args.length >= 20 ? args[19].trim() : '(absent → default false)',
        // The 21st positional is t189's `noWire`. Observed the same way and for
        // the same reason: it too defaults false, so a site that drops it goes on
        // working while the seat silently comes back WIRED — which for a wire-off
        // seat means ANTHROPIC_BASE_URL reappears and the phone can no longer
        // attach. Two of the sites that must carry it (the GUI front door and
        // restartSession) had no test of their own.
        noWire: args.length >= 21 ? args[20].trim() : '(absent → default false)',
      });
    }
  }
  return out;
}

// ── THE HAND-MAINTAINED TABLE ────────────────────────────────────────────────
// One row per `.create(` call in the tree, in file-then-line order. `mint` is the
// literal expected in the 20th position; `false` here means the argument is
// deliberately ABSENT and the parameter default supplies it — which is how every
// restore path is written, so the table records that as the intended shape rather
// than demanding a redundant explicit `false`.
//
// ADDING A CALL SITE? This test will fail with a count mismatch. That failure is
// the entire point: go read your call site, decide whether it is a mint (a NEW
// session under a name that was free) or a restore (the same conversation coming
// back under a name that is already its own), and add the row. Do not silence it
// by regenerating the table from the code.
//
// A `mint: false` row is ALSO a row of `RESUME_SITES` in
// test/resume-cwd-not-worktree.test.js — add it there in the same commit. Only
// this file fails on a count, so nothing else will tell you: that table's own
// per-site proof mutates the sites it lists and is structurally blind to a site
// it does not, which is how it shipped covering four of five.
//
// ── THE `noWire` COLUMN (t189) ───────────────────────────────────────────────
// Same shape, same rule, different axis. `noWire` is the 21st positional and it
// ALSO defaults false, so the failure mode is identical to mint's: a site that
// drops it keeps working, and a wire-off seat silently comes back WIRED —
// ANTHROPIC_BASE_URL reappears and the phone can no longer attach to it. The
// expected value is the literal ARGUMENT TEXT, because "reads the flag off the
// persisted record" is the property, and `entry.noWire === true` states it in a
// way a wrong-source substitution (a neighbouring entry, a live session) cannot
// satisfy by accident. `false` means the argument is deliberately absent:
// legitimate for a site that never spawns a wire-off seat.
const EXPECTED = [
  { file: 'engine.js', mint: false, noWire: 'entry.noWire === true', label: 'restartSession — in-place restart, same conversation' },
  { file: 'engine.js', mint: false, noWire: 'beforeKill.noWire === true', label: 'applySessionArgs — args-edit restart, same conversation. Reads beforeKill, not the patch: the Edit dialog does not surface wire-off, so an unrelated save must replay the persisted value rather than clear it.' },
  { file: 'ipc-handlers.js', mint: true, noWire: 'p.noWire === true', label: 'spawnFromParams — THE mint front door (session:create / team:create / team:join). The only site that takes the flag from the CALLER (the GUI checkbox) rather than a record.' },
  { file: 'ipc-handlers.js', mint: true, noWire: false, label: 'peer:deployFix — brand-new session under a freshly deconflicted name. Never wire-off: it is a support session Clodex authors itself, with no operator checkbox behind it.' },
  { file: 'ipc-handlers.js', mint: null, noWire: null, label: 'sandbox:createBox — mgr.create(id, label), the BOX REGISTRY. A different object entirely; it has no mint axis and never spawns a PTY. Listed so the census stays exhaustive and nobody "fixes" it by adding a flag.' },
  { file: 'ipc-handlers.js', mint: false, noWire: 'entry.noWire === true', label: 'session:retrySpawn — retry of a failed restore' },
  { file: 'remote-wiring.js', mint: true, noWire: false, label: 'peer createSession — the REMOTE front door. Refuses live-or-persisted names, so every session born here is new; carries a resumeId only on a remote adopt, which is still a mint. This is the site that shipped mint-less (t71 defect 2). DELIBERATELY not threaded for noWire: setting it changes which base URL a box process gets, and this door already strips exec grants and privileged intents for the same reason — a remote viewer is not the box\'s local operator.' },
  { file: 'session-manager.js', mint: false, noWire: 'entry.noWire === true', label: '[agent:context reload] — cold respawn of the SAME seat' },
  { file: 'session-restore.js', mint: false, noWire: 'entry.noWire === true', label: 'restoreSessionsForWorkspace — restore-on-launch, the real one' },
  // The three spawning seats moved to team-tickets.js in the t380 split, which
  // sorts AFTER session-restore.js — the census walks the root modules in
  // filename order, so their rows move with them. The reload row above stayed
  // behind; it is the only one of the four that is not ticket machinery.
  { file: 'team-tickets.js', mint: true, noWire: '(tpl && tpl.noWire) === true', label: '[agent:spawn] intent — agent-initiated new seat. DOES carry the flag, unlike the privileged-intent strip beside it: wire-off REMOVES a capability rather than granting one, and it cannot redirect traffic (proxyBase is nulled outright, never pointed where the template chose).' },
  { file: 'team-tickets.js', mint: true, noWire: false, label: 'team-review reviewer seat — ephemeral, monotonic name, always brand new. Never wire-off: it is a short-lived seat Clodex spawns, and the wire is what its verdict rides.' },
  { file: 'team-tickets.js', mint: true, noWire: false, label: 'branch-per-ticket seat — [agent:task add] to a role with `worktree: true` mints a one-shot seat in its own git worktree. Always new: the name carries the ticket number, and a taken name never reaches create() — it is either the ticket\'s own live seat (spec re-sent), its archived record (held, with the recovery named), or a tree still held by a live seat (refused). Never wire-off: it is a working seat Clodex spawns on the lead\'s behalf, with no operator checkbox behind it, and the same reasoning as the reviewer row.' },
];

test('mint census: every SessionManager.create() call site is accounted for', () => {
  const found = census();
  // Assert the COUNT first and on its own: a count mismatch has an obvious cause
  // (a site was added or removed) and a per-row diff after a shift is noise that
  // buries it.
  assert.strictEqual(found.length, EXPECTED.length,
    `the number of .create() call sites changed (found ${found.length}, table has ${EXPECTED.length}).\n`
    + 'This test cannot tell you whether your new site is a mint — go read it and add its row.\n'
    + `FOUND:\n${found.map(s => `  ${s.file}:${s.line} recv=${s.recv} arity=${s.arity} mint=${s.mint}`).join('\n')}`);

  found.forEach((site, i) => {
    const want = EXPECTED[i];
    assert.strictEqual(site.file, want.file,
      `census drifted out of order at #${i}: found ${site.file}:${site.line}, table expects ${want.file} (${want.label})`);
  });
});

test('mint census: each call site passes the mint value its row claims', () => {
  const found = census();
  assert.strictEqual(found.length, EXPECTED.length, 'count checked by the census test above');

  found.forEach((site, i) => {
    const want = EXPECTED[i];
    if (want.mint === null) return; // the box registry — no mint axis, see its label
    const where = `${site.file}:${site.line} (${want.label})`;
    if (want.mint === true) {
      // >= 20, not === 20: create() has grown positionals PAST mint (noWire is
      // the 22nd), so a site that passes the flag explicitly and then one more
      // argument is still correct. What must hold is that position 20 is
      // REACHED — an arity below it means the default supplied the value.
      assert.ok(site.arity >= 20,
        `${where}\nis a MINT, so it must pass the 20th positional explicitly — omitting it takes the `
        + `default (false), which freezes a new session onto whatever baseline a dead same-named `
        + `session left behind. Found arity ${site.arity}.`);
      assert.strictEqual(site.mint, 'true',
        `${where}\nis a MINT and must pass literal \`true\`. Found: ${site.mint}`);
    } else {
      assert.ok(site.arity < 20 || site.mint === 'false',
        `${where}\nis a RESTORE path and must not claim to be a mint: a restore that regenerates `
        + `its prompt pays the full rewrite under a --resume'd conversation, which is the exact `
        + `token bust the cache exists to stop. Found mint=${site.mint}.`);
    }
  });
});

// t189. A COLUMN rather than a spot check on the two sites that lacked one: the
// argument can be dropped at any of the eleven, and a per-site test only ever
// covers the site whose omission someone already thought of. Two of the sites
// that must carry it — the GUI front door (ipc-handlers.js) and restartSession
// (engine.js) — had no test that would go red, which is what this closes.
//
// The expected value is the ARGUMENT TEXT, not just "is present". Presence alone
// is satisfied by an argument reading the wrong thing — a neighbouring entry, a
// live session object, `true` hardcoded — and each of those is a real bug with an
// identical arity. Pinning the expression pins the SOURCE.
test('t189 census: each call site passes the noWire value its row claims', () => {
  const found = census();
  assert.strictEqual(found.length, EXPECTED.length, 'count checked by the census test above');

  // ENTER: at least one site must actually thread the flag. Every assertion below
  // is either an equality against a table cell or an absence check, and if the
  // parameter were removed from create() wholesale the table's `false` rows would
  // all still pass — an all-absent census must not read as a healthy one.
  const threading = found.filter((s) => s.arity >= 21);
  assert.ok(threading.length >= 6,
    `ENTER: the noWire argument must actually be threaded somewhere — found ${threading.length} sites `
    + `passing a 21st positional. Zero (or near it) means the parameter was dropped from create() and `
    + `every "deliberately absent" row below is passing for the wrong reason.`);

  found.forEach((site, i) => {
    const want = EXPECTED[i];
    if (want.noWire === null) return; // the box registry — no such axis, see its label
    const where = `${site.file}:${site.line} (${want.label})`;
    if (want.noWire === false) {
      assert.strictEqual(site.arity, 20,
        `${where}\nis a row the table says does NOT thread noWire, so it must stop at the 20th `
        + `positional. Found arity ${site.arity} — if you deliberately added the flag here, change `
        + `the table row and say why in its label; do not leave the two disagreeing.`);
    } else {
      assert.strictEqual(site.noWire, want.noWire,
        `${where}\nmust pass noWire as \`${want.noWire}\`. Found: ${site.noWire}\n`
        + `Dropping it (or reading it off the wrong object) makes a wire-off seat respawn WIRED: `
        + `ANTHROPIC_BASE_URL comes back and Anthropic's remote access can no longer attach — `
        + `silently, since the sidebar mark is rendered from a different value.`);
    }
  });
});

// Companion to the mint-default pin below, and load-bearing for the same reason:
// the table's `false` rows above assert an ABSENT argument, which is only correct
// while the parameter's default is false. A signature edit flipping it would make
// three sites silently wire-off with nothing else failing.
test('t189 census: create()\'s noWire parameter still DEFAULTS FALSE', () => {
  const src = fs.readFileSync(path.join(ROOT, 'session-manager.js'), 'utf8');
  const sig = /async create\(([^)]*)\)/.exec(src);
  assert.ok(sig, 'ENTER: create()\'s signature must be findable, or this pins nothing');
  assert.match(sig[1], /noWire\s*=\s*false/,
    'create()\'s noWire parameter must still default FALSE — the census rows that expect an ABSENT '
    + 'argument are only correct while it does.');
});

// The parameter default is what every restore path above actually relies on —
// none of them pass the argument at all. Pin it, because the table's `false` rows
// are only correct while the default is false, and a future signature edit that
// flipped it would make eight sites silently wrong with nothing else failing.
test('mint census: create()\'s mint parameter still DEFAULTS FALSE', () => {
  const src = fs.readFileSync(path.join(ROOT, 'session-manager.js'), 'utf8');
  const sig = /async create\(([^)]*)\)/.exec(src);
  assert.ok(sig, 'could not find create()\'s signature in session-manager.js');
  assert.match(sig[1], /\bmint\s*=\s*false\b/,
    'create()\'s `mint` parameter must default to FALSE. Every restore call site omits the '
    + 'argument and depends on that default; flipping it would turn each of them into a '
    + 'spurious regenerate — the token bust — with no other test failing.');
});

// t78: the scanner's own comment/regex handling, pinned directly.
//
// Before this, the census's correctness rested on a comment in an unrelated file
// continuing to avoid a phrase — cli-hooks.js was REWORDED to dodge the regex
// rather than the scanner being fixed. Prose is not a guard: one word changed
// there and the count goes silently wrong. These two synthetic sources pin the
// two behaviours the census depends on, so the guarantee is tested here instead
// of maintained by hand over there.
//
// The second case is the dangerous one and it is why this is not a whole-file
// strip: a regex literal containing an apostrophe must NOT open a phantom string.
// When it did, the swallowed region hid a real call site and the census reported
// a healthy-looking wrong number.
test('t78: the scanner ignores prose and is not fooled by a regex literal', () => {
  const inComment = (src, idx) => commentRanges(src).some(([s, e]) => idx >= s && idx < e);
  const findAt = (src) => {
    const m = /(\w+)\.create\s*\(/.exec(src);
    assert.ok(m, 'the probe source must contain a `<word>.create(` for this pin to mean anything');
    return m.index;
  };

  // (a) The pre-t71 wording: prose naming the call form. Counting it inflates the
  // census by one and sends a reader hunting for a call site that does not exist.
  const prose = "// the one expression lives in session-manager.create(name)\nfunction noop() {}\n";
  assert.ok(inComment(prose, findAt(prose)),
    'a `<word>.create(` inside a line comment must be seen as prose — counting it adds a phantom call site to the census and the table then has to be padded with a row for something that is not a call');

  // (b) A real call site preceded by a regex literal containing an apostrophe.
  // This is the exact shape that previously opened a phantom string and swallowed
  // ipc-handlers.js's deploy-fix site, dropping the census to a healthy-looking 10.
  const withRegex = "const RE = /it's here/;\nmgr.create(1, 2, 3);\n";
  assert.ok(!inComment(withRegex, findAt(withRegex)),
    "a regex literal containing an apostrophe must not swallow the code after it — that is the phantom-string failure this scanner was written to avoid, and it HIDES call sites rather than adding them, so the census looks healthy while under-counting");

  // (b2) THE ACTUAL DISCRIMINATOR for regex-awareness, and the reason (b) alone is
  // not enough. Measured: disabling the regex branch entirely leaves (b) passing.
  // commentRanges only ever returns COMMENT ranges, so a phantom string cannot
  // invent a hit — it can only fail to report one. The damage therefore runs the
  // other way: an unterminated phantom string swallows the `//` that follows, the
  // comment is never recognised, and the prose inside it gets counted as a call
  // site. That is the failure a test built only on (b) would sleep through.
  const regexThenProse = "const RE = /it's/;\n// prose naming mgr.create(name) here\n";
  assert.ok(inComment(regexThenProse, findAt(regexThenProse)),
    'a regex literal containing an apostrophe must not hide the COMMENT that follows it — when it does, the prose in that comment is scanned as code and the census counts a call site that does not exist, which is the phantom-string bug arriving as an over-count instead of an under-count');

  // (c) Division must not be mistaken for a regex opener — the mirror of (b). If
  // it were, everything after a `/` would be read as a regex and real sites would
  // vanish the same way.
  const division = "const n = total / 2;\nmgr.create(1);\n";
  assert.ok(!inComment(division, findAt(division)),
    'a division operator must not open a regex scan — misreading it swallows the rest of the file and drops real call sites');
});
