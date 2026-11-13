'use strict';

// Runtime-split smoke test: import + exercise every wire/ module under the
// ELECTRON runtime (BoringSSL, Electron's node:* surface), not system node.
//
// Why this exists (commit 3297835): wire/warmth.js hashed with blake2b512 —
// present in node's OpenSSL, ABSENT in Electron's BoringSSL. All 119 tests
// and the 35k-pair corpus gate run under node and stayed green while the
// live app killed the observer on every request ("Digest method not
// supported"). node --test CANNOT see BoringSSL gaps by definition; the only
// honest check is importing wire/ under the actual Electron binary.
//
// Run:  node scripts/electron-smoke.js        (re-execs itself under Electron)
// Exits non-zero on the first failure. Wired into scripts/release.sh preflight.

const path = require('path');
const ROOT = path.join(__dirname, '..');

if (!process.versions.electron) {
  // Re-exec under the Electron binary as a plain node process.
  const { spawnSync } = require('child_process');
  const electron = require(path.join(ROOT, 'node_modules', 'electron'));
  const r = spawnSync(electron, [__filename], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    stdio: 'inherit',
  });
  process.exit(r.status === null ? 1 : r.status);
}

const failures = [];
const check = (name, fn) => {
  try { fn(); console.log(`ok   ${name}`); }
  catch (e) { failures.push(name); console.error(`FAIL ${name}: ${e.message}`); }
};

console.log(`electron ${process.versions.electron} / node ${process.versions.node}`);

// 1. Every wire/ module must import (catches missing node:* builtins too).
const fs = require('fs');
for (const f of fs.readdirSync(path.join(ROOT, 'wire')).filter((f) => f.endsWith('.js'))) {
  check(`require wire/${f}`, () => require(path.join(ROOT, 'wire', f)));
}
check('require wire-telemetry.js', () => require(path.join(ROOT, 'wire-telemetry.js')));
check('require wire-intents.js', () => require(path.join(ROOT, 'wire-intents.js')));

// 2. The crypto surface wire/ actually uses must produce digests here.
check('crypto digests used by wire/', () => {
  const crypto = require('crypto');
  const src = fs.readdirSync(path.join(ROOT, 'wire'))
    .filter((f) => f.endsWith('.js'))
    .map((f) => fs.readFileSync(path.join(ROOT, 'wire', f), 'utf8'))
    .join('\n');
  const algs = [...src.matchAll(/createHash\(\s*['"]([^'"]+)['"]/g)].map((m) => m[1]);
  if (!algs.length) throw new Error('no createHash calls found — pattern drift?');
  for (const alg of new Set(algs)) crypto.createHash(alg).update('x').digest();
});

// 3. Warmth store round-trip: the exact path that died live on 2026-07-02
//    (hash + node:sqlite together, in-memory db).
check('warmth record/query round-trip', () => {
  const { WarmthStore } = require(path.join(ROOT, 'wire', 'warmth.js'));
  const w = new WarmthStore({ path: ':memory:' });
  const req = {
    model: 'smoke', system: [{ type: 'text', text: 's', cache_control: { type: 'ephemeral' } }],
    tools: [{ name: 'Read' }], messages: [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'yo' }],
  };
  const rec = w.record(req, { cache_creation_input_tokens: 2048, cache_read_input_tokens: 0 }, 'smoke-sess');
  if (!rec || !rec.hash) throw new Error('no stamp record');
  const q = w.query({ session: 'smoke-sess' });
  if (!q.found || !q.warm) throw new Error(`bad query verdict: ${JSON.stringify(q)}`);
  w.close();
});

function writeAsar(ofs, file, name, body) {
  const json = Buffer.from(JSON.stringify({ files: { [name]: { size: body.length, offset: '0' } } }));
  const padded = Buffer.alloc(Math.ceil(json.length / 4) * 4);
  json.copy(padded);
  const head = Buffer.alloc(16);
  head.writeUInt32LE(4, 0);
  head.writeUInt32LE(8 + padded.length, 4);
  head.writeUInt32LE(4 + padded.length, 8);
  head.writeUInt32LE(json.length, 12);
  ofs.writeFileSync(file, Buffer.concat([head, padded, Buffer.from(body)]));
}

async function sealAsar(adapter) {
  const ofs = require('original-fs');
  const root = fs.mkdtempSync(path.join(require('os').tmpdir(), 'clodex-smoke-asar-'));
  try {
    const app = path.join(root, 'job', 'tree', 'node_modules', 'electron');
    fs.mkdirSync(app, { recursive: true });
    writeAsar(ofs, path.join(app, 'default_app.asar'), 'default_app.js', 'x');
    if (!fs.lstatSync(path.join(app, 'default_app.asar')).isDirectory()) throw new Error('fs no longer opens .asar as a directory; this check proves nothing');
    await adapter(root).seal(path.join(root, 'job'), path.join(root, 'entry'), ['node_modules']);
    const sealed = ofs.lstatSync(path.join(root, 'entry', 'node_modules', 'electron', 'default_app.asar'));
    if (!sealed.isFile() || (sealed.mode & 0o222)) throw new Error(`archive not sealed read-only: mode ${sealed.mode.toString(8)}`);
  } finally {
    require('child_process').spawnSync('chmod', ['-R', 'u+w', root]);
    ofs.rmSync(root, { recursive: true, force: true });
  }
}

(async () => {
  const { noneIsolation } = require(path.join(ROOT, 'suite-runner.js'));
  const { boxIsolation } = require(path.join(ROOT, 'suite-box.js'));
  const adapters = {
    'suite-runner': () => noneIsolation({ user: 'smoke' }),
    'suite-box': (root) => boxIsolation({ image: `sha256:${'0'.repeat(64)}`, work: root, stateDir: root }),
  };
  for (const [name, adapter] of Object.entries(adapters)) {
    try { await sealAsar(adapter); console.log(`ok   ${name} seals deps holding an .asar`); }
    catch (e) { failures.push(`${name} asar seal`); console.error(`FAIL ${name} asar seal: ${e.message}`); }
  }
  if (failures.length) {
    console.error(`\nelectron-smoke: ${failures.length} failure(s): ${failures.join(', ')}`);
    process.exit(1);
  }
  console.log('\nelectron-smoke: all green');
})();
