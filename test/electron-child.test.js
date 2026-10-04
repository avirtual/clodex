'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { CHILD_FLAG, childScriptFromArgv, childSpawnSpec } = require('../electron-child');

test('CHILD_FLAG is the literal argv prefix', () => {
  assert.strictEqual(CHILD_FLAG, '--clodex-electron-child=');
});

test('childScriptFromArgv: each argv yields its literal result', () => {
  const rows = [
    [['/x/Electron', '/repo'], null],
    [['/x/Electron', '/repo', '--clodex-electron-child=/p/child.js'], { script: '/p/child.js' }],
    [['/x/Clodex', '--clodex-electron-child=/p/child.js', '--port', '9'], { script: '/p/child.js' }],
    [['/x/Electron', '--clodex-electron-child=p/child.js'], { error: '--clodex-electron-child= needs an absolute path: p/child.js' }],
    [['/x/Electron', '--clodex-electron-child=/p/child.mjs'], { error: '--clodex-electron-child= needs a .js file: /p/child.mjs' }],
    [['/x/Electron', '--clodex-electron-child='], { error: '--clodex-electron-child= has an empty value' }],
    [['/x/Electron', '--clodex-electron-child=/a.js', '--clodex-electron-child=/b.js'], { error: '--clodex-electron-child= given 2 times' }],
  ];
  for (const [argv, want] of rows) {
    assert.deepStrictEqual(childScriptFromArgv(argv), want, JSON.stringify(argv));
  }
});

test('childSpawnSpec: packaged passes the flag alone', () => {
  assert.deepStrictEqual(childSpawnSpec({
    execPath: '/Applications/Clodex.app/Contents/MacOS/Clodex', isPackaged: true, appPath: '/ignored',
    script: '/p/child.js', extraArgs: ['--port', '9'], env: { HOME: '/h' },
  }), {
    command: '/Applications/Clodex.app/Contents/MacOS/Clodex',
    args: ['--clodex-electron-child=/p/child.js', '--port', '9'],
    env: { HOME: '/h' },
  });
});

test('childSpawnSpec: dev puts the app path before the flag', () => {
  assert.deepStrictEqual(childSpawnSpec({
    execPath: '/repo/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron', isPackaged: false, appPath: '/repo',
    script: '/p/child.js', extraArgs: [], env: {},
  }), {
    command: '/repo/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron',
    args: ['/repo', '--clodex-electron-child=/p/child.js'],
    env: {},
  });
});

test('childSpawnSpec: env drops ELECTRON_RUN_AS_NODE, keeps the rest, and copies', () => {
  const env = { ELECTRON_RUN_AS_NODE: '1', CLODEX_SENTINEL: 'kept' };
  const spec = childSpawnSpec({ execPath: '/e', isPackaged: true, appPath: '/a', script: '/p/c.js', extraArgs: [], env });
  assert.deepStrictEqual(spec.env, { CLODEX_SENTINEL: 'kept' });
  assert.strictEqual(env.ELECTRON_RUN_AS_NODE, '1');
});

test('host parity: both hosts declare the electronChild seam, and headless declares it null', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
  assert.match(read('main.js'), /^\s+electronChild: \(script, extraArgs\) => childSpawnSpec\(\{/m);
  assert.match(read('headless-main.js'), /^\s+electronChild: null,$/m);
});

test('main.js dispatches the child flag before anything else, including the electron destructure', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  assert.ok(src.startsWith("const electronChild = require('./electron-child').childScriptFromArgv(process.argv);\n"));
  assert.ok(src.indexOf('  return;\n}\n') < src.indexOf("require('electron');"));
});
