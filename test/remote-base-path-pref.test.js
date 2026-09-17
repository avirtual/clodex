'use strict';
// Run: node --test test/remote-base-path-pref.test.js
//
// t912 — the operator-facing half of the mount prefix: the IPC crossing, the
// env-lock view that stops the field from lying, and the Preferences wiring.
//
// The IPC object is an explicit WHITELIST: a key not named there arrives
// `undefined`, indistinguishable from a real value at every consumer — the
// shape that once hid the peer-shell grant on a serving box. The env lock
// exists because CLODEX_REMOTE_BASE_PATH overrides the stored value and is
// never written back, so without it the field shows the env value, accepts an
// edit, saves it, and changes nothing about what is served — with no feedback.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { registerIpcHandlers, envLockedSettings } = require('../ipc-handlers');
const { envLockFor, envLockView, applyEnvLock, patchUnlessEnvLocked } = require('../renderer/lib/env-lock');
const { resolveRemoteBasePathSetting } = require('../remote');
const { resolveRemotePort } = require('../service-ports');

const rendererSrc = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'renderer.js'), 'utf8');
const htmlSrc = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'index.html'), 'utf8');

function settingsGet(store) {
  const handlers = new Map();
  registerIpcHandlers({
    handle: (ch, fn) => handlers.set(ch, fn),
    on: (ch, fn) => handlers.set(ch, fn),
    uiSettings: { get: () => store, set: () => store },
    agentDefaults: { getDefaultDeny: () => [], getDefaultSkillDeny: () => [], getDefaultBuiltinDeny: () => [] },
    syncRemoteServer: () => {},
    manager: { _broadcast: () => {} },
    log: { info() {}, error() {} },
  });
  return handlers.get('settings:get');
}

// ── the IPC crossing ────────────────────────────────────────────────────────

test('settings:get carries the mount prefix to the renderer', () => {
  const get = settingsGet({ remoteBasePath: '/c', peers: [] });
  assert.strictEqual(typeof get, 'function', 'ENTER: settings:get is registered');
  const s = get({});
  assert.strictEqual(s.remoteEnabled, undefined,
    'ENTER: this stub store has no remoteEnabled, so the assertion below is not a spread');
  assert.strictEqual(s.remoteBasePath, '/c',
    'the field has a value to paint — omitted, it arrives undefined and the field reads as blank on a box serving /c');
});

test('settings:get reports an unset prefix as the empty string, not as absent', () => {
  const s = settingsGet({ remoteBasePath: '', peers: [] })({});
  assert.strictEqual('remoteBasePath' in s, true, 'the key is projected in BOTH states');
  assert.strictEqual(s.remoteBasePath, '');
});

// ── which settings the environment has taken over ───────────────────────────

test('envLockedSettings names the variable for each setting the environment overrides', () => {
  assert.deepStrictEqual(envLockedSettings({}), {}, 'nothing set → nothing locked');
  assert.deepStrictEqual(envLockedSettings({ CLODEX_REMOTE_BASE_PATH: '/i/phone' }),
    { remoteBasePath: 'CLODEX_REMOTE_BASE_PATH' },
    'the VARIABLE NAME, not a bare boolean — the note has to tell the operator what to unset');
  assert.deepStrictEqual(envLockedSettings({ CLODEX_REMOTE_PORT: '7901' }),
    { remotePort: 'CLODEX_REMOTE_PORT' },
    'the same mechanism covers the port, which has the identical trap');
  assert.deepStrictEqual(
    envLockedSettings({ CLODEX_REMOTE_PORT: '7901', CLODEX_REMOTE_BASE_PATH: '/c' }),
    { remotePort: 'CLODEX_REMOTE_PORT', remoteBasePath: 'CLODEX_REMOTE_BASE_PATH' },
    'and both at once');
});

test('a blank or whitespace variable is not a lock', () => {
  // `FOO= clodex` exports an empty string, which the resolver treats as unset —
  // so a lock here would freeze a field the environment is NOT overriding.
  for (const raw of ['', '   ', '\t']) {
    assert.deepStrictEqual(envLockedSettings({ CLODEX_REMOTE_BASE_PATH: raw }), {},
      `${JSON.stringify(raw)} → not a lock`);
  }
});

test('a variable the resolver REFUSES is not a lock — and the resolver keeps the stored value', () => {
  const env = { CLODEX_REMOTE_BASE_PATH: '/my path' };
  assert.deepStrictEqual(envLockedSettings(env), {},
    'a space fails BASE_PATH_SEGMENT_RE, so the env value never reaches the wire');
  assert.equal(resolveRemoteBasePathSetting({ remoteBasePath: '/c' }, env),
    '/c', 'and what is SERVED is the stored prefix — which is what the unlocked field can now edit');

  const penv = { CLODEX_REMOTE_PORT: '70000' };
  assert.deepStrictEqual(envLockedSettings(penv), {},
    '70000 is outside 1–65535, so the port resolver refuses it too');
  assert.equal(resolveRemotePort({ remotePort: 7911 }, penv), 7911,
    'and the stored port is what binds');

  assert.deepStrictEqual(envLockedSettings({ CLODEX_REMOTE_PORT: 'abc' }), {},
    'a non-numeric port is refused for the same reason');
});

test('a variable the resolver ACCEPTS still locks, and still wins — the anti-degenerate half', () => {
  const env = { CLODEX_REMOTE_BASE_PATH: '/i/phone' };
  assert.deepStrictEqual(envLockedSettings(env), { remoteBasePath: 'CLODEX_REMOTE_BASE_PATH' });
  assert.equal(resolveRemoteBasePathSetting({ remoteBasePath: '/c' }, env), '/i/phone',
    'the env value is served, which is exactly what the note claims');

  const penv = { CLODEX_REMOTE_PORT: '7901' };
  assert.deepStrictEqual(envLockedSettings(penv), { remotePort: 'CLODEX_REMOTE_PORT' });
  assert.equal(resolveRemotePort({ remotePort: 7911 }, penv), 7901);
});

test('settings:get projects the lock map alongside the value', () => {
  const s = settingsGet({ remoteBasePath: '/c', peers: [] })({});
  assert.ok(s.envLockedSettings && typeof s.envLockedSettings === 'object',
    'always an object, so the renderer needs no null check');
});

// ── the view the field is painted from ──────────────────────────────────────

test('envLockView reports the lock and names the variable in its note', () => {
  const view = envLockView({ remoteBasePath: 'CLODEX_REMOTE_BASE_PATH' }, 'remoteBasePath');
  assert.equal(view.locked, true);
  assert.equal(view.envName, 'CLODEX_REMOTE_BASE_PATH');
  assert.match(view.note, /CLODEX_REMOTE_BASE_PATH/,
    'the note names the variable — "this field is ignored" without the reason is not actionable');
});

test('envLockView is unlocked and silent for a setting the environment leaves alone', () => {
  for (const locked of [undefined, null, {}, 'nope', { remotePort: 'CLODEX_REMOTE_PORT' }]) {
    const view = envLockView(locked, 'remoteBasePath');
    assert.equal(view.locked, false, `${JSON.stringify(locked)} → unlocked`);
    assert.equal(view.note, '', 'and no note, so an unlocked field has no leftover line under it');
  }
  assert.equal(envLockFor({ remoteBasePath: '  ' }, 'remoteBasePath'), null,
    'a blank variable name is not a lock either');
});

test('applyEnvLock makes the input read-only and prints the reason beside it', () => {
  const classes = new Set();
  const el = { value: '/c', readOnly: false, classList: { toggle: (c, on) => (on ? classes.add(c) : classes.delete(c)) } };
  const stateEl = { textContent: 'stale' };

  applyEnvLock(el, stateEl, envLockView({ remoteBasePath: 'CLODEX_REMOTE_BASE_PATH' }, 'remoteBasePath'));
  assert.equal(el.readOnly, true, 'the field cannot be edited into a lie');
  assert.equal(el.value, '/c', 'and still SHOWS the served prefix — read-only, not blanked');
  assert.ok(classes.has('env-locked'), 'and is marked so the styling can grey it');
  assert.match(stateEl.textContent, /CLODEX_REMOTE_BASE_PATH/);

  applyEnvLock(el, stateEl, envLockView({}, 'remoteBasePath'));
  assert.equal(el.readOnly, false, 'and the lock lifts');
  assert.equal(classes.has('env-locked'), false);
  assert.equal(stateEl.textContent, '', 'with no leftover note');
});

test('the applies-sentence is hidden under a lock and shown when the lock lifts', () => {
  assert.match(htmlSrc, /<span id="prefs-remote-base-path-applies">Applies as soon as you save/,
    'the sentence is its own element, so it can be hidden without the rest of the hint');
  assert.match(rendererSrc, /const prefsRemoteBasePathApplies = document\.getElementById\('prefs-remote-base-path-applies'\)/,
    'looked up by the id the markup carries — a typo here is a silent null and the sentence never hides');
  assert.match(rendererSrc, /applyEnvLock\(prefsRemoteBasePath, prefsRemoteBasePathState,[\s\S]{0,120}?prefsRemoteBasePathApplies\)/,
    'and the renderer hands it to the same call that paints the lock');

  const applies = { hidden: false };
  const el = { value: '/c', readOnly: false, classList: { toggle: () => {} } };
  applyEnvLock(el, { textContent: '' }, envLockView({ remoteBasePath: 'CLODEX_REMOTE_BASE_PATH' }, 'remoteBasePath'), applies);
  assert.equal(applies.hidden, true, 'locked → the save promise is not made');
  applyEnvLock(el, { textContent: '' }, envLockView({}, 'remoteBasePath'), applies);
  assert.equal(applies.hidden, false, 'unlocked → it comes back, because saving works again');
});

// ── the save side: the contract that must survive the lock ──────────────────

test('a locked setting is OMITTED from the save, so the stored value round-trips', () => {
  // stores.js never writes the env value back, which is what makes removing the
  // variable later return to what Settings holds. A UI that saved the displayed
  // env value would bake it in permanently and break that contract.
  assert.deepStrictEqual(
    patchUnlessEnvLocked({ remoteBasePath: 'CLODEX_REMOTE_BASE_PATH' }, 'remoteBasePath', '/typed'),
    {},
    'the key is absent from the patch — and the store treats an absent key as "keep what is stored"');
  assert.deepStrictEqual(
    patchUnlessEnvLocked({}, 'remoteBasePath', '/typed'),
    { remoteBasePath: '/typed' },
    'unlocked, the typed value is sent through unvalidated — the STORE owns that rule, not a second copy here');
});

// ── the Preferences wiring, pinned as source ────────────────────────────────
//
// renderer.js has no harness (it reaches for `document` at load), so these pin
// the crossings a move would break silently.

test('the mount path field exists in the phone group', () => {
  assert.match(htmlSrc, /<input[^>]*id="prefs-remote-base-path"/,
    'a text input the renderer can fill');
  assert.match(htmlSrc, /id="prefs-remote-base-path-state"/,
    'and a place for the env-lock note to land');
  const field = htmlSrc.indexOf('id="prefs-remote-base-path"');
  const group = htmlSrc.indexOf('data-group="phone"');
  const nextGroup = htmlSrc.indexOf('<details class="prefs-group"', group + 1);
  assert.ok(group > 0 && field > group && field < nextGroup,
    'inside Phone access, beside the switch it qualifies');
});

test('the value is written as a DOM PROPERTY, never interpolated into HTML', () => {
  // contextIsolation:false + nodeIntegration:true, and the prefix is
  // operator-supplied text that can arrive from a settings file — so an
  // innerHTML or a concatenated value="..." is script execution with the
  // renderer's full node privileges.
  assert.match(rendererSrc, /prefsRemoteBasePath\.value = s\.remoteBasePath == null \? '' : String\(s\.remoteBasePath\)/,
    'assigned through .value');
  for (const m of rendererSrc.matchAll(/^.*prefsRemoteBasePath.*$/gm)) {
    assert.doesNotMatch(m[0], /innerHTML|insertAdjacentHTML|value="/,
      `no HTML-interpolated position: ${m[0].trim()}`);
  }
});

test('the field rides the setSettings batch and defers its lock to the shared helper', () => {
  assert.match(rendererSrc, /patchUnlessEnvLocked\(prefsEnvLocked, 'remoteBasePath', prefsRemoteBasePath\.value\)/,
    'saved through the omit-when-locked helper, not with a second copy of the rule');
  const save = rendererSrc.indexOf("patchUnlessEnvLocked(prefsEnvLocked, 'remoteBasePath'");
  const batch = rendererSrc.lastIndexOf('setSettings({', save);
  const close = rendererSrc.indexOf('});', batch);
  assert.ok(batch > 0 && save < close,
    'inside the setSettings call — a save of its own would race the batch');
});

test('the renderer does not re-validate the prefix', () => {
  // The store already handles every input shape (blank clears to '', junk keeps
  // the current value), and a second copy of that rule is a second place for it
  // to drift.
  for (const m of rendererSrc.matchAll(/^.*prefsRemoteBasePath.*$/gm)) {
    assert.doesNotMatch(m[0], /coerceRemoteBasePath|\.replace\(|test\(/,
      `no renderer-side coercion: ${m[0].trim()}`);
  }
});

test('t959 the rejected-prefix warning names the variable, never its value', () => {
  const { resolveRemoteBasePath, REMOTE_BASE_PATH_ENV } = require('../remote');
  const secret = `https://boxy.example/c?token=t959-${Date.now()}`;
  const warnings = [];
  const got = resolveRemoteBasePath(secret, (m) => warnings.push(m), '/c');
  assert.strictEqual(got, '/c', 'ENTER: the value WAS rejected, so the warn path ran');
  assert.strictEqual(warnings.length, 1, 'ENTER: it warned exactly once');
  assert.ok(!warnings[0].includes(secret), 'the raw value must not reach the log line');
  assert.ok(!warnings[0].includes('t959-'), 'nor any fragment of it');
  assert.ok(warnings[0].includes(REMOTE_BASE_PATH_ENV),
    'the variable name stays — that is what makes the warning actionable');
  assert.ok(warnings[0].includes('/c'),
    'and so does the fallback actually being served, so the operator knows what they got');
});
