'use strict';
// Run: node --test test/prefs-account-row.test.js
//
// t812 — the Preferences ▸ Accounts row. Same shape and same reason as
// test/prefs-env-row.test.js: the builder takes its `document` as a parameter so
// the classes and the per-kind BUTTON SET are assertable without a browser.
//
// The button set is the claim that bites. `default` is the implicit account:
// it has no registry row to remove and it is the SOURCE settings are copied
// FROM, so Re-sync and Remove must not exist on it — accounts.js refuses both
// with an error, and a row that offered them would make the pane's only
// feedback an error string the operator triggered by clicking what we drew.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { accountRowView, buildAccountRow, buildKeyPrompt, keyFieldVisible, modelOptions, MODEL_ALIASES } = require('../renderer/lib/account-row');

const css = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'styles.css'), 'utf8');

function fakeDoc() {
  const make = (tag) => ({
    tag, className: '', textContent: '', title: undefined, type: undefined,
    dataset: {}, children: [],
    appendChild(c) { this.children.push(c); return c; },
  });
  return { createElement: make };
}

const HOME = '/home/u';
const DEFAULT = { label: 'default', email: null, configDir: `${HOME}/.claude`, plan: 'unknown' };
const SUB2 = { label: 'sub-2', email: 'two@x.com', configDir: '/minted/sub-2', plan: 'max' };

const build = (a, seats = 0) => buildAccountRow(fakeDoc(), accountRowView(a, seats, HOME));

// --- the view ----------------------------------------------------------------

test('accountRowView: a registered row, as literals', () => {
  assert.deepStrictEqual(accountRowView(SUB2, 3, HOME), {
    label: 'sub-2',
    isDefault: false,
    email: 'two@x.com',
    plan: 'max',
    dir: '/minted/sub-2',
    seats: '3 seats',
    dirTitle: '/minted/sub-2',
    keyed: false,
    keyChip: '',
    hasKey: false,
  });
});

test('accountRowView: the default row abbreviates ~ and carries no plan', () => {
  assert.deepStrictEqual(accountRowView(DEFAULT, 1, HOME), {
    label: 'default',
    isDefault: true,
    email: '—',
    plan: '',
    dir: '~/.claude',
    seats: '1 seat',
    dirTitle: `${HOME}/.claude`,
    keyed: false,
    keyChip: '',
    hasKey: false,
  });
});

test('accountRowView: the seat count is a count, and zero says so rather than going blank', () => {
  assert.strictEqual(accountRowView(SUB2, 0, HOME).seats, '0 seats');
  assert.strictEqual(accountRowView(SUB2, undefined, HOME).seats, '0 seats');
});

// --- the built row -----------------------------------------------------------

test('a registered row carries the layout CLASS, its label, and NO inline style', () => {
  const { row } = build(SUB2, 2);
  assert.strictEqual(row.className, 'prefs-account-row');
  assert.strictEqual(row.dataset.label, 'sub-2');
  const classes = row.children.map((c) => c.className);
  assert.deepStrictEqual(classes, [
    'prefs-account-name',
    'hint-text prefs-account-email',
    'prefs-account-plan',
    'hint-text prefs-account-dir',
    'hint-text prefs-account-seats',
    'secondary prefs-account-login',
    'secondary prefs-account-move',
    'secondary prefs-account-resync',
    'secondary prefs-account-remove',
  ]);
  // An inline style cannot be overridden by a stylesheet rule, so a builder that
  // set one back would defeat the class it also sets.
  for (const el of [row, ...row.children]) {
    assert.strictEqual(el.style, undefined, `${el.tag} must not carry an inline style`);
  }
});

test('the DEFAULT row has Log in ONLY — no Move, no Re-sync, no Remove', () => {
  const { row, login, move, resync, remove } = build(DEFAULT, 1);
  assert.ok(login, 'every account can be logged into');
  assert.strictEqual(move, null, 'moving seats TO default is Move-on-a-registered-row inverted; not offered here');
  assert.strictEqual(resync, null, 'the default IS the source settings are copied from');
  assert.strictEqual(remove, null, 'the default is implicit — there is no registry row to drop');
  const buttons = row.children.filter((c) => c.tag === 'button');
  assert.deepStrictEqual(buttons.map((b) => b.textContent), ['Log in']);
  // ENTER: a registered row really does get the other three, so the absence
  // above is per-kind and not a builder that draws no buttons at all.
  const reg = build(SUB2, 0);
  assert.deepStrictEqual(
    reg.row.children.filter((c) => c.tag === 'button').map((b) => b.textContent),
    ['Log in', 'Move', 'Re-sync settings', 'Remove'],
  );
});

test('every button is type=button, or a click inside a form would submit it', () => {
  const { row } = build(SUB2, 0);
  for (const b of row.children.filter((c) => c.tag === 'button')) {
    assert.strictEqual(b.type, 'button');
  }
});

test('the full config dir stays in the TITLE while the cell shows the abbreviated one', () => {
  const { row } = build(DEFAULT, 0);
  const dir = row.children.find((c) => c.className === 'hint-text prefs-account-dir');
  assert.strictEqual(dir.textContent, '~/.claude');
  assert.strictEqual(dir.title, `${HOME}/.claude`);
});

test('the row classes the builder sets exist in the stylesheet', () => {
  // The builder above pins that the class is SET; without this the pane could
  // ship every row unstyled and stacked, and both halves would be green.
  for (const cls of ['.prefs-account-row', '.prefs-account-name', '.prefs-account-dir', '.prefs-account-seats']) {
    assert.ok(css.includes(cls), `${cls} is not defined in styles.css`);
  }
  const rowRule = css.slice(css.indexOf('.prefs-account-row {'));
  assert.match(rowRule.slice(0, 120), /display: flex/, 'the row lays out horizontally');
});

// --- the Move model list (t816) ----------------------------------------------
//
// The list the "Move seats on model" select offers. It is built from the
// `model` column on `session:list` rows — the EFFECTIVE model, so a seat whose
// model comes from its settings.json rather than a `--model` flag appears. The
// renderer used to parse `--model` out of each seat's args itself, one
// getSessionArgs IPC per seat, and could not see that case at all.

const rows = (...xs) => xs.map((x) => (typeof x === 'string' ? { type: 'claude', model: x } : x));

test('modelOptions: the four aliases lead, then each live claude seat\'s model', () => {
  assert.deepStrictEqual(
    modelOptions(rows('claude-opus-5', 'claude-fable-5-1[1m]')),
    ['fable', 'opus', 'sonnet', 'haiku', 'claude-opus-5', 'claude-fable-5-1[1m]'],
  );
  assert.deepStrictEqual(modelOptions([]), MODEL_ALIASES);
  assert.deepStrictEqual(modelOptions(null), MODEL_ALIASES);
});

test('modelOptions: deduped — twenty seats on one model are one option', () => {
  assert.deepStrictEqual(
    modelOptions(rows('claude-opus-5', 'claude-opus-5', 'claude-opus-5')),
    [...MODEL_ALIASES, 'claude-opus-5'],
  );
  // A seat literally on the alias adds nothing, rather than a duplicate entry
  // the operator cannot tell apart.
  assert.deepStrictEqual(modelOptions(rows('fable')), MODEL_ALIASES);
});

test('modelOptions: a non-claude row, a model-less row and junk contribute nothing', () => {
  assert.deepStrictEqual(modelOptions(rows(
    { type: 'bash', model: 'claude-opus-5' },
    { type: 'codex', model: 'gpt-6' },
    { type: 'claude', model: '' },
    { type: 'claude', model: null },
    { type: 'claude' },
    null,
    'claude-haiku-4',
  )), [...MODEL_ALIASES, 'claude-haiku-4'], 'ENTER: the one real claude row still landed');
});

test('the Move "moved N · skipped" line survives the list refresh it triggers', async () => {
  const vm = require('node:vm');
  const src = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'renderer.js'), 'utf8');
  const sliceNamed = (head) => {
    const start = src.indexOf(head);
    assert.ok(start >= 0, `ENTER: ${head} was located`);
    return src.slice(start, src.indexOf('\n}\n', start) + 2);
  };
  const stub = () => ({ textContent: '', value: '', style: {}, appendChild() {} });
  let moveClick = null;
  const btn = () => ({ addEventListener() {} });
  const ctx = {
    prefsAccountsState: stub(), prefsAccountsList: stub(), prefsAccountModel: null, ACCOUNT_DEFAULT: 'default',
    document: { createElement: stub },
    accountRowView: (a) => a, modelOptions: () => [],
    buildAccountRow: () => ({ row: stub(), login: btn(), resync: null, remove: null,
      move: { addEventListener: (t, cb) => { moveClick = cb; } } }),
    startLoginSeat() {}, confirm: () => true,
    window: { api: {
      accountsList: async () => ({ ok: true, accounts: [{ label: 'a' }] }),
      listSessions: async () => [],
      accountsMoveByModel: async () => ({ ok: true, moved: [{ name: 'x' }], skipped: [{ name: 's', reason: 'r' }] }),
    } },
  };
  vm.createContext(ctx);
  vm.runInContext(['function setPrefsAccountsState(', 'async function refreshPrefsAccounts('].map(sliceNamed).join('\n'), ctx);
  await ctx.refreshPrefsAccounts();
  assert.ok(moveClick, 'ENTER: the Move listener was wired');
  ctx.prefsAccountModel = { value: 'opus' };
  await moveClick();
  for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
  assert.strictEqual(ctx.prefsAccountsState.textContent, 'moved 1 · skipped: s (r)');
});

// --- the API key (t2173) -----------------------------------------------------

const API_NOKEY = { label: 'api-1', email: null, configDir: '/minted/api-1', plan: 'api', apiKey: false };
const API_KEYED = { ...API_NOKEY, apiKey: true };

test('accountRowView: an api row carries the key chip, as literals', () => {
  assert.deepStrictEqual(
    [API_NOKEY, API_KEYED, { ...SUB2, apiKey: true }].map((a) => {
      const v = accountRowView(a, 0, HOME);
      return [v.keyed, v.keyChip, v.hasKey];
    }),
    [[true, 'no key', false], [true, 'key ✓', true], [false, '', false]],
  );
});

test('an api row shows the chip and Set key…, Clear key only once keyed, and never the key', () => {
  const texts = (a) => build(a, 0).row.children.map((c) => c.textContent);
  const bare = build(API_NOKEY, 0);
  assert.deepStrictEqual(bare.row.children.filter((c) => c.tag === 'button').map((b) => b.textContent),
    ['Log in', 'Move', 'Re-sync settings', 'Set key…', 'Remove']);
  assert.strictEqual(bare.clearKey, null);
  assert.ok(texts(API_NOKEY).includes('no key'));
  const keyed = build(API_KEYED, 0);
  assert.deepStrictEqual(keyed.row.children.filter((c) => c.tag === 'button').map((b) => b.textContent),
    ['Log in', 'Move', 'Re-sync settings', 'Set key…', 'Clear key', 'Remove']);
  const chip = keyed.row.children.find((c) => c.className === 'prefs-account-key');
  assert.strictEqual(chip.textContent, 'key ✓');
  assert.ok(!JSON.stringify(build({ ...API_KEYED, ANTHROPIC_API_KEY: 'sk-ant-LEAK' }, 0).row).includes('sk-ant-LEAK'));
  const sub = build(SUB2, 0);
  assert.strictEqual(sub.setKey, null, 'a non-api row offers no key');
});

test('the inline key prompt is a password field with autocomplete off', () => {
  const { input, save } = buildKeyPrompt(fakeDoc());
  assert.strictEqual(input.type, 'password');
  assert.strictEqual(input.autocomplete, 'off');
  assert.strictEqual(input.placeholder, 'API key (sk-ant-…)');
  assert.strictEqual(save.type, 'button');
  assert.ok(css.includes('.prefs-account-key '), '.prefs-account-key is styled');
});

test('#prefs-account-key ships as a hidden password input and shows only for plan api', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'index.html'), 'utf8');
  const tag = html.match(/<input[^>]*id="prefs-account-key"[^>]*>/);
  assert.ok(tag, 'ENTER: the add-row key field exists');
  assert.match(tag[0], /type="password"/);
  assert.match(tag[0], /autocomplete="off"/);
  assert.match(tag[0], / hidden/);
  assert.deepStrictEqual(['api', 'max', 'pro', 'team', 'unknown'].map(keyFieldVisible), [true, false, false, false, false]);

  const vm = require('node:vm');
  const src = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'renderer.js'), 'utf8');
  const start = src.indexOf('function syncPrefsAccountKey(');
  assert.ok(start >= 0, 'ENTER: syncPrefsAccountKey was located');
  const ctx = { keyFieldVisible, prefsAccountKey: { hidden: true }, prefsAccountPlan: { value: 'api' } };
  vm.createContext(ctx);
  vm.runInContext(src.slice(start, src.indexOf('\n}\n', start) + 2), ctx);
  ctx.syncPrefsAccountKey();
  assert.strictEqual(ctx.prefsAccountKey.hidden, false, 'api shows the field');
  ctx.prefsAccountPlan.value = 'max';
  ctx.syncPrefsAccountKey();
  assert.strictEqual(ctx.prefsAccountKey.hidden, true, 'any other plan hides it');
  assert.match(src, /prefsAccountPlan\.addEventListener\('change', syncPrefsAccountKey\)/);
});

async function runAdd({ plan, addOk }) {
  const vm = require('node:vm');
  const src = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'renderer.js'), 'utf8');
  const start = src.indexOf('async function addPrefsAccount(');
  assert.ok(start >= 0, 'ENTER: addPrefsAccount was located');
  const calls = [];
  const field = (value) => ({ value });
  const ctx = {
    keyFieldVisible, abbrevHome: (d) => d, refreshPrefsAccounts() {},
    prefsAccountLabel: field('api-1'), prefsAccountEmail: field(''), prefsAccountDir: field(''),
    prefsAccountPlan: field(plan), prefsAccountKey: field(KEY_LITERAL),
    state: null, setPrefsAccountsState(msg, kind) { ctx.state = [msg, kind]; },
    window: { api: {
      accountsAdd: async (p) => { calls.push(['add', p]); return addOk ? { ok: true, account: { configDir: '/d' } } : { ok: false, error: 'dup' }; },
      accountsSetApiKey: async (label, key) => { calls.push(['setKey', label, key]); return { ok: true }; },
    } },
  };
  vm.createContext(ctx);
  vm.runInContext(src.slice(start, src.indexOf('\n}\n', start) + 2), ctx);
  await ctx.addPrefsAccount();
  return { calls, ctx };
}
const KEY_LITERAL = 'sk-ant-api03-RENDERERKEY';

test('addPrefsAccount keys an api account after the add, and clears the key field on success and failure', async () => {
  const ok = await runAdd({ plan: 'api', addOk: true });
  assert.deepStrictEqual(ok.calls.map((c) => c[0]), ['add', 'setKey']);
  assert.deepStrictEqual(ok.calls[1], ['setKey', 'api-1', KEY_LITERAL]);
  assert.ok(!JSON.stringify(ok.calls[0]).includes(KEY_LITERAL), 'the add call never carries the key');
  assert.strictEqual(ok.ctx.prefsAccountKey.value, '');
  assert.ok(!String(ok.ctx.state[0]).includes(KEY_LITERAL));

  const bad = await runAdd({ plan: 'api', addOk: false });
  assert.deepStrictEqual(bad.calls.map((c) => c[0]), ['add'], 'a failed add sets no key');
  assert.strictEqual(bad.ctx.prefsAccountKey.value, '', 'the field is cleared regardless');

  const max = await runAdd({ plan: 'max', addOk: true });
  assert.deepStrictEqual(max.calls.map((c) => c[0]), ['add'], 'a non-api plan sends no key');
  assert.strictEqual(max.ctx.prefsAccountKey.value, '');
});
