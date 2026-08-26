'use strict';

// Shared tmpdir bookkeeping for the test files that mint scratch roots with
// mkdtempSync. Measured before this existed (t498): one full suite run left
// 2,909 directories in $TMPDIR across 80 files, and 243,200 had accumulated on
// the box — 86% of everything in $TMPDIR. macOS does not reap them on any
// timescale that matters; the oldest were days old.
//
// Node's test glob is `**/test/**/*.?(c|m)js`, so this file is ALSO opened as a
// test file and reports as one passing point that executed nothing — the same
// price test/lib/pty-reap.js pays, and for the same reason. Its own `after`
// below then runs with an empty list.
//
// A SHARED helper rather than 80 copies of the hook because the survey found
// exactly one mint shape: `mkdtempSync(path.join(os.tmpdir(), prefix))`, in two
// alias spellings (plain, and the fsReal/osReal/pathReal aliases the files that
// shadow those modules with test doubles use). Nothing in the suite mocks
// mkdtempSync, os.tmpdir or rmSync, so minting through the real fs here is
// equivalent to what every call site was already doing.
const { after } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOTS = [];

// Mint a scratch root and register it for the sweep. Registration happens AT
// MINT TIME, before the caller can do anything with the directory, so a subject
// that throws half way through still gets its root reaped.
function mkTmpRoot(prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  ROOTS.push(root);
  return root;
}

// For a root minted some other way — under a realpath'd tmpdir, say. Only for
// roots directly in a shared temp parent: a directory nested inside an
// already-tracked root goes with its parent and must not be listed twice.
function trackTmpRoot(root) {
  ROOTS.push(root);
  return root;
}

// TOP-LEVEL `after`, and that is the whole safety argument. node:test runs
// top-level subjects sequentially and top-level `after` hooks last, so a
// subject whose assertion is that a directory is STILL ON DISK (destroy()
// orphaning a checkout, a spill file surviving a read) has already run and
// passed by the time this fires. An `afterEach` would delete that evidence
// between subjects and leave those tests passing for the wrong reason.
//
// Registered at REQUIRE time, so it lands before the requiring file's own
// hooks — including the `setImmediate(() => process.exit(0))` force-exit those
// files use to stop engine background timers. The sweep therefore completes
// before the exit. The two are kept as separate hooks rather than merged: they
// answer to different concerns and one file's force-exit is not the other's.
//
// Siblings are globbed on `path.basename(root) + '-'`, NEVER on the shared
// prefix the call site passed. All 128 minting files share one $TMPDIR, so
// uniqueness comes only from mkdtempSync's random characters: a sweep of
// `clodex-repo-*` would delete another file's LIVE fixtures, and under parallel
// load that failure reads as a flake anywhere except the file that caused it.
// The per-root prefix cannot touch anything this process did not make.
//
// That glob is also how derived siblings are covered — git-worktree.js places
// `<repoName>-<branch>` (plus a `-2` collision suffix) beside the repo root it
// is given. Re-deriving that rule here would go stale silently the next time it
// changes; the prefix sweep covers it by construction.
function rmQuiet(target) {
  // Every removal is guarded. A fixture can leave a root unremovable —
  // test/fs-explorer.test.js and test/tickets-migrate.test.js both chmod 0o000 a
  // directory inside a try/finally, so a throw between the chmod and the restore
  // leaves exactly that state — and an unguarded rmSync here would throw out of a
  // top-level `after` and turn cleanup into a RED FILE. Cleanup failing to clean
  // is a leak; cleanup failing loudly is a broken suite, which is worse.
  try { fs.rmSync(target, { recursive: true, force: true }); } catch { /* not ours to force */ }
}

function sweep() {
  // Grouped by parent so each pass does ONE readdirSync per distinct parent,
  // not one per root. The ungrouped version was O(roots × $TMPDIR entries): on a
  // box with 283k entries a readdirSync costs ~170ms, so session-manager.test.js
  // (877 roots × 2 passes) spent ~292s enumerating the same directory 1,754
  // times — measured, and it dominated the file's runtime.
  //
  // Keyed on the parent rather than assuming one, because there is more than
  // one: test/clodex-team.test.js mints under fs.realpathSync(os.tmpdir()),
  // which on macOS is a different string from os.tmpdir() itself.
  const byParent = new Map();
  for (const root of ROOTS) {
    const parent = path.dirname(root);
    let bases = byParent.get(parent);
    if (!bases) byParent.set(parent, (bases = []));
    bases.push(path.basename(root));
  }
  for (const [parent, bases] of byParent) {
    const prefixes = bases.map((b) => `${b}-`);
    try {
      for (const name of fs.readdirSync(parent)) {
        for (const prefix of prefixes) {
          if (name.startsWith(prefix)) { rmQuiet(path.join(parent, name)); break; }
        }
      }
    } catch { /* parent unreadable — nothing to sweep */ }
    // The roots themselves, which the scan above cannot match: a name is never a
    // sibling of its own prefix (`base` does not start with `base + '-'`), so
    // this is the only pass that removes them and nothing is handled twice.
    for (const base of bases) rmQuiet(path.join(parent, base));
  }
}

after(sweep);

// Swept AGAIN on the way out, and this pass is not belt-and-braces. A subject
// can return with a production `setImmediate` still queued — team-tickets.js
// defers its task-dir write that way — and that immediate fires AFTER the
// `after` hook, re-creating a tree the sweep had already removed. Measured on
// test/review-verdict-ticket.test.js: the after-hook sweep left the root gone
// and one directory was back at the same path by process exit.
//
// `exit` handlers run on an explicit `process.exit(0)` too, which is how the
// files that force-exit past engine background timers are covered. Only
// synchronous work is possible here, which rmSync already is. ROOTS is
// deliberately NOT cleared by sweep(): this pass needs the same list, and
// rmSync({ force: true }) over an already-removed path is a no-op.
process.on('exit', sweep);

module.exports = { mkTmpRoot, trackTmpRoot };
