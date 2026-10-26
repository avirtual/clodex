const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const { mkTmpRoot } = require('./lib/tmp-roots');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'cloud-review.sh');

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
    env: { ...process.env, CLODEX_RELEASE_NO_REVIEW: '', ...env },
  });
}

const RECORD = 'if [ -t 1 ]; then T=yes; else T=no; fi; { printf \'%s\\n\' "$@"; printf \'%s\\n\' "--ENV--" "TTY=$T"; env; } > "$CLOUD_REVIEW_REC"';

const FIFO_BOUND_MS = 10000;

function launchAndRecord(extraEnv) {
  return withStub(RECORD, ({ dir, stub, rec }) => {
    execFileSync('mkfifo', [rec]);
    const out = runScript(['v1.0.0', 'v1.1.0'], {
      CLODEX_CLAUDE_BIN: stub, CLOUD_REVIEW_REC: rec, HOME: dir, ...extraEnv,
    });
    let recorded;
    try {
      recorded = execFileSync('cat', [rec], { encoding: 'utf-8', timeout: FIFO_BOUND_MS });
    } catch (err) {
      const pids = (spawnSync('pgrep', ['-f', stub], { encoding: 'utf-8' }).stdout || '').split('\n').filter(Boolean);
      for (const pid of pids) { try { process.kill(Number(pid), 'SIGKILL'); } catch {} }
      throw err;
    }
    const [argv, env] = recorded.split('--ENV--\n');
    return { out, argv, env, logExists: fs.existsSync(path.join(dir, '.clodex', 'logs', 'cloud-review-v1.1.0.log')) };
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

test('cloud-review: the brief reports a clean review as a CLEAN issue, tries GitHub tools, then gh under a timeout, and never probes gh auth', () => {
  const brief = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'cloud-review-brief.md'), 'utf-8');
  assert.ok(brief.includes('"Release review {{NEW}}: CLEAN"'), brief);
  assert.ok(!brief.includes('gh auth status'), brief);
  assert.ok(brief.includes("this session's GitHub tools first"), brief);
  assert.ok(brief.includes('timeout 60 gh'), brief);
  assert.ok(!brief.includes('do not run gh'), brief);
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
    assert.ok(pid > 0, out);
    assert.ok(elapsed < 2000, `the launch blocked for ${elapsed}ms`);
  });
});
