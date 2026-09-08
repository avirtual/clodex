'use strict';

// codex-skills-popover.test.js — t750, the Skills… popover opened on a CODEX
// seat. t749 gave a codex seat Custom skills at create time; without this the
// seat could never change them, because the menu entry was claude-only and the
// popover would have drawn a Claude roster it does not have.
//
// THE MODULE IS RUN, NOT GREPPED. The thing that can break is what the Apply
// SENDS, and a source-shape assertion cannot see it: the roster container is a
// shared DOM node, so "which list did the collect read" depends on what a
// PREVIOUS open painted into it. The dangerous state is therefore reachable only
// by opening twice, which is exactly what the second subject does.
//
// What a wrong version sends is not nothing — it is `[]`, or the last claude
// seat's answer, and either lands as this seat's real off-list: `[]` re-enables
// every skill the box had turned off, and the leftover disables skills the
// operator never saw a row for.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { initChecklistPopovers } = require('../renderer/popovers/checklist-popovers');

function makeEl(tag = 'div') {
  const classes = new Set();
  const handlers = new Map();
  const el = {
    tagName: tag,
    dataset: {},
    style: {},
    value: '',
    type: '',
    checked: false,
    disabled: false,
    textContent: '',
    children: [],
    isConnected: true,
    offsetWidth: 300,
    offsetHeight: 200,
    classList: {
      add: (c) => classes.add(c),
      remove: (c) => classes.delete(c),
      contains: (c) => classes.has(c),
      toggle: (c, on) => (on ? classes.add(c) : classes.delete(c)),
    },
    set innerHTML(v) { el._html = v; if (v === '') el.children = []; },
    get innerHTML() { return el._html || ''; },
    appendChild: (c) => { el.children.push(c); return c; },
    contains: () => false,
    closest: () => null,
    getBoundingClientRect: () => ({ left: 10, top: 10, width: 100, height: 20, bottom: 30 }),
    addEventListener: (t, fn) => {
      if (!handlers.has(t)) handlers.set(t, []);
      handlers.get(t).push(fn);
    },
    fire: async (t, ev = {}) => { for (const fn of handlers.get(t) || []) await fn(ev); },
    querySelector: () => null,
    // The real renderSkillChecklist builds label > (input, span), so the boxes
    // are one level down. Only the selectors the collectors actually pass.
    querySelectorAll: (sel) => {
      const boxes = el.children
        .flatMap((row) => row.children || [])
        .filter((c) => c.type === 'checkbox');
      if (sel === 'input[type="checkbox"]:checked') return boxes.filter((c) => c.checked);
      if (sel === 'input[type="checkbox"]:checked:not(:disabled)') {
        return boxes.filter((c) => c.checked && !c.disabled);
      }
      if (sel === 'input[type="checkbox"]:not(:checked):not(:disabled)') {
        return boxes.filter((c) => !c.checked && !c.disabled);
      }
      return [];
    },
  };
  return el;
}

// `catalogs` maps a seat name to what session:skillCatalog serves for it;
// `types` maps a seat name to the sidebar type getSessionType answers with.
function harness({ catalogs, types }) {
  const prev = {
    doc: global.document, win: global.window, css: global.CSS, alert: global.alert,
  };
  const els = new Map();
  const get = (id) => { if (!els.has(id)) els.set(id, makeEl()); return els.get(id); };
  global.document = {
    getElementById: get,
    createElement: (t) => makeEl(t),
    addEventListener() {},
    querySelector: () => null,
  };
  global.CSS = { escape: (s) => s };
  global.alert = () => {};

  const calls = [];
  global.window = {
    innerWidth: 1200,
    innerHeight: 800,
    api: {
      getSettings: async () => ({ claudeTools: [] }),
      getSkillCatalog: async (name) => catalogs[name],
      pluginCatalog: async () => [],
      setSessionSkills: async (name, disabledSkills, injectSkills) => {
        calls.push(['setSessionSkills', name, disabledSkills, injectSkills]);
        return { ok: true };
      },
      setSessionPlugins: async () => ({ ok: true }),
      setSessionIntents: async () => ({ ok: true }),
      setSessionPluginGrants: async () => ({ ok: true }),
      restartSession: async () => ({ ok: true }),
    },
  };

  const api = initChecklistPopovers({
    sessionList: { querySelector: () => null },
    createTerminal() {}, addSessionToSidebar() {}, switchSession() {},
    refreshSidebarMeta() {},
    getSessionType: (name) => types[name] || null,
  });

  return {
    api,
    els,
    calls,
    roster: () => els.get('popover-skills-roster'),
    rosterList: () => els.get('popover-skills-list'),
    injectList: () => els.get('popover-inject-skills-list'),
    boxes: (id) => els.get(id).children
      .flatMap((r) => r.children || []).filter((c) => c.type === 'checkbox'),
    apply: () => els.get('skills-popover-apply').fire('click'),
    restore() {
      global.document = prev.doc; global.window = prev.win;
      global.CSS = prev.css; global.alert = prev.alert;
    },
  };
}

const LIB = [{ name: 'deploy', content: '' }, { name: 'grok', content: '' }];

const CLAUDE_CAT = {
  ok: true,
  names: ['alpha', 'beta'],
  effective: {},
  disabledSkills: ['alpha'],
  skillLib: LIB,
  injectSkills: ['deploy'],
  outOfScope: [],
};
// A codex seat's catalog is shaped the same — readSkillCatalog is provider-blind
// — which is precisely why the popover cannot decide from the payload and must
// read the caps table.
const CODEX_CAT = {
  ok: true,
  names: ['alpha', 'beta'],
  effective: {},
  disabledSkills: ['alpha'],
  skillLib: LIB,
  injectSkills: [],
  outOfScope: [],
};

const TYPES = { claude_seat: 'claude', codex_seat: 'codex' };
const CATS = { claude_seat: CLAUDE_CAT, codex_seat: CODEX_CAT };

test('t750: a codex seat opens the inject section with the Claude roster hidden', async () => {
  const h = harness({ catalogs: CATS, types: TYPES });
  try {
    await h.api.openSkillsPopover('codex_seat', null);
    assert.strictEqual(h.roster().style.display, 'none',
      'the roster block is hidden — codex has no Claude skill roster to trim');
    assert.strictEqual(h.rosterList().children.length, 0,
      'and nothing was painted into it, so a later collect has no rows to misread');
    assert.strictEqual(h.els.get('popover-inject-skills-section').style.display, '',
      'the inject section — the whole reason the popover opens for codex — is shown');
    assert.deepStrictEqual(h.boxes('popover-inject-skills-list').map((c) => c.value),
      ['deploy', 'grok'], 'ENTER: the library really drew its rows');
  } finally { h.restore(); }
});

test('t750: a claude seat still paints and collects its roster', async () => {
  const h = harness({ catalogs: CATS, types: TYPES });
  try {
    await h.api.openSkillsPopover('claude_seat', null);
    assert.strictEqual(h.roster().style.display, '', 'the roster block is shown for claude');
    const boxes = h.boxes('popover-skills-list');
    assert.deepStrictEqual(boxes.map((c) => c.value), ['alpha', 'beta'],
      'ENTER: both roster rows drew — with none, every collect below is vacuously []');
    assert.deepStrictEqual(boxes.filter((c) => !c.checked).map((c) => c.value), ['alpha'],
      'ENTER: the persisted off-skill drew unticked');

    boxes.find((c) => c.value === 'beta').checked = false;
    await h.apply();
    const wrote = h.calls.filter((c) => c[0] === 'setSessionSkills');
    assert.deepStrictEqual(wrote, [['setSessionSkills', 'claude_seat', ['alpha', 'beta'], ['deploy']]],
      'the claude save reads the operator\'s ticks, not the echo');
  } finally { h.restore(); }
});

// The dangerous state, and the only one that needs two opens to reach: the
// roster container is shared, so a codex save that collected from it would send
// whatever the previous CLAUDE seat left there — skills the codex operator was
// never shown a row for, silently turned off on their seat.
test('t750: a codex save echoes its own off-list, never the last claude seat\'s rows', async () => {
  const h = harness({ catalogs: CATS, types: TYPES });
  try {
    await h.api.openSkillsPopover('claude_seat', null);
    const stale = h.boxes('popover-skills-list');
    stale.find((c) => c.value === 'beta').checked = false;
    assert.deepStrictEqual(stale.filter((c) => !c.checked).map((c) => c.value), ['alpha', 'beta'],
      'ENTER: the shared container now holds a two-name answer that is not codex_seat\'s');

    await h.api.openSkillsPopover('codex_seat', null);
    h.boxes('popover-inject-skills-list').find((c) => c.value === 'grok').checked = true;
    await h.apply();

    const wrote = h.calls.filter((c) => c[0] === 'setSessionSkills');
    assert.deepStrictEqual(wrote,
      [['setSessionSkills', 'codex_seat', ['alpha'], ['grok']]],
      'the off-list is echoed back exactly as read, and the inject tick is what the save carries');
  } finally { h.restore(); }
});

// `[]` is the other wrong answer, and the one a never-painted container gives on
// a first open: it would re-enable every skill the box had turned off.
test('t750: the codex echo is the read off-list, not the empty list', async () => {
  const h = harness({ catalogs: CATS, types: TYPES });
  try {
    await h.api.openSkillsPopover('codex_seat', null);
    await h.apply();
    const wrote = h.calls.filter((c) => c[0] === 'setSessionSkills');
    assert.strictEqual(wrote.length, 1, 'ENTER: the save fired');
    assert.deepStrictEqual(wrote[0][2], ['alpha'],
      'an unpainted roster must not be read as "nothing is disabled"');
  } finally { h.restore(); }
});

// A peer row's sidebar type is `remote`, which capsFor reads as the all-false
// row. Gating on it would hide the roster on every peer open — including the
// claude seats the peer menu's Skills entry exists for.
test('t750: a peer open keeps its roster, whatever this box calls the row', async () => {
  const h = harness({ catalogs: CATS, types: { peer_seat: 'remote' } });
  try {
    const source = {
      fetch: async () => CLAUDE_CAT,
      save: async (payload) => { h.calls.push(['peerSave', payload]); return { ok: true }; },
      restartFresh() {},
    };
    await h.api.openSkillsPopover('peer_seat', null, source);
    assert.strictEqual(h.roster().style.display, '',
      'the peer roster is drawn — the remote box serves and honours it');
    assert.deepStrictEqual(h.boxes('popover-skills-list').map((c) => c.value), ['alpha', 'beta'],
      'ENTER: the peer catalog painted its rows');

    await h.apply();
    assert.deepStrictEqual(h.calls.filter((c) => c[0] === 'peerSave'),
      [['peerSave', { disabledSkills: ['alpha'], injectSkills: ['deploy'] }]],
      'the peer save carries the collected roster, not an echo');
  } finally { h.restore(); }
});

// The markup half, which no fixture above can see: the three roster pieces (bulk
// buttons, list, hint) must sit inside the ONE div the popover toggles, or a
// codex open hides the list and leaves "Check All" and the skillOverrides hint
// floating above an inject section they do not describe.
test('t750: index.html keeps the whole roster block inside the toggled div', () => {
  const html = fs.readFileSync(
    path.join(__dirname, '..', 'renderer', 'index.html'), 'utf8');
  const at = html.indexOf('<div id="popover-skills-roster">');
  assert.ok(at > 0, 'ENTER: the roster wrapper exists');
  const end = html.indexOf('<div id="popover-inject-skills-section"', at);
  assert.ok(end > at, 'ENTER: the inject section still follows the roster block');
  const block = html.slice(at, end);
  assert.ok(block.includes('data-bulk="all"'), 'the bulk buttons are inside');
  assert.ok(block.includes('id="popover-skills-list"'), 'the roster list is inside');
  assert.ok(block.includes('skillOverrides'), 'the roster hint is inside');

  // The inject hint is provider-blind now: --plugin-dir is how the CLAUDE
  // adapter delivers, and naming it on a popover a codex seat opens describes a
  // flag that seat never sees.
  const inject = html.slice(end, html.indexOf('</div>', html.indexOf('NEW conversation', end)));
  assert.ok(!inject.includes('--plugin-dir'),
    'the inject hint no longer names the claude-only delivery flag');
});
