// team-measure.js — what can be PROVEN about a project directory, as findings.
//
// The measured half of the team helper: a wish in, a working team out, with the
// operator never writing a prompt. The generative half (a `claude -p` one-shot
// that writes the append prompt) cannot be pinned by a test. This half can, and
// it is the load-bearing one — the measured claims are the ones that can be
// WRONG, which is exactly why they are marked measured.
//
// THE RULE, and the reason this module exists at all: NEVER GUESS. An `absent`
// finding is a first-class result carrying its own operator-readable claim, not
// an omission from the array and not a default value. `measure()` returns all
// five ids on every call whatever the repo looks like. Dropping an unmeasurable
// finding, or filling it with a plausible default, produces a hand that runs a
// wrong command confidently — the worst outcome available here, and strictly
// worse than a gap the operator can see and fill.
//
// Pure leaf: no requires at all. fs/path/childProcess arrive by injection, which
// is what makes the whole findings table assertable against a fixture directory.
//
// childProcess is for `git rev-parse` on worktreeSupport and NOTHING else. This
// module must never execute the project's own test command: running an unknown
// repo's scripts as a side effect of DESCRIBING it is not a thing a describe
// step may do. `suite` is `measured` when the command was FOUND, never when it
// was proven to run.
'use strict';

// Stable machine keys — the generator keys off these, so renaming one silently
// drops a claim from the rationale sheet rather than failing anything.
const FINDING_IDS = ['suite', 'packageManager', 'vcs', 'worktreeSupport', 'generatedPaths'];
const STATUSES = ['measured', 'absent'];

// Lockfile → manager. Decided by lockfile PRESENCE, never by package.json's
// `packageManager` field, which is frequently stale and would then be a
// confident wrong answer. bun ships two names: .lockb (binary, <1.2) and .lock
// (text, >=1.2); missing the second reads a modern bun repo as having no lockfile.
const LOCKFILES = [
  ['package-lock.json', 'npm'],
  ['pnpm-lock.yaml', 'pnpm'],
  ['yarn.lock', 'yarn'],
  ['bun.lockb', 'bun'],
  ['bun.lock', 'bun'],
];

// How many generated paths the claim names before it summarizes the rest. A
// claim is one sentence an operator reads; a 40-entry .gitignore rendered whole
// is not one.
const PATHS_IN_CLAIM = 5;

function measured(id, claim, evidence) {
  return { id, claim, status: 'measured', evidence };
}

// evidence is null for absent — there is no file-and-key to point at, and
// inventing one would describe a read that never happened.
function absent(id, claim) {
  return { id, claim, status: 'absent', evidence: null };
}

function isNonEmptyString(v) {
  return typeof v === 'string' && v.length > 0;
}

function createTeamMeasure({ fs, path, childProcess } = {}) {
  const readText = (root, rel) => {
    try {
      const text = fs.readFileSync(path.join(root, rel), 'utf8');
      return typeof text === 'string' ? text : null;
    } catch { return null; }
  };

  const exists = (root, rel) => {
    try { return !!fs.existsSync(path.join(root, rel)); } catch { return false; }
  };

  const readJson = (root, rel) => {
    const text = readText(root, rel);
    if (text === null) return null;
    try {
      const value = JSON.parse(text);
      return (value && typeof value === 'object' && !Array.isArray(value)) ? value : null;
    } catch { return null; }
  };

  // ---- 1. suite -----------------------------------------------------------
  // First hit wins, in the spec's order. Order is load-bearing: a polyglot repo
  // with both package.json and a Makefile gets ONE answer, deterministically,
  // rather than whichever probe the loop happened to reach first.
  function measureSuite(root) {
    const pkg = readJson(root, 'package.json');
    const scripts = (pkg && pkg.scripts && typeof pkg.scripts === 'object') ? pkg.scripts : null;
    if (scripts && isNonEmptyString(scripts.test)) {
      return measured('suite', suiteClaim('npm test'), 'package.json scripts.test');
    }

    const makefile = readText(root, 'Makefile');
    // Anchored at line start so `.PHONY: test` — which declares the target
    // without defining it — does not read as the target itself.
    if (makefile !== null && /^test[ \t]*:/m.test(makefile)) {
      return measured('suite', suiteClaim('make test'), 'Makefile test: target');
    }

    if (exists(root, 'pytest.ini')) return measured('suite', suiteClaim('pytest'), 'pytest.ini');
    if (exists(root, 'tox.ini')) return measured('suite', suiteClaim('tox'), 'tox.ini');

    const pyproject = readText(root, 'pyproject.toml');
    // Prefix, not the exact literal: real files write [tool.pytest.ini_options].
    // Matching `[tool.pytest]` alone misses nearly every pytest project there is.
    if (pyproject !== null && /^[ \t]*\[tool\.pytest/m.test(pyproject)) {
      return measured('suite', suiteClaim('pytest'), 'pyproject.toml [tool.pytest]');
    }

    if (exists(root, 'Cargo.toml')) return measured('suite', suiteClaim('cargo test'), 'Cargo.toml');
    if (exists(root, 'go.mod')) return measured('suite', suiteClaim('go test ./...'), 'go.mod');

    return absent('suite',
      'Your hands will NOT have a verified suite command — nothing in this project names one, '
      + 'so tell them how to run the tests or they will not run them.');
  }

  function suiteClaim(cmd) {
    return `Your hands will run the suite with \`${cmd}\`, not directly.`;
  }

  // ---- 2. packageManager --------------------------------------------------
  function measurePackageManager(root) {
    const hits = [];
    for (const [file, manager] of LOCKFILES) {
      if (!exists(root, file)) continue;
      // bun's two lockfile names are the SAME manager, so a repo carrying both
      // is not ambiguous and must not be reported as such.
      if (hits.some((h) => h.manager === manager)) continue;
      hits.push({ file, manager });
    }

    if (hits.length === 1) {
      const { file, manager } = hits[0];
      return measured('packageManager',
        `Your hands will use \`${manager}\` for installs and script runs, because \`${file}\` is this project's lockfile.`,
        file);
    }

    if (hits.length > 1) {
      // Deliberately NOT resolved by precedence. Picking one here is the guess
      // the acceptance criterion forbids: the wrong pick installs a different
      // dependency graph than the one the project's lockfile pins.
      const names = hits.map((h) => `\`${h.file}\``).join(', ');
      return absent('packageManager',
        `Your hands will NOT assume a package manager — this project has more than one lockfile (${names}), `
        + 'so nothing here can say which one is real. Tell them which to use.');
    }

    return absent('packageManager',
      'Your hands will NOT assume a package manager — this project has no lockfile to name one.');
  }

  // ---- 3. vcs -------------------------------------------------------------
  function measureVcs(root) {
    let stat = null;
    try { stat = fs.statSync(path.join(root, '.git')); } catch { stat = null; }
    if (!stat) {
      return absent('vcs',
        'Your hands will NOT have version control here — this project is not a git checkout, '
        + 'so nothing records or undoes what they change.');
    }
    // A WORKTREE checkout's .git is a FILE, not a directory. Requiring a
    // directory reads every worktree as "no git" — which is precisely the tree
    // the hands work in, so that bug would fire on the common case, not the
    // exotic one.
    const kind = stat.isDirectory() ? 'directory' : 'file';
    return measured('vcs',
      'Your hands will commit their work to git, on a branch of their own.',
      `.git (${kind})`);
  }

  // ---- 4. worktreeSupport -------------------------------------------------
  // Requires git AND at least one commit: `git worktree add` on a repo with no
  // commits fails, so a claim promising each hand its own tree would be false
  // on the very first dispatch.
  function measureWorktreeSupport(root, vcs) {
    if (vcs.status !== 'measured') {
      return absent('worktreeSupport',
        'Your hands will NOT get a worktree of their own — this project is not a git checkout, '
        + 'so they will all be editing the same tree.');
    }

    let hasCommit = false;
    try {
      childProcess.execFileSync('git', ['-C', root, 'rev-parse', '--verify', 'HEAD'], {
        stdio: ['ignore', 'ignore', 'ignore'],
        timeout: 5000,
      });
      hasCommit = true;
    } catch { hasCommit = false; }

    if (!hasCommit) {
      return absent('worktreeSupport',
        'Your hands will NOT get a worktree of their own yet — this project is a git checkout with no '
        + 'commits, and `git worktree` needs one. Make the first commit and this becomes available.');
    }

    return measured('worktreeSupport',
      'Your hands will each work in their own `git worktree`, on a branch minted for the ticket.',
      'git rev-parse --verify HEAD');
  }

  // ---- 5. generatedPaths --------------------------------------------------
  // Read ONLY from the committed ignore file. A directory listing would find
  // build output that is nobody's rule, and a hand told not to edit a path the
  // project never declared generated is a hand blocked from real work.
  function measureGeneratedPaths(root) {
    const text = readText(root, '.gitignore');
    if (text === null) {
      return absent('generatedPaths',
        'Your hands will NOT know which paths are generated — this project has no `.gitignore` to name them.');
    }

    const dirs = [];
    for (const raw of text.split('\n')) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      if (line.startsWith('!')) continue; // a re-inclusion is the opposite of a generated path
      if (/[*?[\]]/.test(line)) continue; // a glob names a shape, not a path a hand can be pointed at
      // Trailing slash is the ONLY thing in .gitignore's grammar that says
      // "directory". A bare `node_modules` may name a file, and calling it a
      // directory would be exactly the guess this module refuses to make.
      if (!line.endsWith('/')) continue;
      const norm = line.replace(/^\/+/, '').replace(/\/+$/, '');
      if (!norm || dirs.includes(norm)) continue;
      dirs.push(norm);
    }

    if (!dirs.length) {
      return absent('generatedPaths',
        "Your hands will NOT know which paths are generated — this project's `.gitignore` names no directories.");
    }

    const shown = dirs.slice(0, PATHS_IN_CLAIM).map((d) => `\`${d}/\``).join(', ');
    const rest = dirs.length - PATHS_IN_CLAIM;
    const tail = rest > 0 ? ` (and ${rest} more)` : '';
    return measured('generatedPaths',
      `Your hands will not hand-edit this project's generated paths: ${shown}${tail}.`,
      '.gitignore');
  }

  // Returned in FINDING_IDS order, always all five. A caller rendering the
  // rationale sheet walks the array as it stands.
  function measure(root) {
    const vcs = measureVcs(root);
    return [
      measureSuite(root),
      measurePackageManager(root),
      vcs,
      measureWorktreeSupport(root, vcs),
      measureGeneratedPaths(root),
    ];
  }

  return { measure };
}

module.exports = { createTeamMeasure, FINDING_IDS, STATUSES };
