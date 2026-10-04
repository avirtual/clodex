'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { mkTmpRoot } = require('./lib/tmp-roots');

const PROBE = path.join(__dirname, '..', 'scripts', 'dmg-child-probe.sh');

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
printf 'exe ELECTRON_RUN_AS_NODE=%s ARGS=%s\\n' "\${ELECTRON_RUN_AS_NODE-unset}" "$*" >> "$PROBE_TEST_LOG"
script="\${1#--clodex-electron-child=}"
cp "$script" "$PROBE_TEST_LOG.probe.js"
echo "stub-stderr-marker" >&2
printf '%s\\n' "$PROBE_TEST_STDOUT"
exit "$PROBE_TEST_RC"
`;

function runProbe(rc, stdout, { noApp = false } = {}) {
  const root = mkTmpRoot('clodex-dmgchild-');
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
  const log = path.join(root, 'calls.log');
  const env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    TMPDIR: tmp,
    ELECTRON_RUN_AS_NODE: '1',
    PROBE_TEST_LOG: log,
    PROBE_TEST_APP_SRC: appSrc,
    PROBE_TEST_RC: String(rc),
    PROBE_TEST_STDOUT: stdout,
  };
  if (noApp) env.PROBE_TEST_NO_APP = '1';
  const r = spawnSync('bash', [PROBE, dmg], { env, encoding: 'utf-8' });
  const calls = fs.existsSync(log) ? fs.readFileSync(log, 'utf-8') : '';
  const probeJs = fs.existsSync(`${log}.probe.js`) ? fs.readFileSync(`${log}.probe.js`, 'utf-8') : '';
  return { status: r.status, stdout: r.stdout, calls, probeJs, leftovers: fs.readdirSync(tmp) };
}

function assertCleanedUp(r) {
  assert.match(r.calls, /^detach .*\/mnt -force$/m, 'the trap must detach the mount on every exit path');
  assert.deepStrictEqual(r.leftovers, [], 'the trap must remove the scratch dir');
}

test('dmg child probe: CXB-OK function passes, run read-only with ELECTRON_RUN_AS_NODE unset and the flag alone', () => {
  const r = runProbe(0, 'CXB-OK function');
  assert.strictEqual(r.status, 0, r.stdout);
  assert.strictEqual(r.stdout, 'dmg child probe: Fake booted the child script\n');
  assert.match(r.calls, /^attach -nobrowse -readonly -noverify -mountpoint \S+\/clodex-dmgchild-\w+\/mnt \S+Fake-1\.0\.0\.dmg$/m);
  assert.match(r.calls, /^exe ELECTRON_RUN_AS_NODE=unset ARGS=--clodex-electron-child=\S+\/clodex-dmgchild-\w+\/probe\.js$/m);
  assert.strictEqual(r.probeJs,
    "exports.run = (e) => { process.stdout.write('CXB-OK ' + typeof e.app.whenReady + '\\n'); process.exit(0); };\n");
  assertCleanedUp(r);
});

for (const [rc, out, cls] of [[0, 'nothing', 'no CXB-OK line'], [0, 'CXB-OK undefined', 'no CXB-OK line'], [2, 'CXB-OK function', 'Fake exited 2']]) {
  test(`dmg child probe: exit ${rc} with "${out}" fails as "${cls}", shows the output, and detaches`, () => {
    const r = runProbe(rc, out);
    assert.strictEqual(r.status, 1, r.stdout);
    assert.ok(r.stdout.startsWith(`dmg child probe: ${cls}`), r.stdout);
    assert.ok(r.stdout.includes('stub-stderr-marker'), 'a failure must show what the child printed');
    assertCleanedUp(r);
  });
}

test('dmg child probe: a DMG with no .app fails and still detaches', () => {
  const r = runProbe(0, 'CXB-OK function', { noApp: true });
  assert.strictEqual(r.status, 1, r.stdout);
  assert.match(r.stdout, /expected exactly one \.app .* found 0/);
  assert.ok(!r.calls.includes('exe '), 'nothing may run when there is no app');
  assertCleanedUp(r);
});
