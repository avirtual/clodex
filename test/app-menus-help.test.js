'use strict';
// app-menus-help.test.js — the Help menu (t983 / Help window S3).
//
// The menu is the DESKTOP entry point to the help corpus, and the native Help
// search field indexes item labels, which is why every page is its own item
// rather than a single "Help" that opens a picker. Both halves are asserted
// through the real buildAppMenu: the structure (accelerator, a submenu per
// section, an item per page) and what each click actually SENDS, since a menu
// whose items carry the wrong channel or a stale name looks identical here.
//
// A fixture corpus is used rather than the real docs: this file pins the menu's
// shape, and the manifest's page list is test/help-corpus.test.js's subject.

const test = require('node:test');
const assert = require('node:assert');
const Module = require('node:module');
const path = require('node:path');

const SECTIONS = [
  {
    title: 'Guides',
    pages: [
      { name: 'how-to', title: 'How to', headings: [] },
      { name: 'teams', title: 'Teams', headings: [] },
    ],
  },
  {
    title: 'Reference',
    pages: [{ name: 'peering', title: 'Peering', headings: [] }],
  },
];

// app-menus.js requires('electron') at module scope. Load it with a stub whose
// focused window records what a click sends, so the click assertions below run
// the shipped sendToFocused rather than a re-implementation of it.
function buildHelpMenu({ getHelpCorpus } = {}) {
  const sent = [];
  let captured = null;
  const win = { webContents: { send: (...args) => sent.push(args) } };
  const stub = {
    app: { getName: () => 'Clodex', getVersion: () => '0.0.0', setAboutPanelOptions: () => {} },
    BrowserWindow: { getFocusedWindow: () => win, getAllWindows: () => [win] },
    Menu: {
      buildFromTemplate: (t) => {
        if (!captured) captured = t;
        return t;
      },
      setApplicationMenu: () => {},
    },
    Tray: function Tray() {},
    dialog: {}, shell: { openExternal: () => {} },
    nativeImage: { createFromPath: () => ({ setTemplateImage() {} }) },
  };
  const origLoad = Module._load;
  Module._load = function (request, ...rest) {
    if (request === 'electron') return stub;
    return origLoad.call(this, request, ...rest);
  };
  try {
    delete require.cache[require.resolve('../app-menus.js')];
    const { createAppMenus } = require('../app-menus.js');
    const nothing = () => ({ list: () => [], get: () => ({}), sortedByRecent: () => [], statuses: () => [] });
    const menus = createAppMenus({
      DEFAULT_WORKSPACE_ID: 'default', LOG_FILE: '/dev/null', THEME_KEYS: [], path,
      checkForUpdate: () => {}, confirmRestartClodex: () => {}, createWindow: () => null,
      getManager: nothing, getPeerManager: () => null, getSandboxManager: () => null,
      getUpdateInfo: () => null, getUiSettings: nothing, getWorkspaces: nothing,
      getAgentLibrary: nothing, getSkillLibrary: nothing, getEnvScopes: () => null,
      getPromptLibrary: nothing, getTemplates: nothing, getExecLibrary: nothing,
      getPluginHost: () => null,
      ...(getHelpCorpus === undefined ? {} : { getHelpCorpus }),
    });
    menus.buildAppMenu();
  } finally {
    Module._load = origLoad;
    delete require.cache[require.resolve('../app-menus.js')];
  }
  const help = (captured || []).find((m) => m.label === 'Help');
  return { help, sent };
}

const corpus = () => ({ index: () => ({ sections: SECTIONS }) });

test('Help carries Clodex Help with the ⌘⇧/ accelerator, and F1 as a hidden alias', () => {
  const { help } = buildHelpMenu({ getHelpCorpus: corpus });
  assert.ok(help, 'ENTER: the Help menu exists, or every assertion below is vacuous');

  const named = help.submenu.filter((i) => i.label === 'Clodex Help');
  assert.strictEqual(named.length, 2, 'the visible chord plus the hidden F1 alias');
  assert.strictEqual(named[0].accelerator, 'CmdOrCtrl+Shift+/');
  assert.notStrictEqual(named[0].visible, false, 'the ⌘⇧/ item is the one the operator sees');
  assert.strictEqual(named[1].accelerator, 'F1');
  assert.strictEqual(named[1].visible, false, 'F1 works but does not double the item in the menu');
});

test('one submenu per manifest section, one item per page, in manifest order', () => {
  const { help } = buildHelpMenu({ getHelpCorpus: corpus });
  const sections = help.submenu.filter((i) => Array.isArray(i.submenu));
  assert.deepStrictEqual(sections.map((s) => s.label), ['Guides', 'Reference']);
  assert.deepStrictEqual(sections[0].submenu.map((i) => i.label), ['How to', 'Teams']);
  assert.deepStrictEqual(sections[1].submenu.map((i) => i.label), ['Peering']);
});

test('the how-to item sends request-open-help with its page name', () => {
  const { help, sent } = buildHelpMenu({ getHelpCorpus: corpus });
  const guides = help.submenu.find((i) => i.label === 'Guides');
  const howTo = guides.submenu.find((i) => i.label === 'How to');
  assert.ok(howTo, 'ENTER: the how-to item is present');

  howTo.click();
  assert.deepStrictEqual(sent, [['request-open-help', 'how-to']]);
});

test('the bare Clodex Help click sends the channel with NO name — the panel picks its default', () => {
  const { help, sent } = buildHelpMenu({ getHelpCorpus: corpus });
  const named = help.submenu.filter((i) => i.label === 'Clodex Help');

  named[0].click();
  assert.deepStrictEqual(sent, [['request-open-help']]);
  named[1].click();
  assert.deepStrictEqual(sent[1], ['request-open-help'], 'the F1 alias opens the same thing');
});

test('the external links survive, after the page sections', () => {
  const { help } = buildHelpMenu({ getHelpCorpus: corpus });
  const labels = help.submenu.map((i) => i.label);
  assert.ok(labels.includes('Clodex on GitHub'));
  assert.ok(labels.includes('Plugin library (clodex-plugins)'));
  assert.ok(
    labels.indexOf('Peering') < labels.indexOf('Clodex on GitHub')
      || labels.indexOf('Reference') < labels.indexOf('Clodex on GitHub'),
    'the corpus sections come before the external links',
  );
});

test('the corpus is read ONCE per rebuild, not once per page', () => {
  let calls = 0;
  const counting = () => {
    calls += 1;
    return corpus();
  };
  buildHelpMenu({ getHelpCorpus: counting });
  assert.strictEqual(calls, 1, 'three pages across two sections still cost one corpus read');
});

test('a missing or throwing corpus leaves the external links rather than breaking the menu bar', () => {
  for (const [what, dep] of [
    ['no dep', undefined],
    ['null getter', () => null],
    ['throwing getter', () => { throw new Error('no docs in this build'); }],
  ]) {
    const { help } = buildHelpMenu({ getHelpCorpus: dep });
    assert.ok(help, `${what}: the Help menu still builds`);
    assert.strictEqual(help.submenu.filter((i) => Array.isArray(i.submenu)).length, 0, `${what}: no section submenus`);
    const labels = help.submenu.map((i) => i.label);
    assert.ok(labels.includes('Clodex on GitHub'), `${what}: the links survive`);
    assert.ok(labels.includes('Clodex Help'), `${what}: the chord still opens the panel`);
  }
});
