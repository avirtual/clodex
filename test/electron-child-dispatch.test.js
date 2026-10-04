'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { mkTmpRoot } = require('./lib/tmp-roots');

const REPO = path.join(__dirname, '..');

function electronBinary() {
  try {
    const bin = require('electron');
    return typeof bin === 'string' && fs.existsSync(bin) ? bin : null;
  } catch { return null; }
}

const BIN = electronBinary();
const SKIP = !BIN ? 'dev Electron binary missing'
  : (process.platform === 'linux' && !process.env.DISPLAY) ? 'Linux without DISPLAY' : false;

function runElectron(args) {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  return new Promise((resolve, reject) => {
    const child = spawn(BIN, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

test('a valid child flag boots the binary straight into the script with electron handed in', { skip: SKIP }, async () => {
  const dir = fs.realpathSync(mkTmpRoot('clodex-electron-dispatch-'));
  const fixture = path.join(dir, 'fixture.js');
  fs.writeFileSync(fixture, `exports.run = (e, ctx) => {
  process.stdout.write(JSON.stringify({ whenReady: typeof e.app.whenReady, hasFlag: ctx.argv.includes('--clodex-electron-child=' + __filename) }) + '\\n');
  process.exit(0);
};
`);
  const r = await runElectron([REPO, `--clodex-electron-child=${fixture}`]);
  assert.strictEqual(r.code, 0, r.stderr);
  const line = r.stdout.split('\n').find((l) => l.startsWith('{'));
  assert.deepStrictEqual(JSON.parse(line), { whenReady: 'function', hasFlag: true });
});

test('a malformed child flag exits 2 with one stderr line and never boots Clodex', { skip: SKIP }, async () => {
  const r = await runElectron([REPO, '--clodex-electron-child=relative/child.js']);
  assert.strictEqual(r.code, 2);
  assert.match(r.stderr, /clodex electron child: --clodex-electron-child= needs an absolute path: relative\/child\.js\n/);
});
