'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { readVoiceCapability, readVoiceCapabilityCached, SOX_MISSING, NO_DEVICE } = require('../voice-capability');
const { registerIpcHandlers } = require('../ipc-handlers');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'voice-capability.js'), 'utf-8');

function fakeFs({ soxDirs = [], snd = null } = {}) {
  const calls = { existsSync: [], readdirSync: [] };
  return {
    calls,
    existsSync(p) {
      calls.existsSync.push(p);
      return soxDirs.some((d) => p === path.join(d, 'sox') || p === path.join(d, 'sox.exe'));
    },
    readdirSync(p) {
      calls.readdirSync.push(p);
      if (snd === null) { const e = new Error(`ENOENT: ${p}`); e.code = 'ENOENT'; throw e; }
      return snd;
    },
  };
}

const ROWS = [
  {
    name: 'darwin without sox is capable — the CLI records through the system there',
    platform: 'darwin', env: { PATH: '/usr/bin:/bin' }, fs: { soxDirs: [], snd: null },
    expect: { capable: true, cause: null },
  },
  {
    name: 'linux with sox but no /dev/snd names the missing device',
    platform: 'linux', env: { PATH: '/usr/bin:/opt/sox/bin' }, fs: { soxDirs: ['/opt/sox/bin'], snd: null },
    expect: { capable: false, cause: NO_DEVICE },
  },
  {
    name: 'linux with sox and an empty /dev/snd is still not capable — the directory exists in a container with nothing behind it',
    platform: 'linux', env: { PATH: '/usr/bin' }, fs: { soxDirs: ['/usr/bin'], snd: [] },
    expect: { capable: false, cause: NO_DEVICE },
  },
  {
    name: 'linux with sox and a populated /dev/snd is capable',
    platform: 'linux', env: { PATH: '/usr/bin' }, fs: { soxDirs: ['/usr/bin'], snd: ['controlC0', 'pcmC0D0c'] },
    expect: { capable: true, cause: null },
  },
  {
    name: 'linux without sox names SoX, not the device — the first missing piece is the one to fix',
    platform: 'linux', env: { PATH: '/usr/bin:/bin' }, fs: { soxDirs: [], snd: ['controlC0'] },
    expect: { capable: false, cause: SOX_MISSING },
  },
  {
    name: 'win32 without sox names SoX',
    platform: 'win32', env: { PATH: 'C:\\Windows;C:\\Windows\\System32' }, fs: { soxDirs: [], snd: null },
    expect: { capable: false, cause: SOX_MISSING },
  },
  {
    name: 'win32 with sox.exe is capable, and takes no /dev/snd detour',
    platform: 'win32', env: { PATH: 'C:\\Windows;C:\\sox' }, fs: { soxDirs: ['C:\\sox'], snd: null },
    expect: { capable: true, cause: null },
  },
];

for (const row of ROWS) {
  test(`readVoiceCapability: ${row.name}`, () => {
    const f = fakeFs(row.fs);
    const got = readVoiceCapability({ platform: row.platform, env: row.env, fs: f });
    assert.deepStrictEqual(got, row.expect);
    if (row.platform !== 'linux') {
      assert.deepStrictEqual(f.calls.readdirSync, [], 'only linux consults /dev/snd');
    }
  });
}

test('darwin takes no fs lookups at all — no PATH walk, no device read', () => {
  const f = fakeFs({ soxDirs: [], snd: null });
  const got = readVoiceCapability({ platform: 'darwin', env: { PATH: '/usr/bin' }, fs: f });
  assert.deepStrictEqual(got, { capable: true, cause: null });
  assert.deepStrictEqual(f.calls.existsSync, []);
  assert.deepStrictEqual(f.calls.readdirSync, []);
});

test('an empty PATH is not capable rather than a throw', () => {
  const f = fakeFs({ soxDirs: [], snd: ['controlC0'] });
  assert.deepStrictEqual(
    readVoiceCapability({ platform: 'linux', env: {}, fs: f }),
    { capable: false, cause: SOX_MISSING },
  );
});

test('an existsSync that throws reads as absent, not as an error out of the read', () => {
  const f = {
    existsSync() { throw new Error('EACCES'); },
    readdirSync() { return ['controlC0']; },
  };
  assert.deepStrictEqual(
    readVoiceCapability({ platform: 'linux', env: { PATH: '/usr/bin' }, fs: f }),
    { capable: false, cause: SOX_MISSING },
  );
});

test('the read never spawns: the module requires no child_process and names no exec/spawn call', () => {
  assert.ok(!/require\(\s*['"](node:)?child_process['"]\s*\)/.test(SRC),
    'voice-capability.js must not require child_process — the caller polls this every five seconds');
  assert.ok(!/\b(spawnSync|execSync|execFileSync|spawn|execFile)\s*\(/.test(SRC),
    'voice-capability.js must not call any spawn/exec form');
});

test('the cached read answers the same shape as the uncached one and is memoized per process', () => {
  const a = readVoiceCapabilityCached();
  const b = readVoiceCapabilityCached();
  assert.strictEqual(a, b, 'the cached read must return the SAME object — a second walk per poll is what it exists to prevent');
  assert.strictEqual(typeof a.capable, 'boolean');
  assert.ok(a.cause === null || typeof a.cause === 'string');
  assert.strictEqual(readVoiceCapability.cached, readVoiceCapabilityCached,
    'both spellings the spec names must reach the one memo');
});

function fakeVoiceManager() {
  const modes = new Map([['seat-a', 'tap'], ['seat-b', 'off']]);
  return {
    sessions: new Map([['seat-a', {}], ['seat-b', {}]]),
    _focusedSession: 'seat-a',
    voiceModeFor: (name) => modes.get(name),
  };
}

function voiceModeHandler(capability) {
  const handlers = new Map();
  registerIpcHandlers({
    handle: (ch, fn) => handlers.set(ch, fn),
    on: (ch, fn) => handlers.set(ch, fn),
    ...(capability ? { readVoiceCapability: () => capability } : {}),
    manager: fakeVoiceManager(),
    log: { info() {}, error() {} },
  });
  const fn = handlers.get('settings:voiceMode');
  assert.ok(fn, 'settings:voiceMode is registered');
  return fn;
}

test('settings:voiceMode carries the machine’s capability — the whole payload, as the handler builds it', () => {
  const payload = voiceModeHandler({ capable: false, cause: 'SoX is not installed on this machine' })();
  assert.deepStrictEqual(payload, {
    ok: true,
    seat: 'seat-a',
    mode: 'tap',
    effective: 'tap',
    capable: false,
    cause: 'SoX is not installed on this machine',
  });
});

test('settings:voiceMode answers the NAMED seat’s mode over the focused one', () => {
  const payload = voiceModeHandler({ capable: true, cause: null })(null, 'seat-b');
  assert.strictEqual(payload.seat, 'seat-b');
  assert.strictEqual(payload.mode, 'off');
  assert.strictEqual(payload.effective, 'off');
});

test('settings:voiceMode with no capability read wired answers capable, not disabled', () => {
  const payload = voiceModeHandler(null)();
  assert.strictEqual(payload.capable, true);
  assert.strictEqual(payload.cause, null);
});
