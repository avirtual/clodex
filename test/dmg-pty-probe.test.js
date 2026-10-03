'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { mkTmpRoot } = require('./lib/tmp-roots');

const PROBE = path.join(__dirname, '..', 'scripts', 'dmg-pty-probe.sh');

const HDIUTIL = `#!/bin/bash
echo "$*" >> "$PROBE_TEST_LOG"
case "$1" in
  attach)
    mnt=""
    while [ $# -gt 0 ]; do
      if [ "$1" = "-mountpoint" ]; then mnt="$2"; shift; fi
      shift
    done
    mkdir -p "$mnt"
    if [ -z "\${PROBE_TEST_NO_APP:-}" ]; then cp -R "$PROBE_TEST_APP_SRC" "$mnt/"; fi
    ;;
esac
exit 0
`;

const FAKE_EXE = `#!/bin/sh
printf 'exe ELECTRON_RUN_AS_NODE=%s CLODEX_PROBE_APP=%s ARGS=%s\\n' "$ELECTRON_RUN_AS_NODE" "$CLODEX_PROBE_APP" "$*" >> "$PROBE_TEST_LOG"
echo "stub-stderr-marker" >&2
exit "$PROBE_TEST_RC"
`;

function setup() {
  const root = mkTmpRoot('clodex-dmgprobe-');
  const bin = path.join(root, 'bin');
  const tmp = path.join(root, 'tmp');
  const appSrc = path.join(root, 'fixture', 'Fake.app');
  fs.mkdirSync(bin, { recursive: true });
  fs.mkdirSync(tmp, { recursive: true });
  fs.mkdirSync(path.join(appSrc, 'Contents', 'MacOS'), { recursive: true });
  fs.writeFileSync(path.join(bin, 'hdiutil'), HDIUTIL, { mode: 0o755 });
  fs.writeFileSync(path.join(appSrc, 'Contents', 'MacOS', 'Fake'), FAKE_EXE, { mode: 0o755 });
  const dmg = path.join(root, 'Fake-1.0.0.dmg');
  fs.writeFileSync(dmg, '');
  return { root, bin, tmp, appSrc, dmg, log: path.join(root, 'calls.log') };
}

function runProbe(rc, { noApp = false } = {}) {
  const s = setup();
  const env = {
    ...process.env,
    PATH: `${s.bin}:${process.env.PATH}`,
    TMPDIR: s.tmp,
    PROBE_TEST_LOG: s.log,
    PROBE_TEST_APP_SRC: s.appSrc,
    PROBE_TEST_RC: String(rc),
  };
  if (noApp) env.PROBE_TEST_NO_APP = '1';
  const r = spawnSync('bash', [PROBE, s.dmg], { env, encoding: 'utf-8' });
  const calls = fs.existsSync(s.log) ? fs.readFileSync(s.log, 'utf-8') : '';
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, calls, leftovers: fs.readdirSync(s.tmp) };
}

function assertCleanedUp(r) {
  assert.match(r.calls, /^detach .*\/mnt -force$/m, 'the trap must detach the mount on every exit path');
  assert.deepStrictEqual(r.leftovers, [], 'the trap must remove the scratch dir');
}

test('dmg probe: a spawning app passes with one success line, run read-only from the mount', () => {
  const r = runProbe(0);
  assert.strictEqual(r.status, 0, r.stdout + r.stderr);
  assert.strictEqual(r.stdout, 'dmg probe: Fake spawned /bin/sh\n');
  assert.ok(!r.stdout.includes('stub-stderr-marker'), 'the probe stderr is shown only on failure');
  assert.match(r.calls, /^attach -nobrowse -readonly -noverify -mountpoint \S+\/clodex-dmgprobe-\w+\/mnt \S+Fake-1\.0\.0\.dmg$/m);
  const exe = r.calls.split('\n').find((l) => l.startsWith('exe '));
  assert.ok(exe, 'the bundle executable was never run');
  assert.match(exe, /ELECTRON_RUN_AS_NODE=1 /);
  assert.match(exe, /CLODEX_PROBE_APP=\S+\/mnt\/Fake\.app /);
  assert.match(exe, /ARGS=-e .*process\.env\.CLODEX_PROBE_APP \+ '\/Contents\/Resources\/app\.asar\/node_modules\/node-pty'/);
  assertCleanedUp(r);
});

test('dmg probe: node-pty is required through app.asar, never app.asar.unpacked', () => {
  const src = fs.readFileSync(PROBE, 'utf-8');
  assert.ok(src.includes('/Contents/Resources/app.asar/node_modules/node-pty'));
  assert.ok(!src.includes('app.asar.unpacked'),
    'node-pty rewrites app.asar to app.asar.unpacked itself; requiring the unpacked path yields .unpacked.unpacked and a false posix_spawnp failure');
});

for (const [rc, cls] of [[1, 'spawn failed'], [2, 'timed out'], [3, 'load failed']]) {
  test(`dmg probe: app exit ${rc} fails as "${cls}", shows the probe stderr, and detaches`, () => {
    const r = runProbe(rc);
    assert.strictEqual(r.status, 1, r.stdout + r.stderr);
    assert.ok(r.stdout.startsWith(`dmg probe: ${cls}`), r.stdout);
    assert.ok(r.stdout.includes('stub-stderr-marker'), 'a failure must show what the probe printed');
    assertCleanedUp(r);
  });
}

test('dmg probe: a DMG with no .app fails and still detaches', () => {
  const r = runProbe(0, { noApp: true });
  assert.strictEqual(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /expected exactly one \.app .* found 0/);
  assert.ok(!r.calls.includes('exe '), 'nothing may run when there is no app');
  assertCleanedUp(r);
});
