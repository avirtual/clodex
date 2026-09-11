'use strict';
// Run: node --test test/account-select.test.js
//
// t812 — the Account select on both session dialogs. The env TEXT is the single
// source of truth: the picker reads it and writes it, and nothing else is sent
// on create. So the whole surface is this projection, and the two claims that
// matter are round-trip fidelity (a selection change must not disturb any other
// line, or the operator silently loses an env var by touching a dropdown) and
// that an UNREGISTERED dir stays readable as `custom` rather than being
// clobbered back to default.

const { test } = require('node:test');
const assert = require('node:assert');

const {
  accountFromEnv, envWithAccount, accountOptions, loginSeat, abbrevHome,
} = require('../renderer/lib/account-select');

const HOME = '/home/u';
const ACCOUNTS = [
  { label: 'default', email: null, configDir: `${HOME}/.claude`, plan: 'unknown' },
  { label: 'sub-2', email: 'two@x.com', configDir: '/minted/sub-2', plan: 'max' },
  { label: 'sub-3', email: null, configDir: '/minted/sub-3', plan: 'pro' },
];

// --- accountFromEnv ----------------------------------------------------------

test('accountFromEnv: absent var → default, registered dir → its label, foreign dir → custom', () => {
  assert.strictEqual(accountFromEnv('', ACCOUNTS), 'default');
  assert.strictEqual(accountFromEnv('MY_KEY=x\n# a comment', ACCOUNTS), 'default');
  assert.strictEqual(accountFromEnv('CLAUDE_CONFIG_DIR=/minted/sub-2', ACCOUNTS), 'sub-2');
  assert.strictEqual(accountFromEnv('CLAUDE_CONFIG_DIR=/somewhere/else', ACCOUNTS), 'custom');
  // A trailing slash is the same dir — the operator types it, the registry does not.
  assert.strictEqual(accountFromEnv('CLAUDE_CONFIG_DIR=/minted/sub-2/', ACCOUNTS), 'sub-2');
});

test('accountFromEnv: the LAST assignment wins, matching parseEnvLines and a shell', () => {
  const text = 'CLAUDE_CONFIG_DIR=/minted/sub-2\nCLAUDE_CONFIG_DIR=/minted/sub-3';
  assert.strictEqual(accountFromEnv(text, ACCOUNTS), 'sub-3');
});

// --- envWithAccount ----------------------------------------------------------

test('envWithAccount: setting an account on an empty box yields exactly the one line', () => {
  assert.strictEqual(envWithAccount('', 'sub-2', ACCOUNTS), 'CLAUDE_CONFIG_DIR=/minted/sub-2');
});

test('envWithAccount: other lines keep their content AND their order', () => {
  const before = 'A=1\nCLAUDE_CONFIG_DIR=/minted/sub-2\nB=2\n# note\nC=3';
  assert.strictEqual(
    envWithAccount(before, 'sub-3', ACCOUNTS),
    'A=1\nCLAUDE_CONFIG_DIR=/minted/sub-3\nB=2\n# note\nC=3',
  );
  // And the round trip is clean: reading it back names the account just set.
  assert.strictEqual(accountFromEnv(envWithAccount(before, 'sub-3', ACCOUNTS), ACCOUNTS), 'sub-3');
});

test('envWithAccount: a fresh set appends without eating a trailing newline', () => {
  assert.strictEqual(envWithAccount('A=1\nB=2', 'sub-2', ACCOUNTS), 'A=1\nB=2\nCLAUDE_CONFIG_DIR=/minted/sub-2');
  // A box the operator left with a trailing newline keeps it: the new line goes
  // BEFORE the empty tail, not after it, or every selection change grows the box.
  assert.strictEqual(envWithAccount('A=1\n', 'sub-2', ACCOUNTS), 'A=1\nCLAUDE_CONFIG_DIR=/minted/sub-2\n');
});

test('envWithAccount: default REMOVES the line rather than writing a dir', () => {
  assert.strictEqual(envWithAccount('A=1\nCLAUDE_CONFIG_DIR=/minted/sub-2\nB=2', 'default', ACCOUNTS), 'A=1\nB=2');
  assert.strictEqual(envWithAccount('CLAUDE_CONFIG_DIR=/minted/sub-2', 'default', ACCOUNTS), '');
  // The default account IS the absence of the var (accounts.js's rule), so
  // writing `CLAUDE_CONFIG_DIR=~/.claude` instead would be a second encoding of
  // the same state that labelFor and the sweep's skip both have to special-case.
  assert.strictEqual(envWithAccount('A=1', 'default', ACCOUNTS), 'A=1', 'already absent — untouched');
});

test('envWithAccount: custom is a NO-OP, so selecting it cannot clobber a hand-typed dir', () => {
  const text = 'CLAUDE_CONFIG_DIR=/somewhere/else\nA=1';
  assert.strictEqual(envWithAccount(text, 'custom', ACCOUNTS), text);
});

test('envWithAccount: an unknown label leaves the text alone rather than writing an empty dir', () => {
  const text = 'A=1\nCLAUDE_CONFIG_DIR=/minted/sub-2';
  assert.strictEqual(envWithAccount(text, 'sub-99', ACCOUNTS), text);
});

test('envWithAccount: a COMMENTED-OUT assignment is not the selection and is not consumed', () => {
  // parseEnvLines ignores it, so accountFromEnv reads `default` — a projection
  // that stripped it anyway would delete a line the operator parked on purpose.
  const text = '#CLAUDE_CONFIG_DIR=/minted/sub-2\nA=1';
  assert.strictEqual(accountFromEnv(text, ACCOUNTS), 'default');
  assert.strictEqual(envWithAccount(text, 'sub-3', ACCOUNTS), '#CLAUDE_CONFIG_DIR=/minted/sub-2\nA=1\nCLAUDE_CONFIG_DIR=/minted/sub-3');
});

// --- accountOptions ----------------------------------------------------------

test('accountOptions: default first, then the registered rows, with email and plan', () => {
  assert.deepStrictEqual(accountOptions(ACCOUNTS, 'sub-2', HOME), [
    { value: 'default', text: 'default — ~/.claude', selected: false },
    { value: 'sub-2', text: 'sub-2 — two@x.com (max)', selected: true },
    { value: 'sub-3', text: 'sub-3 — /minted/sub-3 (pro)', selected: false },
  ]);
});

test('accountOptions: `custom` appears ONLY when that is the current selection', () => {
  const plain = accountOptions(ACCOUNTS, 'default', HOME);
  assert.deepStrictEqual(plain.map((o) => o.value), ['default', 'sub-2', 'sub-3']);

  const custom = accountOptions(ACCOUNTS, { label: 'custom', configDir: `${HOME}/hand-typed` }, HOME);
  assert.deepStrictEqual(custom.map((o) => o.value), ['default', 'sub-2', 'sub-3', 'custom']);
  assert.deepStrictEqual(custom[3], { value: 'custom', text: 'custom — ~/hand-typed', selected: true });
  // Exactly one option is selected, or the browser silently picks the first and
  // the box would read `default` over a hand-typed dir.
  assert.strictEqual(custom.filter((o) => o.selected).length, 1);
});

test('accountOptions: a host with NO accounts still offers default alone', () => {
  assert.deepStrictEqual(accountOptions([], 'default', HOME), [
    { value: 'default', text: 'default — ~/.claude', selected: true },
  ]);
});

// --- loginSeat ---------------------------------------------------------------

test('loginSeat: default gets NO env — the absence of the var is the default account', () => {
  assert.deepStrictEqual(
    loginSeat('default', { label: 'default', configDir: `${HOME}/.claude` }, { home: HOME }),
    { name: 'login-default', type: 'bash', cwd: `${HOME}/.claude`, env: null },
  );
});

test('loginSeat: a registered account sets exactly CLAUDE_CONFIG_DIR', () => {
  assert.deepStrictEqual(
    loginSeat('sub-2', ACCOUNTS[1], { home: HOME }),
    { name: 'login-sub-2', type: 'bash', cwd: '/minted/sub-2', env: { CLAUDE_CONFIG_DIR: '/minted/sub-2' } },
  );
});

test('loginSeat: a taken name is bumped through the supplied bumper', () => {
  const { bumpDefaultName } = require('../renderer/lib/name-suggest');
  const params = loginSeat('sub-2', ACCOUNTS[1], {
    home: HOME, reserved: ['login-sub-2'], bump: bumpDefaultName,
  });
  assert.strictEqual(params.name, 'login-sub-2-2');
});

test('loginSeat: a registered account with no configDir returns null rather than a default seat', () => {
  // Silently falling through to no env would open a shell on the DEFAULT
  // account and have the operator log the wrong subscription in.
  assert.strictEqual(loginSeat('sub-9', { label: 'sub-9', configDir: '' }, { home: HOME }), null);
});

test('abbrevHome: the home prefix folds, a foreign path does not, and a near-miss is not shortened', () => {
  assert.strictEqual(abbrevHome(`${HOME}/.claude`, HOME), '~/.claude');
  assert.strictEqual(abbrevHome(HOME, HOME), '~');
  assert.strictEqual(abbrevHome('/minted/sub-2', HOME), '/minted/sub-2');
  assert.strictEqual(abbrevHome('/home/user2/x', HOME), '/home/user2/x', 'a prefix match is not a path match');
});
