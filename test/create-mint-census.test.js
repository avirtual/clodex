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

// Collect every `<recv>.create(` in the root modules, in file then source order.
// `Object.create` is excluded by name (it is not this method). Root *.js only:
// renderer/ has no session manager, and web-dist/ is a build artifact full of
// bundled `Object.create`.
function census() {
  const out = [];
  for (const file of fs.readdirSync(ROOT).filter(f => f.endsWith('.js')).sort()) {
    const src = fs.readFileSync(path.join(ROOT, file), 'utf8');
    const re = /(\w+)\.create\s*\(/g;
    let m;
    while ((m = re.exec(src))) {
      if (m[1] === 'Object') continue;
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
const EXPECTED = [
  { file: 'engine.js', mint: false, label: 'restartSession — in-place restart, same conversation' },
  { file: 'engine.js', mint: false, label: 'applySessionArgs — args-edit restart, same conversation' },
  { file: 'ipc-handlers.js', mint: true, label: 'spawnFromParams — THE mint front door (session:create / team:create / team:join)' },
  { file: 'ipc-handlers.js', mint: true, label: 'peer:deployFix — brand-new session under a freshly deconflicted name' },
  { file: 'ipc-handlers.js', mint: null, label: 'sandbox:createBox — mgr.create(id, label), the BOX REGISTRY. A different object entirely; it has no mint axis and never spawns a PTY. Listed so the census stays exhaustive and nobody "fixes" it by adding a flag.' },
  { file: 'ipc-handlers.js', mint: false, label: 'session:retrySpawn — retry of a failed restore' },
  { file: 'remote-wiring.js', mint: true, label: 'peer createSession — the REMOTE front door. Refuses live-or-persisted names, so every session born here is new; carries a resumeId only on a remote adopt, which is still a mint. This is the site that shipped mint-less (t71 defect 2).' },
  { file: 'session-manager.js', mint: true, label: '[agent:spawn] intent — agent-initiated new seat' },
  { file: 'session-manager.js', mint: true, label: 'team-review reviewer seat — ephemeral, monotonic name, always brand new' },
  { file: 'session-manager.js', mint: false, label: '[agent:context reload] — cold respawn of the SAME seat' },
  { file: 'session-restore.js', mint: false, label: 'restoreSessionsForWorkspace — restore-on-launch, the real one' },
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
      assert.strictEqual(site.arity, 20,
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
