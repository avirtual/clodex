'use strict';
// engine-sandbox-seam.test.js — T57, amended by t903. The `enableSandbox` seam
// decides whether the manager is constructed at all. Its question is "is there a
// docker to reach", and since t903 the headless host answers it with
// `runningInSandboxBox(process.env)` rather than a flat false:
//   - enableSandbox:false  → getSandboxManager() returns null (the IPC
//     `getSandboxManager() ? .list() : []` path then yields [] → showPlacementSelector([])
//     is false → the "Run in" row hides; renderer half is pinned in placement.test.js).
//   - seam omitted (the Electron path) → the manager is created exactly as today.
//
// createEngine constructs electron-free against a temp userData and starts
// background timers that keep the loop alive; force-exit once assertions flush
// (node --test isolates each file's process).

const { test, after } = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('node:events');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { createEngine } = require('../engine');
const { createSandboxManager, runningInSandboxBox, SANDBOX_BOX_ENV } = require('../sandbox');
const { mkTmpRoot } = require('./lib/tmp-roots');

function mkEngine(seams) {
  const tmp = mkTmpRoot('clx-eng-sbx-');
  // registryDir or the engine seeds the operator's live ~/.clodex (t359).
  return createEngine({
    userDataPath: tmp,
    seams: { noSeed: true, registryDir: path.join(tmp, 'clodex-home'), ...seams },
    log: { info() {}, warn() {}, error() {} },
  });
}

test('enableSandbox:false → getSandboxManager() is null and the IPC list-path yields []', () => {
  const eng = mkEngine({ enableSandbox: false });
  const mgr = eng.getSandboxManager();
  assert.strictEqual(mgr, null, 'headless opt-out → no sandbox manager');
  // The exact shape ipc-handlers uses for sandbox:listBoxes.
  assert.deepStrictEqual(mgr ? mgr.list() : [], [], 'the list-path yields no boxes → placement row hides');
  // getSandbox is null-tolerant too (no throw on a null manager).
  assert.strictEqual(eng.getSandbox('sandbox'), null, 'getSandbox returns null, not a throw');
});

test('seam omitted (Electron path) → the sandbox manager is created as today', () => {
  const eng = mkEngine({});
  assert.notStrictEqual(eng.getSandboxManager(), null, 'default-on: manager exists exactly as before');
});

test('a headless host builds the manager unless it identifies as in-box', () => {
  const rows = [
    { name: 'in-box: the image bakes CLODEX_IN_SANDBOX=1', env: { CLODEX_IN_SANDBOX: '1' }, manager: false },
    { name: 'on-host: no marker at all', env: {}, manager: true },
    { name: 'on-host: a headless box on a laptop, web port and all', env: { CLODEX_WEB_PORT: '8080', CLODEX_REMOTE_ENABLE: '1' }, manager: true },
    { name: 'on-host: the marker present but not the in-box value', env: { CLODEX_IN_SANDBOX: '0' }, manager: true },
  ];
  assert.deepStrictEqual(
    [...new Set(rows.map((r) => r.manager))].sort(),
    [false, true],
    'ENTER: the table must hold both verdicts — against a discriminator stuck on one answer '
    + 'a single-verdict table is satisfied by every row and asserts nothing',
  );

  for (const row of rows) {
    const eng = mkEngine({ enableSandbox: !runningInSandboxBox(row.env) });
    assert.strictEqual(
      eng.getSandboxManager() !== null,
      row.manager,
      `${row.name}: expected getSandboxManager() ${row.manager ? 'non-null' : 'null'}`,
    );
  }
});

test('headless-main passes the discriminator, not a literal', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'headless-main.js'), 'utf8');
  assert.match(
    src,
    /enableSandbox:\s*!runningInSandboxBox\(process\.env\)/,
    'headless-main must compute enableSandbox from the in-box discriminator — the seam pin above sees '
    + 'only what the engine does with a value, never which value headless-main hands it, so a regression '
    + 'to the literal is invisible there. Textual because headless-main boots a real host (pid lock, '
    + 'session restore) and cannot be require()d, like the webInfo pin in engine-web-info-seam.test.js',
  );
  assert.doesNotMatch(src, /enableSandbox:\s*false/, 'the flat opt-out is what t903 removed');
  assert.match(
    src,
    /require\('\.\/sandbox'\)/,
    'and it must import the discriminator rather than re-deriving the env name',
  );
});

test('the web image bakes the in-box marker into its ENV', () => {
  const dockerfile = fs.readFileSync(path.join(__dirname, '..', 'docker', 'web', 'Dockerfile'), 'utf8');
  assert.match(dockerfile, new RegExp(`ENV[\\s\\S]*${SANDBOX_BOX_ENV}=1`),
    'the IMAGE must self-identify as a box, not the generated compose: a box brought up by hand from '
    + 'docker/web/compose.yaml is still in a box, and sandbox.js generateCompose is not on that path');
  assert.ok(runningInSandboxBox({ [SANDBOX_BOX_ENV]: '1' }), 'and the value it bakes is the one the discriminator accepts');
});

function captureSandboxDetect(getSandboxManager) {
  const handlers = new Map();
  const capture = {
    handle: (ch, fn) => handlers.set(ch, fn),
    on: (ch, fn) => handlers.set(ch, fn),
    getSandboxManager,
  };
  const stub = () => () => {};
  const deps = new Proxy(capture, {
    get(target, prop) { return prop in target ? target[prop] : stub(); },
    has(target, prop) { return prop in target; },
  });
  require('../ipc-handlers').registerIpcHandlers(deps);
  assert.ok(handlers.size > 100, `registration produced only ${handlers.size} channels — the capture is broken`);
  const detect = handlers.get('sandbox:detect');
  assert.strictEqual(typeof detect, 'function', 'ENTER: sandbox:detect registered, or every assertion below is vacuous');
  return detect;
}

test('sandbox:detect with a manager runs `docker info`; with none it short-circuits', async () => {
  const argvs = [];
  const spawn = (cmd, args) => {
    argvs.push([cmd, ...(args || [])]);
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {};
    process.nextTick(() => { child.stdout.emit('data', '29.7.2\n'); child.emit('exit', 0); });
    return child;
  };
  const mgr = createSandboxManager({
    spawn,
    registryDir: mkTmpRoot('clx-sbx-detect-'),
    getUserDataPath: () => mkTmpRoot('clx-sbx-ud-'),
    getUiSettings: () => ({ get: () => ({ boxes: [] }), set: () => {} }),
    log: { info() {}, warn() {}, error() {} },
  });

  const withMgr = await captureSandboxDetect(() => mgr)();
  assert.strictEqual(withMgr.present, true, 'the probe answered: docker is present');
  assert.strictEqual(withMgr.running, true, 'and its daemon reported a server version');
  assert.ok(
    argvs.some(([cmd, sub]) => cmd === 'docker' && sub === 'info'),
    'detect must REACH the docker probe, which is the whole defect: ipc-handlers returned '
    + `'sandbox manager unavailable' before any probe ran, and the dialog rendered that as `
    + `"Couldn't check Docker". Asserted on the spawn rather than the reply shape, because a `
    + `manager answering from thin air satisfies the shape. Spawns seen: ${JSON.stringify(argvs)}`,
  );

  const withoutMgr = await captureSandboxDetect(() => null)();
  assert.deepStrictEqual(withoutMgr, { ok: false, error: 'sandbox manager unavailable' },
    'no manager is still that pre-probe refusal — the contrast, without which the probe assertion '
    + 'above reads as "detect always answers present" rather than as a consequence of the manager');
});

function captureSandboxSelf(base) {
  const handlers = new Map();
  const capture = { ...base, handle: (ch, fn) => handlers.set(ch, fn), on: (ch, fn) => handlers.set(ch, fn) };
  const stub = () => () => {};
  const deps = new Proxy(capture, {
    get(target, prop) { return prop in target ? target[prop] : stub(); },
    has(target, prop) { return prop in target; },
  });
  require('../ipc-handlers').registerIpcHandlers(deps);
  const self = handlers.get('sandbox:self');
  assert.strictEqual(typeof self, 'function', 'ENTER: sandbox:self registered');
  return self;
}

function withBoxEnv(value, fn) {
  const had = Object.prototype.hasOwnProperty.call(process.env, SANDBOX_BOX_ENV);
  const prev = process.env[SANDBOX_BOX_ENV];
  const hadLabel = Object.prototype.hasOwnProperty.call(process.env, 'CLODEX_BOX_LABEL');
  const prevLabel = process.env.CLODEX_BOX_LABEL;
  delete process.env.CLODEX_BOX_LABEL;
  if (value === undefined) delete process.env[SANDBOX_BOX_ENV]; else process.env[SANDBOX_BOX_ENV] = value;
  try { return fn(); } finally {
    if (had) process.env[SANDBOX_BOX_ENV] = prev; else delete process.env[SANDBOX_BOX_ENV];
    if (hadLabel) process.env.CLODEX_BOX_LABEL = prevLabel;
  }
}

test('sandbox:self answers the box label inside a box and nothing outside one', () => {
  const self = captureSandboxSelf({ SELF_LABEL: 'team-clodex-ios' });
  assert.deepStrictEqual(withBoxEnv('1', () => self()), { inBox: true, label: 'team-clodex-ios', libraryWritable: true });
  assert.deepStrictEqual(withBoxEnv(undefined, () => self()), { inBox: false, label: null, libraryWritable: true });
});

test('the engine hands SELF_LABEL to the hosts, so sandbox:self can name the box', () => {
  const eng = mkEngine({ enableSandbox: false });
  assert.strictEqual(typeof eng.SELF_LABEL, 'string');
  assert.ok(eng.SELF_LABEL.length > 0, 'a non-empty label');
  const self = captureSandboxSelf({ ...eng });
  assert.deepStrictEqual(withBoxEnv('1', () => self()), { inBox: true, label: eng.SELF_LABEL, libraryWritable: true });
});

test('sandbox:self reports a read-only library templates dir inside a box, and writable outside one', { skip: !!(process.getuid && process.getuid() === 0) && 'root ignores 0555' }, () => {
  const tmp = mkTmpRoot('clx-eng-sbx-');
  const registryDir = path.join(tmp, 'clodex-home');
  const eng = createEngine({
    userDataPath: tmp,
    seams: { noSeed: true, registryDir, enableSandbox: false },
    log: { info() {}, warn() {}, error() {} },
  });
  const dir = path.join(registryDir, 'library', 'templates');
  fs.mkdirSync(dir, { recursive: true });
  const self = captureSandboxSelf({ ...eng, ...eng.stores });
  assert.strictEqual(withBoxEnv('1', () => self()).libraryWritable, true, 'ENTER: a writable dir reads writable');
  fs.chmodSync(dir, 0o555);
  try {
    assert.strictEqual(withBoxEnv('1', () => self()).libraryWritable, false, 'a :ro mount reads read-only inside the box');
    assert.strictEqual(withBoxEnv(undefined, () => self()).libraryWritable, true, 'outside a box the library is never reported read-only');
  } finally { fs.chmodSync(dir, 0o755); }
  fs.rmSync(dir, { recursive: true, force: true });
  assert.strictEqual(withBoxEnv('1', () => self()).libraryWritable, true, 'a missing dir counts writable');
});

// createEngine's background timers keep the loop alive; exit once results flush.
after(() => { setImmediate(() => process.exit(0)); });
