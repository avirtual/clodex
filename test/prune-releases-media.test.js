const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { mkTmpRoot } = require('./lib/tmp-roots');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'prune-releases.sh');

const RELEASES = [
  { tag_name: 'v2.0.0', created_at: '2026-02-01T00:00:00Z',
    assets: [{ id: 201, name: 'clodex-2.0.0-arm64.dmg', size: 1048576 }] },
  { tag_name: 'v1.0.0', created_at: '2026-01-01T00:00:00Z',
    assets: [
      { id: 101, name: 'clodex-1.0.0-arm64.dmg', size: 1048576 },
      { id: 102, name: 'demo.mp4', size: 2097152 },
    ] },
];

const GH_SHIM = `#!/usr/bin/env bash
set -euo pipefail
for a in "$@"; do
  if [[ "$a" == "DELETE" ]]; then echo "$*" >> "$GH_DELETE_LOG"; exit 0; fi
done
filter=.
prev=
for a in "$@"; do
  [[ "$prev" == "--jq" ]] && filter="$a"
  prev="$a"
done
jq -r "$filter" "$GH_FIXTURE"
`;

function runPrune(args) {
  const dir = mkTmpRoot('clodex-prune-');
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'gh'), GH_SHIM, { mode: 0o755 });
  const fixture = path.join(dir, 'releases.json');
  fs.writeFileSync(fixture, JSON.stringify(RELEASES));
  const log = path.join(dir, 'delete.log');
  fs.writeFileSync(log, '');
  const out = execFileSync('bash', [SCRIPT, ...args], {
    encoding: 'utf-8',
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, KEEP: '1',
      GH_FIXTURE: fixture, GH_DELETE_LOG: log },
  });
  const deletes = fs.readFileSync(log, 'utf-8');
  fs.rmSync(dir, { recursive: true, force: true });
  return { out, deletes };
}

test('dry-run: an old release dmg is listed for deletion, its mp4 is kept as media', () => {
  const { out, deletes } = runPrune([]);
  const lines = out.split('\n');
  const rows = [
    { name: 'clodex-1.0.0-arm64.dmg', expect: 'would delete  v1.0.0  clodex-1.0.0-arm64.dmg  (1 MB)' },
    { name: 'demo.mp4', expect: 'KEEP    v1.0.0  demo.mp4  (media)' },
  ];
  for (const { name, expect } of rows) {
    const hits = lines.filter((l) => l.includes(name));
    assert.deepStrictEqual(hits, [expect], `${name}: ${out}`);
  }
  assert.ok(lines.includes('dry-run: 1 assets, 0 GB (kept newest 1 releases untouched)'), out);
  assert.strictEqual(deletes, '');
});

test('--delete: DELETE reaches the dmg asset id and never the mp4 asset id', () => {
  const { out, deletes } = runPrune(['--delete']);
  assert.ok(out.includes('DELETED v1.0.0  clodex-1.0.0-arm64.dmg'), out);
  assert.ok(out.includes('KEEP    v1.0.0  demo.mp4  (media)'), out);
  const ids = deletes.trim().split('\n').map((l) => l.match(/releases\/assets\/(\d+)/)[1]);
  assert.deepStrictEqual(ids, ['101']);
  assert.ok(!deletes.includes('assets/102'), deletes);
});
