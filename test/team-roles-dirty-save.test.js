'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const lib = require('../renderer/lib/team-roles');

const {
  rowFormValues, syncRowDirty, snapshotRowForm, confirmDiscardRoleEdits, DISCARD_ROLE_EDITS_PROMPT,
  buildSavePatch, DISPATCH_VALUES,
} = lib;

const POPOVER = fs.readFileSync(
  path.join(__dirname, '..', 'renderer/popovers/team-roles-popover.js'), 'utf-8');

function fakeClassList(initial) {
  const set = new Set(initial);
  return {
    add: (c) => set.add(c),
    remove: (c) => set.delete(c),
    contains: (c) => set.has(c),
    toggle: (c, on) => { if (on) set.add(c); else set.delete(c); return !!on; },
  };
}

function fakeRow({ fields = {}, dispatch = 'standing', readOnly = false } = {}) {
  const row = { classList: fakeClassList(readOnly ? ['team-role-row', 'read-only'] : ['team-role-row']) };
  const mk = (f, value) => ({
    value, dataset: { f },
    closest: (sel) => (sel === '[data-f]' ? mk.byName[f] : sel === '.team-role-row' ? row : null),
  });
  mk.byName = {};
  for (const [f, v] of Object.entries(fields)) mk.byName[f] = mk(f, v);
  const radios = DISPATCH_VALUES.map((v) => ({ value: v, checked: v === dispatch, dataset: { f: 'dispatch' } }));
  const save = { disabled: false, dataset: { act: 'save' } };
  row.querySelector = (sel) => {
    if (sel === 'button[data-act="save"]') return save;
    if (sel === 'input[data-f="dispatch"]:checked') return radios.find((r) => r.checked) || null;
    const m = /^\[data-f="([^"]+)"\]$/.exec(sel);
    if (m) return m[1] === 'dispatch' ? radios[0] : (mk.byName[m[1]] || null);
    throw new Error(`fake row: unhandled selector ${sel}`);
  };
  return { row, field: mk.byName, radios, save };
}

const HAND = { brief: 'implements', prompt: 'clodex-hand', account: '', template: 'clodex-hand-seat', cwd: '' };

function sliceBetween(src, start, end) {
  const a = src.indexOf(start);
  assert.ok(a >= 0, `ENTER: found ${JSON.stringify(start)}`);
  const b = src.indexOf(end, a + start.length);
  assert.ok(b >= 0, `ENTER: found ${JSON.stringify(end)} after it`);
  return src.slice(a, b + end.length);
}

function rowEditBlock() {
  const end = "  listEl.addEventListener('keydown'";
  return sliceBetween(POPOVER, '  const ROW_SAVE_EXEMPT_FIELDS', end).slice(0, -end.length);
}

function compileAfterMutation(env) {
  const body = sliceBetween(POPOVER, '  async function afterMutation(res, okMsg) {', '\n  }\n');
  const names = Object.keys(env);
  return new Function(...names, `${body}\nreturn afterMutation;`)(...names.map((n) => env[n]));
}

test('roles popover: a row\'s Save is disabled and unstyled until a field changes', () => {
  const { row, field, save } = fakeRow({ fields: HAND });
  snapshotRowForm(row);
  assert.strictEqual(save.disabled, true, 'a freshly rendered row has nothing to save');
  assert.strictEqual(row.classList.contains('dirty'), false);

  const handlers = {};
  const listEl = { addEventListener: (type, fn) => { handlers[type] = fn; } };
  const block = rowEditBlock();
  new Function('listEl', 'syncRowDirty', block)(listEl, syncRowDirty);
  assert.strictEqual(typeof handlers.change, 'function', 'the list listens for `change` (a <select> fires no `input` in every engine)');
  assert.strictEqual(typeof handlers.input, 'function', 'the list listens for `input` (typing in brief/cwd)');

  field.account.value = 'opsguru';
  handlers.change({ target: field.account });
  assert.strictEqual(row.classList.contains('dirty'), true, 'an account change marks the row dirty');
  assert.strictEqual(save.disabled, false, 'and enables its Save');

  field.account.value = '';
  handlers.change({ target: field.account });
  assert.strictEqual(row.classList.contains('dirty'), false, 'changing it back is clean again');
  assert.strictEqual(save.disabled, true);
});

test('roles popover: a lead-seat or trunk edit does not touch the row\'s Save', () => {
  const { row, save } = fakeRow({ fields: HAND });
  snapshotRowForm(row);
  row._saved = '{}';
  const handlers = {};
  const block = rowEditBlock();
  new Function('listEl', 'syncRowDirty', block)({ addEventListener: (t, fn) => { handlers[t] = fn; } }, syncRowDirty);
  for (const f of ['lead-seat', 'lead-pick', 'trunk']) {
    const inp = { dataset: { f }, value: 'x' };
    inp.closest = (sel) => (sel === '[data-f]' ? inp : row);
    handlers.input({ target: inp });
    handlers.change({ target: inp });
  }
  assert.strictEqual(save.disabled, true, 'the exempt fields pair with Set lead / Set trunk, not Save');
});

test('roles popover: a saved row is clean again; a refused save stays dirty', async () => {
  let current = fakeRow({ fields: HAND });
  snapshotRowForm(current.row);
  const replies = [{ ok: true }, { ok: false, error: 'x' }];
  const window = { api: { teamSetRole: async () => replies.shift() } };
  let status = null;
  const afterMutation = compileAfterMutation({
    setStatus: (m, warn) => { status = { m, warn: !!warn }; },
    formatBlockedBy: lib.formatBlockedBy,
    teamName: () => 'clodex',
    refresh: async () => {
      current = fakeRow({ fields: { ...HAND, account: 'opsguru' } });
      snapshotRowForm(current.row);
      return true;
    },
  });

  current.field.account.value = 'opsguru';
  syncRowDirty(current.row);
  assert.strictEqual(current.row.classList.contains('dirty'), true, 'ENTER: the edit made the row dirty');
  await afterMutation(await window.api.teamSetRole('clodex', 'hand', buildSavePatch(rowFormValues(current.row))), 'saved');
  assert.strictEqual(current.row.classList.contains('dirty'), false, 'a successful save rebuilds the row clean');
  assert.strictEqual(current.save.disabled, true, 'and its Save goes quiet');

  current.field.account.value = '';
  syncRowDirty(current.row);
  const before = current;
  await afterMutation(await window.api.teamSetRole('clodex', 'hand', buildSavePatch(rowFormValues(current.row))), 'saved');
  assert.strictEqual(current, before, 'a refused save does not rebuild the rows');
  assert.strictEqual(current.row.classList.contains('dirty'), true, 'a refused save leaves the row dirty');
  assert.strictEqual(current.save.disabled, false, 'with Save still enabled for a retry');
  assert.deepStrictEqual(status, { m: 'x', warn: true });

  assert.match(sliceBetween(POPOVER, '  function renderRows(manifest) {', '\n  }\n'), /snapshotRowForm\(el\);\n\s*listEl\.appendChild\(el\);/,
    'renderRows retakes each row\'s snapshot, which is what makes the post-save rebuild clean');
});

test('roles popover: the dirty check reads the same fields the save patch sends', () => {
  const branch = sliceBetween(POPOVER, "if (act === 'save') {", '} else if');
  assert.match(branch, /rowFormValues\(rowEl\)/, 'the save branch reads the form through rowFormValues');
  assert.ok(!branch.includes('[data-f='), 'no other [data-f=…] read remains in the save branch');

  const { row, radios } = fakeRow({ fields: { ...HAND, cwd: 'api' }, dispatch: 'worktree' });
  assert.ok(radios[0].value !== 'worktree', 'ENTER: the first segment is not the chosen one');
  assert.deepStrictEqual(rowFormValues(row), { ...HAND, cwd: 'api', dispatch: 'worktree' },
    'dispatch is the CHECKED segment, not the first one a plain [data-f] lookup returns');
  const { row: bare } = fakeRow({ fields: { account: 'a' }, readOnly: true });
  assert.deepStrictEqual(rowFormValues(bare), { brief: '', prompt: '', template: '', dispatch: 'standing', cwd: '', account: 'a' },
    'an absent field reads blank');
});

test('roles popover: closing with a dirty row asks before discarding', () => {
  const body = sliceBetween(POPOVER, '  function closeTeamRolesPopover() {', '\n  }\n');
  const make = (dirty, answer) => {
    const asked = [];
    const popover = { classList: fakeClassList([]), dataset: { name: 'clodex' } };
    const listEl = { querySelector: (sel) => (sel === '.team-role-row.dirty' && dirty ? {} : null) };
    const window = { confirm: (m) => { asked.push(m); return answer; } };
    const close = new Function('popover', 'listEl', 'window', 'confirmDiscardRoleEdits', `${body}\nreturn closeTeamRolesPopover;`)(
      popover, listEl, window, confirmDiscardRoleEdits);
    return { close, popover, asked };
  };

  const kept = make(true, false);
  assert.strictEqual(kept.close(), false);
  assert.strictEqual(kept.popover.classList.contains('hidden'), false, 'cancelling the confirm keeps the popover open');
  assert.deepStrictEqual(kept.asked, [DISCARD_ROLE_EDITS_PROMPT]);

  const discarded = make(true, true);
  assert.strictEqual(discarded.close(), true);
  assert.strictEqual(discarded.popover.classList.contains('hidden'), true);

  const clean = make(false, false);
  assert.strictEqual(clean.close(), true);
  assert.strictEqual(clean.popover.classList.contains('hidden'), true, 'a clean popover closes without asking');
  assert.deepStrictEqual(clean.asked, []);

  for (const re of [
    /getElementById\('team-roles-popover-close'\)\.addEventListener\('click', closeTeamRolesPopover\)/,
    /getElementById\('team-roles-popover-done'\)\.addEventListener\('click', closeTeamRolesPopover\)/,
    /if \(popover\.contains\(e\.target\)\) return;\n\s*closeTeamRolesPopover\(\);/,
    /e\.key === 'Escape' && !popover\.classList\.contains\('hidden'\)\) closeTeamRolesPopover\(\)/,
  ]) assert.match(POPOVER, re, '✕, Done, outside-mousedown and Escape all route through the guarded close');
  assert.match(sliceBetween(POPOVER, '  async function openTeamRolesPopover(name, anchorEl) {', '\n  }\n'),
    /^  async function openTeamRolesPopover\(name, anchorEl\) \{\n\s*if \(!popover\.classList\.contains\('hidden'\) && !confirmDiscardRoleEdits\(listEl, \(m\) => window\.confirm\(m\)\)\) return;\n/,
    're-opening over a dirty popover (right-click a team header, the Teams menu) asks before renderRows rebuilds the list');
  assert.ok(!/^\s*closeTeamRolesPopover\(\);/m.test(POPOVER.replace(/if \(popover\.contains\(e\.target\)\) return;\n\s*closeTeamRolesPopover\(\);/, '')),
    'a close that leads somewhere else (template editor, new-session dialog) must stop when the operator keeps their edits');
});

test('confirmDiscardRoleEdits: no dirty row, no question', () => {
  let asked = 0;
  assert.strictEqual(confirmDiscardRoleEdits({ querySelector: () => null }, () => { asked++; return false; }), true);
  assert.strictEqual(asked, 0);
  assert.strictEqual(confirmDiscardRoleEdits({ querySelector: () => ({}) }, () => true), true);
  assert.strictEqual(confirmDiscardRoleEdits({ querySelector: () => ({}) }, () => false), false);
});

test('syncRowDirty: a row never snapshotted is not dirty', () => {
  const { row, save } = fakeRow({ fields: HAND });
  assert.strictEqual(syncRowDirty(row), false);
  assert.strictEqual(save.disabled, true);
});

function fakeEl(tag) {
  const e = {
    tagName: tag, children: [], dataset: {}, listeners: {},
    appendChild(c) { this.children.push(c); return c; },
    append(...cs) { this.children.push(...cs); },
    addEventListener(t, fn) { (this.listeners[t] = this.listeners[t] || []).push(fn); },
  };
  return e;
}

function descendants(el, tag) {
  const out = [];
  for (const c of el.children || []) {
    if (c.tagName === tag) out.push(c);
    out.push(...descendants(c, tag));
  }
  return out;
}

function renderReservedTemplate(rowKey, stored, templateRows) {
  const document = { createElement: fakeEl };
  const shared = {
    document, templateRows, teamName: () => 'box',
    templateOptionGroups: lib.templateOptionGroups, templateRowFor: lib.templateRowFor,
    reviewerTemplateOptionGroups: lib.reviewerTemplateOptionGroups, reservedRoleTemplate: lib.reservedRoleTemplate,
    platformBadge: () => fakeEl('span'), paintPlatformBadge: () => {},
    closeTeamRolesPopover: () => true, openTemplate: () => {},
  };
  const btcSrc = sliceBetween(POPOVER, '  function buildTemplateControl(', '\n    return { select, open, platform };\n  }\n');
  const btcNames = Object.keys(shared);
  shared.buildTemplateControl = new Function(...btcNames, `${btcSrc}\nreturn buildTemplateControl;`)(
    ...btcNames.map((n) => shared[n]));
  const start = "        {\n          const holder = body.querySelector('.team-role-ro-field[data-field=\"template\"]');";
  const armSrc = sliceBetween(POPOVER, start, '\n        // The lead ROLE stays locked').replace(/\n        \/\/ The lead ROLE stays locked$/, '');
  const holder = fakeEl('div');
  const body = { querySelector: (sel) => (sel === '.team-role-ro-field[data-field="template"]' ? holder : null) };
  const names = Object.keys(shared);
  new Function('row', 'body', ...names, armSrc)({ key: rowKey, template: stored }, body, ...names.map((n) => shared[n]));
  return holder;
}

const PICK_ROWS = [
  { name: 'clodex-team-reviewer', systemPromptFile: 'clodex-team-reviewer' },
  { name: 'clodex-team-hand', systemPromptFile: 'clodex-team-hand' },
  { name: 'codex-reviewer', systemPromptFile: 'clodex-team-reviewer-codex' },
  { name: 'box-reviewer', systemPromptFile: 'clodex-team-reviewer', team: 'box' },
  { name: 'box-hand', systemPromptFile: 'clodex-team-hand', team: 'box' },
  { name: 'far-reviewer', systemPromptFile: 'clodex-team-reviewer', team: 'far' },
  { name: 'plug-reviewer', systemPromptFile: 'clodex-team-reviewer', plugin: 'p' },
  { name: 'clodex-team-lead', systemPromptFile: 'clodex-team-lead' },
];

test('t1377: the reviewer row renders a template picker over reviewer templates only, team first; lead renders none', () => {
  const holder = renderReservedTemplate('reviewer', 'codex-reviewer', PICK_ROWS);
  const selects = descendants(holder, 'select');
  assert.strictEqual(selects.length, 1, 'the reviewer row carries one select');
  const select = selects[0];
  assert.strictEqual(select.dataset.f, 'template', 'it is the row\'s template field, so rowFormValues reads it');
  assert.deepStrictEqual(descendants(select, 'option').map((o) => o.value),
    ['box-reviewer', 'clodex-team-reviewer', 'codex-reviewer'],
    'exactly the reviewer-purpose rows: this team\'s first, then the library; no (none), no plugin, no other team');
  assert.strictEqual(select.value, 'codex-reviewer', 'the stored template is selected');

  const lead = renderReservedTemplate('lead', '', PICK_ROWS);
  assert.strictEqual(descendants(lead, 'select').length, 0, 'the lead row keeps its read-only template text');

  const { row, field, save } = fakeRow({ fields: { account: '' }, readOnly: true });
  field.template = select;
  select.closest = (sel) => (sel === '[data-f]' ? select : sel === '.team-role-row' ? row : null);
  const q = row.querySelector;
  row.querySelector = (sel) => (sel === '[data-f="template"]' ? select : q(sel));
  snapshotRowForm(row);
  assert.strictEqual(save.disabled, true, 'ENTER: a freshly rendered reviewer row has nothing to save');
  const handlers = {};
  new Function('listEl', 'syncRowDirty', rowEditBlock())({ addEventListener: (t, fn) => { handlers[t] = fn; } }, syncRowDirty);
  select.value = 'box-reviewer';
  handlers.change({ target: select });
  assert.strictEqual(save.disabled, false, 'picking another reviewer template lights Save');
});
