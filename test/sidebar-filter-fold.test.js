'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const { filterSummary, setFilterFolded } = require(path.join(ROOT, 'renderer/lib/sidebar-filter-fold.js'));
const html = fs.readFileSync(path.join(ROOT, 'renderer/index.html'), 'utf8');

const LABELS = {
  group: {
    none: 'No grouping',
    project: 'Group: Project / Team',
    state: 'Group: State',
    date: 'Group: Date',
    pr: 'Group: PR status',
  },
  sort: { recency: 'Sort: Recent', created: 'Sort: Created', alpha: 'Sort: A–Z' },
  status: { active: 'Active', archived: 'Archived', all: 'All' },
  activity: { all: 'Any time', 1: '1 day', 3: '3 days', 7: '7 days', 30: '30 days' },
};

const DEFAULTS = { group: 'none', sort: 'recency', status: 'all', activity: 'all', search: '' };

test('the summary names only the criteria that differ from the defaults, in control order', () => {
  const rows = [
    ['defaults', {}, ''],
    ['search only', { search: 'hand' }, '“hand”'],
    ['blank search is still a default', { search: '   ' }, ''],
    ['group only', { group: 'project' }, 'Project / Team'],
    ['sort only', { sort: 'alpha' }, 'A–Z'],
    ['status only', { status: 'archived' }, 'Archived'],
    ['activity only', { activity: '7' }, '7 days'],
    ['screenshot trio', { search: 'hand', group: 'project', status: 'active' }, '“hand” · Project / Team · Active'],
    [
      'all five set',
      { search: 'hand', group: 'project', sort: 'alpha', status: 'archived', activity: '7' },
      '“hand” · Project / Team · A–Z · Archived · 7 days',
    ],
  ];
  for (const [name, patch, expected] of rows) {
    assert.strictEqual(filterSummary({ ...DEFAULTS, ...patch }, LABELS), expected, name);
  }
});

function fakeEl() {
  const classes = new Set();
  return {
    textContent: '',
    classList: {
      toggle(name, on) { if (on) classes.add(name); else classes.delete(name); },
      has: (name) => classes.has(name),
    },
    has: (name) => classes.has(name),
  };
}

test('folding hides the body and persists filterFolded through setSidebarView', () => {
  const els = { bar: fakeEl(), header: fakeEl(), summary: fakeEl() };
  const calls = [];
  const persist = (patch) => calls.push(patch);

  setFilterFolded(els, true, { summary: '“hand” · Active', persist });
  assert.ok(els.bar.has('collapsed'), 'the bar carries .collapsed, which is what hides #sidebar-filter-body');
  assert.ok(els.header.has('collapsed'), 'the header carries it too, which is what rotates the shared caret');
  assert.strictEqual(els.summary.textContent, '“hand” · Active');
  assert.deepStrictEqual(calls, [{ filterFolded: true }]);

  setFilterFolded(els, false, { summary: '“hand” · Active', persist });
  assert.ok(!els.bar.has('collapsed'));
  assert.ok(!els.header.has('collapsed'));
  assert.strictEqual(els.summary.textContent, '', 'unfolded, the summary span is empty');
  assert.deepStrictEqual(calls, [{ filterFolded: true }, { filterFolded: false }]);

  const quiet = { bar: fakeEl(), header: fakeEl(), summary: fakeEl() };
  setFilterFolded(quiet, true, { summary: 'x' });
  assert.ok(quiet.bar.has('collapsed'), 'with no persist callback the class still toggles');
});

test('index.html: the Find header is the first child of #sidebar-filterbar and every filter control keeps its id', () => {
  const barAt = html.indexOf('<div id="sidebar-filterbar">');
  assert.ok(barAt >= 0, 'ENTER: #sidebar-filterbar is in the markup');
  const bar = html.slice(barAt, html.indexOf('<div id="session-list">', barAt));
  assert.ok(bar.length > 0, 'ENTER: the filter bar markup was sliced');

  const headerAt = bar.indexOf('<div id="sidebar-filter-header"');
  const bodyAt = bar.indexOf('<div id="sidebar-filter-body"');
  assert.ok(headerAt >= 0, 'the Find header is present');
  assert.ok(bodyAt >= 0, 'the foldable body is present');
  assert.ok(headerAt < bodyAt, 'the header comes first — after the body it reads as a footer and the caret points at nothing');
  assert.strictEqual(
    bar.slice(bar.indexOf('>') + 1, headerAt).trim(), '',
    'the header is the FIRST child: nothing sits between the bar open tag and it',
  );
  assert.match(bar.slice(headerAt, bodyAt), /class="session-group-header"/,
    'it reuses .session-group-header, which is where the caret rotation comes from');
  assert.match(bar.slice(headerAt, bodyAt), /id="sidebar-filter-summary"/);

  const body = bar.slice(bodyAt);
  for (const id of ['sidebar-search', 'sidebar-group', 'sidebar-sort', 'sidebar-status', 'sidebar-activity']) {
    assert.match(body, new RegExp(`id="${id}"`), `${id} keeps its id, inside the foldable body`);
  }
});

test('styles.css: .collapsed on the bar is what hides the body', () => {
  const css = fs.readFileSync(path.join(ROOT, 'renderer/styles.css'), 'utf8');
  const rules = [...css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .filter(([, sel]) => sel.trim() === '#sidebar-filterbar.collapsed #sidebar-filter-body');
  assert.ok(rules.length > 0, 'the fold rule exists');
  assert.ok(rules.every(([, , body]) => /display\s*:\s*none/.test(body)),
    'every such rule hides the body — a layer that forgot it leaves the bar open in that theme');
});
