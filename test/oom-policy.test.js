'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

function serviceSection(unitText) {
  const lines = unitText.split('\n');
  const start = lines.findIndex((l) => l.trim() === '[Service]');
  assert.ok(start >= 0, 'ENTER: the unit has a [Service] section');
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => /^\[.+\]$/.test(l.trim()));
  return end < 0 ? rest : rest.slice(0, end);
}

function assertOomPolicyBesideRestart(unitText, label) {
  const svc = serviceSection(unitText).map((l) => l.trim());
  const restartAt = svc.indexOf('Restart=always');
  assert.ok(restartAt >= 0, `ENTER: ${label} sets Restart=always in [Service]`);
  assert.strictEqual(svc[restartAt + 1], 'OOMPolicy=continue',
    `${label}: OOMPolicy=continue must sit in [Service] right after Restart=always`);
  assert.strictEqual(svc.filter((l) => l.startsWith('OOMPolicy=')).length, 1,
    `${label}: exactly one OOMPolicy line`);
}

test('peering/clodex.service keeps the unit running when a child is OOM-killed', () => {
  assertOomPolicyBesideRestart(read('peering/clodex.service'), 'peering/clodex.service');
});

for (const rel of ['peering/clodex-deploy.sh', 'cli/deploy/clodex-deploy.sh']) {
  test(`${rel} installs the shipped unit with only WorkingDirectory rewritten, then reloads`, () => {
    const src = read(rel);
    const installAt = src.indexOf('sed "s#^WorkingDirectory=.*#WorkingDirectory=$SRC_DIR#" "$SRC_DIR/peering/clodex.service" > "$UNIT_DIR/clodex.service"');
    assert.ok(installAt >= 0, `${rel} must install the unit from peering/clodex.service via the WorkingDirectory-only sed`);
    const reloadAt = src.indexOf('systemctl --user daemon-reload', installAt);
    assert.ok(reloadAt > installAt, `${rel} must daemon-reload after rewriting the unit`);
    const installed = read('peering/clodex.service').replace(/^WorkingDirectory=.*$/m, 'WorkingDirectory=/srv/clodex');
    assertOomPolicyBesideRestart(installed, `${rel}'s installed unit`);
  });
}

test('docker/Dockerfile copies the shipped unit with only WorkingDirectory rewritten', () => {
  const src = read('docker/Dockerfile');
  assert.match(src,
    /sed -e 's#\^WorkingDirectory=\.\*#WorkingDirectory=\/home\/clodex\/wb-wrap-ui#' \\\s*\n\s*\/home\/clodex\/wb-wrap-ui\/peering\/clodex\.service \\\s*\n\s*> \/home\/clodex\/\.config\/systemd\/user\/clodex\.service/,
    'docker/Dockerfile must install peering/clodex.service through the single WorkingDirectory sed');
});

test('cli/src/deploy.js embeds cli/deploy/clodex-deploy.sh as the installer', () => {
  const src = read('cli/src/deploy.js');
  assert.match(src, /path\.join\(__dirname, '\.\.', 'deploy', 'clodex-deploy\.sh'\)/,
    'cli/src/deploy.js must ship the catalog installer that rewrites the unit');
});

test('peering/README.md unit recipe carries OOMPolicy=continue', () => {
  const src = read('peering/README.md');
  const blocks = [...src.matchAll(/```ini\n([\s\S]*?)```/g)].map((m) => m[1])
    .filter((b) => b.includes('ExecStart=/usr/bin/node headless-main.js'));
  assert.strictEqual(blocks.length, 1, 'ENTER: one headless unit recipe in peering/README.md');
  assertOomPolicyBesideRestart(blocks[0], 'peering/README.md headless unit recipe');
});

test('peering/README.md documents the drop-in for a hand-installed unit', () => {
  const src = read('peering/README.md');
  assert.ok(src.includes("printf '[Service]\\nOOMPolicy=continue\\n' > ~/.config/systemd/user/clodex.service.d/oom.conf"),
    'peering/README.md must give the OOMPolicy drop-in one-liner');
});
