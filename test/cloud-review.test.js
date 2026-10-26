const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
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

const RECORD = '{ printf \'%s\\n\' "$@"; printf \'%s\\n\' "--ENV--"; env; } > "$CLOUD_REVIEW_REC"';

function launchAndRecord(extraEnv) {
  return withStub(RECORD, ({ dir, stub, rec }) => {
    execFileSync('mkfifo', [rec]);
    const out = runScript(['v1.0.0', 'v1.1.0'], {
      CLODEX_CLAUDE_BIN: stub, CLOUD_REVIEW_REC: rec, HOME: dir, ...extraEnv,
    });
    const recorded = fs.readFileSync(rec, 'utf-8');
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
  assert.match(argv, /\n--model\nopus\n/);
  assert.ok(logExists, 'output goes to ~/.clodex/logs/cloud-review-<newTag>.log');
});

test('cloud-review: CLAUDE_CONFIG_DIR from the parent never reaches claude', () => {
  const { env } = launchAndRecord({ CLAUDE_CONFIG_DIR: '/seat/account/dir', CLODEX_CANARY: 'still-here' });
  assert.match(env, /^CLODEX_CANARY=still-here$/m);
  assert.doesNotMatch(env, /^CLAUDE_CONFIG_DIR=/m);
});

test('cloud-review: CLODEX_RELEASE_NO_REVIEW=1 skips without invoking claude', () => {
  withStub('touch "$CLOUD_REVIEW_REC"', ({ dir, stub, rec }) => {
    const out = runScript(['v1.0.0', 'v1.1.0'], {
      CLODEX_CLAUDE_BIN: stub, CLOUD_REVIEW_REC: rec, HOME: dir, CLODEX_RELEASE_NO_REVIEW: '1',
    });
    assert.match(out, /skipped/);
    assert.doesNotMatch(out, /launched/);
    assert.ok(!fs.existsSync(path.join(dir, '.clodex')), 'no log dir is created on a skip');
  });
});

test('cloud-review: a missing claude binary exits 0 with a warn line', () => {
  withStub('', ({ dir }) => {
    const out = runScript(['v1.0.0', 'v1.1.0'], {
      CLODEX_CLAUDE_BIN: path.join(dir, 'no-such-claude'), HOME: dir,
    });
    assert.match(out, /^warn: /m);
  });
});

test('cloud-review: an empty previous tag exits 0 with a warn line', () => {
  withStub('', ({ dir, stub }) => {
    const out = runScript(['', 'v1.1.0'], { CLODEX_CLAUDE_BIN: stub, HOME: dir });
    assert.match(out, /^warn: /m);
    assert.doesNotMatch(out, /launched/);
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
