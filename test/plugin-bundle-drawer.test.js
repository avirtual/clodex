'use strict';
// plugin-bundle-drawer.test.js — t675 phase B: the Skills and Agents library
// drawers list a plugin's bundle records under the plugin's name, WITHOUT the
// edit/delete controls a library row carries.
//
// The absent controls are the point. A bundle file lives in the plugin's own
// directory, so an Edit that saved would write a copy into ~/.clodex/skills
// under the same name, and a Delete would remove part of an installed plugin
// from a drawer that never said it could. Counting controls on the bundle
// section alone would pass a drawer that drew no bundle rows at all, so every
// count here is paired with the flat section's in the same test.
//
// The drawer is DOM-bound and reaches its nodes through getElementById, so the
// harness serves stub elements and drives the real refresh through the open
// hook the module registers on window.api.

const test = require('node:test');
const assert = require('node:assert');

function el(tag = 'div') {
  const e = {
    tagName: tag, className: '', style: {}, value: '', children: [], dataset: {},
    classList: { add() {}, remove() {}, contains: () => false },
    appendChild(c) { e.children.push(c); return c; },
    addEventListener() {},
    focus() {},
    querySelector(sel) {
      const m = /^\[data-action="([a-z]+)"\]$/.exec(sel);
      assert.ok(m, `the harness only models the drawer's own action lookup, got ${sel}`);
      return e.innerHTML.includes(`data-action="${m[1]}"`) ? el('button') : null;
    },
  };
  let html = '';
  Object.defineProperty(e, 'innerHTML', {
    get: () => html,
    set(v) { html = v == null ? '' : String(v); if (html === '') e.children.length = 0; },
  });
  let text = '';
  Object.defineProperty(e, 'textContent', {
    get: () => text,
    set(v) { text = v == null ? '' : String(v); html = text; },
  });
  return e;
}

const SECTIONS = {
  skills: [{ id: 'stocks', name: 'Stock Assessments', names: ['assess', 'compare'] }],
  agents: [{ id: 'stocks', name: 'Stock Assessments', names: ['screener'] }],
};

// One flat list of headers and rows, so a header drawn detached from the rows it
// names is visible rather than merely counted.
const laidOut = (listEl) => listEl.children.map((n) => (n.className === 'check-group'
  ? { kind: 'head', text: n.textContent }
  : { kind: 'row', cls: n.className, html: n.innerHTML }));

async function openDrawer(kind, { flat = true } = {}) {
  const nodes = new Map();
  const byId = (id) => {
    if (!nodes.has(id)) nodes.set(id, el());
    return nodes.get(id);
  };
  const opens = {};
  const hadDoc = global.document;
  const hadWin = global.window;
  global.document = { getElementById: byId, createElement: el, addEventListener() {} };
  global.window = {
    api: {
      listAgents: async () => (kind === 'agents' && flat ? [{ name: 'explorer', description: 'reads', meta: {} }] : []),
      listSkillLib: async () => (kind === 'skills' && flat ? [{ name: 'my-skill', description: 'mine', content: '' }] : []),
      listPrompts: async () => [],
      listExecCommands: async () => [],
      listTemplates: async () => [],
      onRequestOpenSkillsDrawer: (cb) => { opens.skills = cb; },
      onRequestOpenAgentsDrawer: (cb) => { opens.agents = cb; },
      onRequestOpenExecDrawer() {},
      onRequestOpenPromptsDrawer() {},
      onRequestOpenTemplatesDrawer() {},
    },
  };
  try {
    delete require.cache[require.resolve('../renderer/library-drawers')];
    const { initLibraryDrawers } = require('../renderer/library-drawers');
    initLibraryDrawers({
      getActiveSession: () => null,
      setAgentLibCache() {}, setSkillLibCache() {},
      openTemplateEditor() {},
      bundleSectionsOf: (k) => SECTIONS[k] || [],
      refreshPluginCatalog: async () => {},
    });
    assert.strictEqual(typeof opens[kind], 'function',
      `ENTER: the drawer registered no open hook for ${kind} — nothing below would have run the refresh`);
    opens[kind]();
    // The refresh awaits its library read; let those microtasks drain.
    await new Promise((r) => setImmediate(r));
    return {
      list: byId(kind === 'skills' ? 'skills-list' : 'agents-list'),
      empty: byId(kind === 'skills' ? 'skills-empty' : 'agents-empty'),
    };
  } finally {
    global.document = hadDoc;
    global.window = hadWin;
  }
}

const CONTROLS = /data-action=/g;
const countControls = (html) => (html.match(CONTROLS) || []).length;

for (const kind of ['skills', 'agents']) {
  const flatName = kind === 'skills' ? 'my-skill' : 'explorer';
  const bundleName = kind === 'skills' ? 'assess' : 'screener';

  test(`${kind} drawer: bundle records list under the plugin name, after the flat rows`, async () => {
    const { list } = await openDrawer(kind);
    const out = laidOut(list);

    const head = out.findIndex((n) => n.kind === 'head');
    assert.ok(head >= 0, 'ENTER: a group header drew at all');
    assert.strictEqual(out[head].text, 'Stock Assessments',
      'grouped under the plugin display name, not its id');
    const rowsBefore = out.slice(0, head).filter((n) => n.kind === 'row');
    const rowsAfter = out.slice(head).filter((n) => n.kind === 'row');
    assert.ok(rowsBefore.some((n) => n.html.includes(flatName)),
      `the flat ${flatName} row is ABOVE the header — bundle sections come last`);
    assert.ok(rowsAfter.some((n) => n.html.includes(bundleName)),
      `ENTER: the ${bundleName} bundle row drew under the header`);
  });

  test(`${kind} drawer: bundle rows carry NO controls while flat rows still do`, async () => {
    const { list } = await openDrawer(kind);
    const rows = laidOut(list).filter((n) => n.kind === 'row');

    const flat = rows.find((n) => n.html.includes(flatName));
    const bundle = rows.find((n) => n.html.includes(bundleName));
    assert.ok(flat && bundle, 'ENTER: both a flat row and a bundle row are on screen');

    assert.strictEqual(countControls(bundle.html), 0,
      'a bundle record is the plugin\'s file — an Edit here would fork it into the operator\'s library, a Delete would gut the plugin');
    assert.ok(countControls(flat.html) > 0,
      'CONTROL: the flat library row keeps its Edit, or the assertion above passes for a drawer with no controls anywhere');
    assert.match(bundle.cls, /bundle-item/, 'and it is marked as one, so the styling can say so too');
  });

  test(`${kind} drawer: an empty library still shows the bundle section, not the empty state`, async () => {
    const { list, empty } = await openDrawer(kind, { flat: false });
    const rows = laidOut(list).filter((n) => n.kind === 'row');
    assert.ok(rows.some((n) => n.html.includes(bundleName)),
      'ENTER: with no library of their own, the operator still sees what the plugin carries');
    assert.strictEqual(empty.style.display, 'none',
      'the empty-library placeholder must be hidden, or it sits above rows that contradict it');
  });
}
