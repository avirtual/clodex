const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const { mkTmpRoot } = require('./lib/tmp-roots');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'cloud-review.sh');
const POST = path.join(__dirname, '..', 'scripts', 'cloud-review-post.sh');

function withStub(body, fn) {
  const dir = mkTmpRoot('clodex-cloud-review-');
  const stub = path.join(dir, 'claude');
  const rec = path.join(dir, 'rec');
  fs.writeFileSync(stub, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  try { return fn({ dir, stub, rec }); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

function runScript(args, env) {
  return execFileSync('bash', [SCRIPT, ...args], {
    encoding: 'utf-8',
    env: {
      ...process.env, CLODEX_RELEASE_NO_REVIEW: '',
      CLODEX_GH_BIN: 'true', CLODEX_GIT_BIN: 'true', CLODEX_REVIEW_TIMEOUT_S: '0', CLODEX_REVIEW_POLL_S: '0',
      ...env,
    },
  });
}

function killPoller(out) {
  const pid = Number((String(out || '').match(/issue poller launched \(pid (\d+)\)/) || [])[1]);
  if (pid) { try { process.kill(pid, 'SIGKILL'); } catch {} }
}

function killMatching(pattern) {
  const pids = (spawnSync('pgrep', ['-f', pattern], { encoding: 'utf-8' }).stdout || '').split('\n').filter(Boolean);
  for (const pid of pids) { try { process.kill(Number(pid), 'SIGKILL'); } catch {} }
}

const RECORD = 'if [ -t 1 ]; then T=yes; else T=no; fi; { printf \'%s\\n\' "$@"; printf \'%s\\n\' "--ENV--" "TTY=$T"; env; } > "$CLOUD_REVIEW_REC"';

const FIFO_BOUND_MS = 10000;

function launchAndRecord(extraEnv, args = ['v1.0.0', 'v1.1.0']) {
  return withStub(RECORD, ({ dir, stub, rec }) => {
    execFileSync('mkfifo', [rec]);
    let out;
    let recorded;
    try {
      out = runScript(args, {
        CLODEX_CLAUDE_BIN: stub, CLOUD_REVIEW_REC: rec, HOME: dir, ...extraEnv,
      });
      recorded = execFileSync('cat', [rec], { encoding: 'utf-8', timeout: FIFO_BOUND_MS });
    } catch (err) {
      killMatching(stub);
      throw err;
    } finally {
      killPoller(out);
    }
    const [argv, env] = recorded.split('--ENV--\n');
    return { out, argv, env, logExists: fs.existsSync(path.join(dir, '.clodex', 'logs', `cloud-review-${args[1]}.log`)) };
  });
}

test('cloud-review: the stub gets --cloud and a brief naming both tags and the issue title', () => {
  const { out, argv, logExists } = launchAndRecord({});
  assert.match(out, /launched for v1\.0\.0\.\.v1\.1\.0/);
  assert.strictEqual(argv.split('\n')[0], '--cloud');
  assert.ok(argv.includes('v1.0.0..v1.1.0'), argv);
  assert.ok(argv.includes('Release review v1.1.0'), argv);
  assert.ok(!argv.includes('{{'), 'every placeholder is substituted');
  assert.match(argv, /\n--model\nclaude-opus-5-5\n/);
  assert.match(argv, /\n--permission-mode\nbypassPermissions\n/);
  assert.ok(logExists, 'output goes to ~/.clodex/logs/cloud-review-<newTag>.log');
});

test('cloud-review: a pre-release launch checks out the staging sha and verifies the Unreleased section', () => {
  const { out, argv } = launchAndRecord({
    CLODEX_REVIEW_REF: 'staging', CLODEX_REVIEW_SHA: 'abc123', CLODEX_REVIEW_PREFIX: 'Pre-release review staging-abc12345:',
  }, ['v1.0.0', 'staging-abc12345']);
  assert.match(out, /launched for v1\.0\.0\.\.staging-abc12345/);
  assert.ok(argv.includes('First run `git fetch origin staging && git checkout abc123`.'), argv);
  assert.ok(argv.includes('`git log v1.0.0..abc123`'), argv);
  assert.ok(argv.includes('`## Unreleased` section'), argv);
  assert.ok(argv.includes('"Pre-release review staging-abc12345: <VERDICT>"'), argv);
  assert.ok(argv.includes('.review/staging-abc12345.md'), argv);
  assert.ok(argv.includes('git push --force origin claude/review-staging-abc12345'), argv);
  assert.ok(!argv.includes('v1.0.0..staging-abc12345'), argv);
  assert.ok(!argv.includes('{{'), argv);
});

test('cloud-review: a release launch checks out the new tag and verifies its versioned section', () => {
  const { argv } = launchAndRecord({});
  assert.ok(argv.includes('First run `git checkout v1.1.0`.'), argv);
  assert.ok(argv.includes('Verify every bullet of the v1.1.0 section of CHANGELOG.md (its heading is `## <version> — <date>`'), argv);
  assert.ok(!argv.includes('Unreleased'), argv);
});

const PRE = path.join(__dirname, '..', 'scripts', 'pre-release-review.sh');

function runPreRelease({ dirty = false, statusFails = false, env = {} } = {}) {
  return withStub(RECORD, ({ dir, stub, rec }) => {
    const git = path.join(dir, 'git');
    const calls = path.join(dir, 'git-calls');
    fs.writeFileSync(git, [
      '#!/bin/sh',
      `printf '%s\n' "$*" >> "${calls}"`,
      'case "$1" in',
      `  status) ${statusFails ? 'exit 1' : dirty ? "printf ' M x\\n'" : ':'} ;;`,
      '  branch) echo master ;;',
      '  describe) echo v1.0.0 ;;',
      '  rev-parse) case "$2" in --short=8) echo deadbeef ;; *) echo deadbeef00112233445566778899aabbccddeeff ;; esac ;;',
      'esac',
      '',
    ].join('\n'), { mode: 0o755 });
    execFileSync('mkfifo', [rec]);
    const res = spawnSync('bash', [PRE], {
      encoding: 'utf-8',
      timeout: FIFO_BOUND_MS,
      env: {
        ...process.env, HOME: dir, CLODEX_RELEASE_NO_REVIEW: '', CLODEX_REVIEW_REF: '', CLODEX_REVIEW_SHA: '', CLODEX_REVIEW_PREFIX: '',
        CLODEX_GH_BIN: 'true', CLODEX_GIT_BIN: git, CLODEX_REVIEW_POLLER_BIN: 'true',
        CLODEX_CLAUDE_BIN: stub, CLOUD_REVIEW_REC: rec,
        ...env,
      },
    });
    let argv = null;
    try {
      if (res.status === 0 && !/skipped/.test(res.stdout)) argv = execFileSync('cat', [rec], { encoding: 'utf-8', timeout: FIFO_BOUND_MS }).split('--ENV--\n')[0];
    } finally {
      killMatching(stub);
    }
    const gitCalls = fs.existsSync(calls) ? fs.readFileSync(calls, 'utf-8').split('\n').filter(Boolean) : [];
    return { res, argv, gitCalls };
  });
}

test('pre-release-review: force-pushes HEAD to staging and briefs the reviewer on staging-<short sha>', () => {
  const { res, argv, gitCalls } = runPreRelease();
  assert.strictEqual(res.status, 0, res.stderr);
  assert.ok(gitCalls.includes('push -q --force origin HEAD:refs/heads/staging'), gitCalls.join('\n'));
  assert.ok(gitCalls.includes('rev-parse --short=8 HEAD'), gitCalls.join('\n'));
  assert.match(res.stdout, /pre-release-review: launched for v1\.0\.0\.\.staging-deadbeef/);
  assert.ok(argv.includes('.review/staging-deadbeef.md'), argv);
  assert.ok(argv.includes('"Pre-release review staging-deadbeef: CLEAN"'), argv);
  assert.ok(argv.includes('git fetch origin staging && git checkout deadbeef00112233445566778899aabbccddeeff'), argv);
  assert.ok(argv.includes('v1.0.0..deadbeef'), argv);
});

test('pre-release-review: a dirty tree exits non-zero and pushes nothing', () => {
  const { res, gitCalls } = runPreRelease({ dirty: true });
  assert.notStrictEqual(res.status, 0);
  assert.match(res.stderr, /not clean/);
  assert.ok(gitCalls.includes('status --porcelain'), gitCalls.join('\n'));
  assert.ok(!gitCalls.some((c) => c.startsWith('push')), gitCalls.join('\n'));
});

test('pre-release-review: an exported CLODEX_RELEASE_NO_REVIEW=1 still launches the review', () => {
  const { res, argv } = runPreRelease({ env: { CLODEX_RELEASE_NO_REVIEW: '1' } });
  assert.strictEqual(res.status, 0, res.stderr);
  assert.doesNotMatch(res.stdout, /skipped/);
  assert.ok(argv && argv.includes('.review/staging-deadbeef.md'), String(argv));
});

test('pre-release-review: a failed git status exits non-zero and pushes nothing', () => {
  const { res, gitCalls } = runPreRelease({ statusFails: true });
  assert.notStrictEqual(res.status, 0);
  assert.match(res.stderr, /git status failed/);
  assert.ok(gitCalls.includes('status --porcelain'), gitCalls.join('\n'));
  assert.ok(!gitCalls.some((c) => c.startsWith('push')), gitCalls.join('\n'));
});

test('cloud-review: claude runs on a terminal, since --cloud refuses one without', () => {
  const { env } = launchAndRecord({});
  assert.match(env, /^TTY=yes$/m);
});

test('cloud-review: CLAUDE_CONFIG_DIR from the parent never reaches claude', () => {
  const { env } = launchAndRecord({ CLAUDE_CONFIG_DIR: '/seat/account/dir', CLODEX_CANARY: 'still-here' });
  assert.match(env, /^CLODEX_CANARY=still-here$/m);
  assert.doesNotMatch(env, /^CLAUDE_CONFIG_DIR=/m);
});

test('cloud-review: CLAUDE_CODE_OAUTH_TOKEN from the parent never reaches claude', () => {
  const { env } = launchAndRecord({ CLAUDE_CODE_OAUTH_TOKEN: 'seat-scoped-token', CLODEX_CANARY: 'still-here' });
  assert.match(env, /^CLODEX_CANARY=still-here$/m);
  assert.doesNotMatch(env, /^CLAUDE_CODE_OAUTH_TOKEN=/m);
});

test('cloud-review: the brief reports by pushing .review/<tag>.md on claude/review-<tag>, never through gh or add_repo', () => {
  const brief = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'cloud-review-brief.md'), 'utf-8');
  assert.ok(brief.includes('"{{PREFIX}} CLEAN"'), brief);
  assert.ok(!brief.includes('gh auth status'), brief);
  assert.ok(!brief.includes('gh api'), brief);
  assert.ok(brief.includes('git push --force origin claude/review-{{NEW}}'), brief);
  assert.ok(brief.includes('.review/{{NEW}}.md'), brief);
  assert.ok(brief.includes('do not call add_repo'), brief);
  assert.ok(brief.includes('npm ci --ignore-scripts'), brief);
  assert.ok(!brief.includes('GitHub tools'), brief);
  assert.ok(!brief.includes('timeout 60 gh'), brief);
  assert.ok(!brief.includes('never the gh CLI'), brief);
});

test('cloud-review: CLODEX_RELEASE_NO_REVIEW=1 skips without invoking claude', () => {
  withStub('touch "$CLOUD_REVIEW_REC"', ({ dir, stub, rec }) => {
    const out = runScript(['v1.0.0', 'v1.1.0'], {
      CLODEX_CLAUDE_BIN: stub, CLOUD_REVIEW_REC: rec, HOME: dir, CLODEX_RELEASE_NO_REVIEW: '1',
    });
    assert.match(out, /skipped/);
    assert.doesNotMatch(out, /launched for/);
    assert.ok(!fs.existsSync(rec), 'the stub never ran');
    assert.ok(!fs.existsSync(path.join(dir, '.clodex')), 'no log dir is created on a skip');
  });
});

test('cloud-review: CLODEX_RELEASE_NO_REVIEW=1 launches no issue poller either', () => {
  withStub('touch "$CLOUD_REVIEW_REC"', ({ dir, stub, rec }) => {
    const out = runScript(['v1.0.0', 'v1.1.0'], {
      CLODEX_CLAUDE_BIN: stub, CLOUD_REVIEW_REC: rec, HOME: dir, CLODEX_RELEASE_NO_REVIEW: '1',
    });
    assert.match(out, /^cloud-review: skipped \(CLODEX_RELEASE_NO_REVIEW=1\)$/m);
    assert.doesNotMatch(out, /issue poller launched/);
  });
});

test('cloud-review: the launch also starts the issue poller for the new tag', () => {
  withStub('true', ({ dir, stub }) => {
    const gh = path.join(dir, 'gh');
    const rec = path.join(dir, 'gh-rec');
    fs.writeFileSync(gh, `#!/bin/sh\nprintf '%s\\n' "$@" > "${rec}"\n`, { mode: 0o755 });
    execFileSync('mkfifo', [rec]);
    let out;
    try {
      out = runScript(['v1.0.0', 'v1.1.0'], { CLODEX_CLAUDE_BIN: stub, HOME: dir, CLODEX_GH_BIN: gh });
      assert.match(out, /^cloud-review: issue poller launched \(pid \d+\)$/m);
      const argv = execFileSync('cat', [rec], { encoding: 'utf-8', timeout: FIFO_BOUND_MS }).split('\n');
      assert.deepStrictEqual(argv.slice(0, 5), ['issue', 'create', '-R', 'avirtual/clodex', '-t']);
      assert.strictEqual(argv[5], 'Release review v1.1.0: NO REPORT');
    } finally {
      killPoller(out);
      killMatching(dir);
    }
  });
});

const STALE_SHA = '0123abcd4567ef890123abcd4567ef8901234567';

function launchWithGit(lsHit, { renameFails = false } = {}) {
  return withStub('', ({ dir, stub }) => {
    const calls = path.join(dir, 'calls');
    const sync = path.join(dir, 'sync');
    fs.writeFileSync(stub, `#!/bin/sh\necho claude >> "${calls}"\necho done > "${sync}"\n`, { mode: 0o755 });
    const git = path.join(dir, 'git');
    fs.writeFileSync(git, [
      '#!/bin/sh',
      `printf 'git' >> "${calls}"; printf ' %s' "$@" >> "${calls}"; printf '\\n' >> "${calls}"`,
      lsHit ? `if [ "$1" = ls-remote ]; then printf '${STALE_SHA}\\trefs/heads/claude/review-v1.1.0\\n'; fi` : '',
      renameFails ? 'case "$3 $4" in "origin refs/remotes/"*) exit 1;; esac' : '',
      '',
    ].join('\n'), { mode: 0o755 });
    execFileSync('mkfifo', [sync]);
    let out;
    try {
      out = runScript(['v1.0.0', 'v1.1.0'], { CLODEX_CLAUDE_BIN: stub, HOME: dir, CLODEX_GIT_BIN: git, CLODEX_REVIEW_POLLER_BIN: 'true' });
      execFileSync('cat', [sync], { encoding: 'utf-8', timeout: FIFO_BOUND_MS });
      return { out, calls: fs.readFileSync(calls, 'utf-8').split('\n').filter(Boolean) };
    } finally {
      killPoller(out);
      killMatching(dir);
    }
  });
}

test('cloud-review: a stale claude/review-<tag> on origin is kept under a -prev name, then deleted, before claude launches', () => {
  const { out, calls } = launchWithGit(true);
  const fetch = calls.indexOf('git fetch -q origin refs/heads/claude/review-v1.1.0:refs/remotes/origin/claude/review-v1.1.0');
  const rename = calls.indexOf('git push -q origin refs/remotes/origin/claude/review-v1.1.0:refs/heads/claude/review-v1.1.0-prev-0123abcd');
  const del = calls.indexOf('git push -q origin --delete claude/review-v1.1.0');
  const claude = calls.indexOf('claude');
  assert.ok(claude >= 0, 'ENTER: the claude stub ran\n' + calls.join('\n'));
  assert.ok(fetch >= 0 && fetch < rename, calls.join('\n'));
  assert.ok(rename >= 0 && rename < del, calls.join('\n'));
  assert.ok(del >= 0 && del < claude, calls.join('\n'));
  assert.match(out, /^cloud-review: kept the previous report as claude\/review-v1\.1\.0-prev-0123abcd$/m);
  assert.match(out, /^cloud-review: removed stale claude\/review-v1\.1\.0$/m);
});

test('cloud-review: a failed rename of the stale branch skips the delete and still launches', () => {
  const { out, calls } = launchWithGit(true, { renameFails: true });
  const claude = calls.indexOf('claude');
  assert.ok(claude >= 0, 'ENTER: the claude stub ran\n' + calls.join('\n'));
  assert.ok(calls.includes('git push -q origin refs/remotes/origin/claude/review-v1.1.0:refs/heads/claude/review-v1.1.0-prev-0123abcd'), calls.join('\n'));
  assert.ok(!calls.some((c) => c.includes('--delete')), calls.join('\n'));
  assert.match(out, /^warn: cloud-review: could not keep claude\/review-v1\.1\.0 as claude\/review-v1\.1\.0-prev-0123abcd; left it in place$/m);
  assert.doesNotMatch(out, /removed stale/);
});

test('cloud-review: with no claude/review-<tag> on origin the launcher deletes nothing', () => {
  const { out, calls } = launchWithGit(false);
  const claude = calls.indexOf('claude');
  assert.ok(claude >= 0, 'ENTER: the claude stub ran\n' + calls.join('\n'));
  assert.ok(calls.slice(0, claude).some((c) => c.startsWith('git ls-remote origin refs/heads/claude/review-v1.1.0')), calls.join('\n'));
  assert.ok(!calls.some((c) => c.startsWith('git push')), calls.join('\n'));
  assert.doesNotMatch(out, /removed stale/);
});

function runPoller({ hitAfter, report, env, ghFails = 0, fetchFails = 0, lsSleep = 0, ctAges = null, perlRec = false, windowMs = 0 }) {
  const dir = mkTmpRoot('clodex-cloud-review-post-');
  const calls = path.join(dir, 'calls');
  const count = path.join(dir, 'count');
  const ghCount = path.join(dir, 'gh-count');
  const fetchCount = path.join(dir, 'fetch-count');
  const reportFile = path.join(dir, 'report.md');
  fs.writeFileSync(reportFile, report || '');
  const git = path.join(dir, 'git');
  const gh = path.join(dir, 'gh');
  fs.writeFileSync(git, [
    '#!/bin/sh',
    `printf 'git' >> "${calls}"; printf ' %s' "$@" >> "${calls}"; printf '\\n' >> "${calls}"`,
    'case "$1" in',
    `  ls-remote) if [ ${lsSleep} -gt 0 ]; then sleep ${lsSleep}; fi; n=$(cat "${count}" 2>/dev/null || echo 0); n=$((n+1)); echo $n > "${count}"`,
    `    if [ "${hitAfter}" -gt 0 ] && [ $n -ge "${hitAfter}" ]; then printf 'abc123\\trefs/heads/claude/review-v1.1.0\\n'; fi ;;`,
    `  fetch) n=$(cat "${fetchCount}" 2>/dev/null || echo 0); n=$((n+1)); echo $n > "${fetchCount}"; if [ $n -le ${fetchFails} ]; then exit 1; fi ;;`,
    ctAges
      ? `  show) printf 'Release review v1.1.0: X\\n\\nhit %s\\n' "$(cat "${count}")" ;;`
      : `  show) cat "${reportFile}" ;;`,
    ...(ctAges ? [`  log) n=$(cat "${count}"); case $n in ${ctAges.map((a, i) => `${i + 1}) echo $(( $(date +%s) - ${a} )) ;;`).join(' ')} esac ;;`] : []),
    'esac',
    '',
  ].join('\n'), { mode: 0o755 });
  fs.writeFileSync(gh, [
    '#!/bin/sh',
    `printf 'gh' >> "${calls}"; printf ' [%s]' "$@" >> "${calls}"; printf '\\n' >> "${calls}"`,
    `if [ "$2" = create ]; then n=$(cat "${ghCount}" 2>/dev/null || echo 0); n=$((n+1)); echo $n > "${ghCount}"; if [ $n -le ${ghFails} ]; then echo "gh boom $n" >&2; exit 1; fi; fi`,
    'if [ "$2" = create ]; then shift 7; cp "$1" "' + path.join(dir, 'body') + '"; echo https://github.com/avirtual/clodex/issues/7; fi',
    '',
  ].join('\n'), { mode: 0o755 });
  const binDir = path.join(dir, 'bin');
  if (perlRec) {
    fs.mkdirSync(binDir);
    const realPerl = execFileSync('bash', ['-c', 'command -v perl'], { encoding: 'utf-8' }).trim();
    fs.writeFileSync(path.join(binDir, 'perl'), `#!/bin/sh\nprintf 'perl alarm %s\\n' "$4" >> "${calls}"\nexec "${realPerl}" "$@"\n`, { mode: 0o755 });
  }
  try {
    const res = spawnSync('bash', [POST, 'v1.1.0'], {
      encoding: 'utf-8',
      timeout: windowMs || FIFO_BOUND_MS,
      ...(windowMs ? { stdio: 'ignore', killSignal: 'SIGKILL' } : {}),
      env: {
        ...process.env, HOME: dir, CLODEX_GH_BIN: gh, CLODEX_GIT_BIN: git, CLODEX_REVIEW_TEST: '1',
        CLODEX_REVIEW_POLL_S: '0', CLODEX_REVIEW_TIMEOUT_S: '7200', CLODEX_REVIEW_RETRY_S: '0',
        ...(perlRec ? { PATH: `${binDir}:${process.env.PATH}` } : {}), ...(windowMs ? { TMPDIR: dir } : {}), ...env,
      },
    });
    if (res.error && !(windowMs && res.error.code === 'ETIMEDOUT')) throw res.error;
    const body = fs.existsSync(path.join(dir, 'body')) ? fs.readFileSync(path.join(dir, 'body'), 'utf-8') : null;
    const logFile = path.join(dir, '.clodex', 'logs', 'cloud-review-v1.1.0.log');
    const log = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf-8') : '';
    return { out: res.stdout, status: res.status, log, calls: fs.readFileSync(calls, 'utf-8').split('\n').filter(Boolean), body };
  } finally {
    killMatching(dir);
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('cloud-review-post: a pushed report opens the issue with its title and body, then deletes the branch', () => {
  const { out, calls, body } = runPoller({ hitAfter: 2, report: 'Release review v1.1.0: X\n\nbody\n' });
  const create = calls.findIndex((c) => c.startsWith('gh [issue] [create]'));
  const del = calls.indexOf('git push -q origin --delete claude/review-v1.1.0');
  assert.strictEqual(calls.filter((c) => c.startsWith('git ls-remote')).length, 2, calls.join('\n'));
  assert.ok(calls.includes('git fetch -q origin +claude/review-v1.1.0:refs/clodex-review/v1.1.0'), calls.join('\n'));
  assert.ok(calls.includes('git show refs/clodex-review/v1.1.0:.review/v1.1.0.md'), calls.join('\n'));
  assert.ok(calls.indexOf('git update-ref -d refs/clodex-review/v1.1.0') > create, calls.join('\n'));
  assert.match(calls[create], /^gh \[issue\] \[create\] \[-R\] \[avirtual\/clodex\] \[-t\] \[Release review v1\.1\.0: X\] \[-F\] \[/);
  assert.strictEqual(body, 'body\n');
  assert.ok(!calls.some((c) => c.startsWith('gh [issue] [close]')), calls.join('\n'));
  assert.ok(del > create, calls.join('\n'));
  assert.match(out, /https:\/\/github\.com\/avirtual\/clodex\/issues\/7/);
});

test('cloud-review-post: a CLEAN report is opened and then closed', () => {
  const { calls } = runPoller({ hitAfter: 1, report: 'Release review v1.1.0: CLEAN\n\nchecked everything\n' });
  const create = calls.findIndex((c) => c.startsWith('gh [issue] [create] [-R] [avirtual/clodex] [-t] [Release review v1.1.0: CLEAN]'));
  const close = calls.indexOf('gh [issue] [close] [https://github.com/avirtual/clodex/issues/7] [-R] [avirtual/clodex]');
  assert.ok(create >= 0, calls.join('\n'));
  assert.ok(close > create, calls.join('\n'));
});

test('cloud-review-post: CLODEX_REVIEW_PREFIX sets the title prefix and a CLEAN pre-release report is closed', () => {
  const { calls } = runPoller({
    hitAfter: 1, report: 'Pre-release review staging-deadbeef: CLEAN\n\nchecked everything\n',
    env: { CLODEX_REVIEW_PREFIX: 'Pre-release review staging-deadbeef:' },
  });
  const create = calls.findIndex((c) => c.startsWith('gh [issue] [create] [-R] [avirtual/clodex] [-t] [Pre-release review staging-deadbeef: CLEAN]'));
  const close = calls.indexOf('gh [issue] [close] [https://github.com/avirtual/clodex/issues/7] [-R] [avirtual/clodex]');
  assert.ok(create >= 0, calls.join('\n'));
  assert.ok(close > create, calls.join('\n'));
});

test('cloud-review-post: no report before the timeout opens NO REPORT and deletes nothing', () => {
  const { calls, body } = runPoller({ hitAfter: 0, env: { CLODEX_REVIEW_TIMEOUT_S: '0' } });
  assert.strictEqual(calls.filter((c) => c.startsWith('git ls-remote origin refs/heads/claude/review-v1.1.0')).length, 1, calls.join('\n'));
  assert.ok(calls.some((c) => c.startsWith('gh [issue] [create] [-R] [avirtual/clodex] [-t] [Release review v1.1.0: NO REPORT]')), calls.join('\n'));
  assert.match(body, /cloud-review-v1\.1\.0\.log/);
  assert.ok(!calls.some((c) => c.startsWith('git push')), calls.join('\n'));
  assert.ok(!calls.some((c) => c.startsWith('gh [issue] [close]')), calls.join('\n'));
});

test('cloud-review-post: a first line without the tag prefix opens UNPARSED REPORT with the whole file', () => {
  const report = 'Findings for the release\n\nsomething\n';
  const { calls, body } = runPoller({ hitAfter: 1, report });
  assert.ok(calls.some((c) => c.startsWith('gh [issue] [create] [-R] [avirtual/clodex] [-t] [Release review v1.1.0: UNPARSED REPORT]')), calls.join('\n'));
  assert.strictEqual(body, report);
});

test('cloud-review-post: gh issue create failing twice is retried and the third try opens the issue', () => {
  const { status, calls } = runPoller({ hitAfter: 1, report: 'Release review v1.1.0: X\n\nbody\n', ghFails: 2 });
  assert.strictEqual(status, 0, calls.join('\n'));
  assert.strictEqual(calls.filter((c) => c.startsWith('gh [issue] [create]')).length, 3, calls.join('\n'));
  assert.strictEqual(calls.filter((c) => c === 'git push -q origin --delete claude/review-v1.1.0').length, 1, calls.join('\n'));
});

test('cloud-review-post: gh issue create failing every try logs an ERROR, keeps the branch and exits 1', () => {
  const { status, calls, log } = runPoller({ hitAfter: 1, report: 'Release review v1.1.0: X\n\nbody\n', ghFails: 99 });
  assert.strictEqual(status, 1, calls.join('\n'));
  assert.strictEqual(calls.filter((c) => c.startsWith('gh [issue] [create]')).length, 3, calls.join('\n'));
  assert.match(log, /^cloud-review: ERROR issue create failed: gh boom 1\ngh boom 2\ngh boom 3$/m);
  assert.ok(!calls.some((c) => c.startsWith('git push')), calls.join('\n'));
});

test('cloud-review-post: a failed fetch is retried on the next poll and the report issue is opened, not UNPARSED', () => {
  const { out, calls, body } = runPoller({ hitAfter: 1, fetchFails: 1, report: 'Release review v1.1.0: X\n\nbody\n' });
  assert.strictEqual(calls.filter((c) => c.startsWith('git fetch')).length, 2, calls.join('\n'));
  assert.ok(calls.some((c) => c.startsWith('gh [issue] [create] [-R] [avirtual/clodex] [-t] [Release review v1.1.0: X]')), calls.join('\n'));
  assert.ok(!calls.some((c) => c.includes('UNPARSED')), calls.join('\n'));
  assert.strictEqual(body, 'body\n');
  assert.ok(out.split('\n').includes('cloud-review-post: fetch of claude/review-v1.1.0 failed, retrying'), out);
});

test('cloud-review-post: a fetch still failing at the timeout opens UNPARSED REPORT and keeps the branch', () => {
  const { out, calls } = runPoller({ hitAfter: 1, fetchFails: 99, env: { CLODEX_REVIEW_TIMEOUT_S: '0' } });
  assert.ok(calls.some((c) => c.startsWith('gh [issue] [create] [-R] [avirtual/clodex] [-t] [Release review v1.1.0: UNPARSED REPORT]')), calls.join('\n'));
  assert.ok(out.split('\n').includes('cloud-review-post: fetch of claude/review-v1.1.0 failed, retrying'), out);
  assert.ok(!calls.some((c) => c.startsWith('git push')), calls.join('\n'));
});

test('cloud-review-post: a hung git ls-remote is cut off at CALL_S and the timeout still opens NO REPORT', () => {
  const { calls } = runPoller({ hitAfter: 0, lsSleep: 30, env: { CLODEX_REVIEW_CALL_S: '1', CLODEX_REVIEW_TIMEOUT_S: '2' } });
  assert.ok(calls.some((c) => c.startsWith('git ls-remote')), calls.join('\n'));
  assert.ok(calls.some((c) => c.startsWith('gh [issue] [create] [-R] [avirtual/clodex] [-t] [Release review v1.1.0: NO REPORT]')), calls.join('\n'));
});

test('cloud-review-post: a report committed before the poller started is ignored once and the next fresh one is filed', () => {
  const { out, calls, body } = runPoller({ hitAfter: 1, ctAges: [1000, 1000, 0] });
  assert.strictEqual(calls.filter((c) => c.startsWith('git log -1 --format=%ct refs/clodex-review/v1.1.0')).length, 3, calls.join('\n'));
  assert.strictEqual(calls.filter((c) => c.startsWith('gh [issue] [create]')).length, 1, calls.join('\n'));
  assert.strictEqual(body, 'hit 3\n');
  assert.strictEqual(out.split('\n').filter((l) => l === 'cloud-review-post: ignoring stale report abc123').length, 1, out);
});

test('cloud-review-post: a branch holding only a stale report at the timeout opens NO REPORT naming that sha', () => {
  const { calls, body } = runPoller({ hitAfter: 1, ctAges: [1000], env: { CLODEX_REVIEW_TIMEOUT_S: '0' } });
  assert.ok(calls.some((c) => c.startsWith('gh [issue] [create] [-R] [avirtual/clodex] [-t] [Release review v1.1.0: NO REPORT]')), calls.join('\n'));
  assert.match(body, /held only report abc123, committed before this run/);
  assert.doesNotMatch(body, /^No branch/);
});

test('cloud-review-post: without the test flag POLL_S=0 is clamped, so a 2s window sees at most one ls-remote', () => {
  const { calls } = runPoller({ hitAfter: 0, windowMs: 2000, env: { CLODEX_REVIEW_TEST: '' } });
  const ls = calls.filter((c) => c.startsWith('git ls-remote origin refs/heads/claude/review-v1.1.0'));
  assert.ok(ls.length >= 1, 'ENTER: the poller reached ls-remote\n' + calls.join('\n'));
  assert.ok(ls.length <= 1, `${ls.length} ls-remote calls in 2s`);
});

test('cloud-review-post: CALL_S=0 is clamped to 60 rather than reaching alarm as 0', () => {
  const { calls } = runPoller({ hitAfter: 1, report: 'Release review v1.1.0: X\n\nbody\n', perlRec: true, env: { CLODEX_REVIEW_CALL_S: '0' } });
  const alarms = calls.filter((c) => c.startsWith('perl alarm '));
  assert.ok(alarms.length > 0, 'ENTER: bounded ran through the recording perl\n' + calls.join('\n'));
  assert.deepStrictEqual([...new Set(alarms)], ['perl alarm 60'], calls.join('\n'));
});

test('cloud-review-post: a 300-character verdict line becomes a title of at most 256 characters', () => {
  const line = 'Release review v1.1.0: ' + 'X'.repeat(277);
  assert.strictEqual(line.length, 300);
  const { calls } = runPoller({ hitAfter: 1, report: `${line}\n\nbody\n` });
  const create = calls.find((c) => c.startsWith('gh [issue] [create]'));
  const title = (create.match(/ \[-t\] \[([^\]]*)\] /) || [])[1];
  assert.ok(title.startsWith('Release review v1.1.0: XXX'), create);
  assert.ok(title.length <= 256, `title is ${title.length} chars`);
});

test('cloud-review: a missing claude binary exits 0 with a warn line', () => {
  withStub('touch "$CLOUD_REVIEW_REC"', ({ dir, rec }) => {
    const out = runScript(['v1.0.0', 'v1.1.0'], {
      CLODEX_CLAUDE_BIN: path.join(dir, 'no-such-claude'), CLOUD_REVIEW_REC: rec, HOME: dir,
    });
    assert.match(out, /^warn: /m);
    assert.doesNotMatch(out, /launched for/);
    assert.ok(!fs.existsSync(rec), 'no claude ran');
  });
});

test('cloud-review: a missing script(1) exits 0 with a warn line and launches nothing', () => {
  withStub('touch "$CLOUD_REVIEW_REC"', ({ dir, stub, rec }) => {
    const bin = path.join(dir, 'bin');
    fs.mkdirSync(bin);
    for (const tool of ['env', 'nohup', 'mkdir', 'cat', 'dirname']) {
      fs.symlinkSync(execFileSync('bash', ['-c', `command -v ${tool}`], { encoding: 'utf-8' }).trim(), path.join(bin, tool));
    }
    const out = execFileSync('/bin/bash', [SCRIPT, 'v1.0.0', 'v1.1.0'], {
      encoding: 'utf-8',
      env: { PATH: bin, HOME: dir, CLODEX_CLAUDE_BIN: stub, CLOUD_REVIEW_REC: rec },
    });
    assert.match(out, /^warn: .*script\(1\)/m);
    assert.doesNotMatch(out, /launched for/);
    assert.ok(!fs.existsSync(rec), 'the stub never ran');
    assert.ok(!fs.existsSync(path.join(dir, '.clodex')), 'nothing was launched, so no log dir');
  });
});

test('cloud-review: an empty previous tag exits 0 with a warn line', () => {
  withStub('', ({ dir, stub }) => {
    const out = runScript(['', 'v1.1.0'], { CLODEX_CLAUDE_BIN: stub, HOME: dir });
    assert.match(out, /^warn: /m);
    assert.doesNotMatch(out, /launched for/);
  });
});

test('cloud-review: the launch returns before a slow claude finishes', () => {
  withStub('sleep 5', ({ dir, stub }) => {
    const t0 = Date.now();
    const out = runScript(['v1.0.0', 'v1.1.0'], { CLODEX_CLAUDE_BIN: stub, HOME: dir });
    const elapsed = Date.now() - t0;
    const pid = Number((out.match(/\(pid (\d+)\)/) || [])[1]);
    if (pid) { try { process.kill(pid); } catch {} }
    killPoller(out);
    assert.ok(pid > 0, out);
    assert.ok(elapsed < 2000, `the launch blocked for ${elapsed}ms`);
  });
});
