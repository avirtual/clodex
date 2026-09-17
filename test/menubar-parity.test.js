'use strict';
// menubar-parity.test.js (t905) — the web menubar mirrors the Electron app menu
// with NOTHING enforcing the mirror. t904 was the bill: File > Sandboxes… was a
// snapshot of the desktop taken before the desktop deliberately removed it, and
// the File > Plugins… fallback had correct reasoning with a missing condition,
// so both routes to the dialog showed at once. api-contract.js has exactly this
// problem solved by a parity test; the menus did not.
//
// SCOPE, deliberately narrow: Window-menu section ORDER and manage-row PRESENCE
// only. The two trees legitimately differ elsewhere — `Open Log File` and
// `Check for Updates…` are main-process-only and would be WRONG to mirror — so
// this file must never assert top-level-menu-set equality.
//
// THE TRAP THIS FILE AVOIDS: the expected sequence is a LITERAL written below,
// derived from neither tree. A parity test that computes its expectation from
// one file and compares it to the other asserts only that the code agrees with
// itself, and stays green when both halves drift together.
//
// THE SECOND TRAP: two differently-shaped trees are flattened into comparable
// label sequences here (Electron `type:'separator'` / `enabled:false` vs the
// web's `{sep}` / `{disabled}`). Nearly every assertion below is a universal or
// an absence, and all of those are TRUE of an empty set — so a normalizer that
// quietly dropped the header rows would make the whole file vacuously green.
// Hence the `ENTER:` assertions: the interesting rows are proved to have
// SURVIVED normalization before anything is asserted about their order.

const test = require('node:test');
const assert = require('node:assert');
const Module = require('node:module');
const path = require('node:path');

const { buildMenus, buildPluginsMenu } = require('../renderer/web/menubar');
const { recordingCtx } = require('./lib/menubar-ctx');

// ── The literal. Derived from the SPEC, not from either implementation. ──────
//
// Peers header → peer rows (or the `(no peers configured)` placeholder) →
// Manage Peered Clodexes… → Sandboxes header → box rows → Manage Clodex
// Sandboxes…
//
// Token space (see normalize* below): `[X]` is an inert row — a section header
// or a disabled placeholder, which are the SAME shape on the desktop and so are
// deliberately not distinguished; `X ▸` is a row that opens a submenu; a bare
// `X` is a clickable action. Separators carry no parity meaning (the web has one
// extra, cosmetically, before `Manage Peered Clodexes…`) and are dropped, which
// is why the literal names none.

const FRESH_INSTALL = [
  '[Peers]',
  '[(no peers configured)]',
  'Manage Peered Clodexes…',
  'Manage Clodex Sandboxes…',
];

const ONE_PEER_ONE_BOX = [
  '[Peers]',
  '● Peer One ▸',
  'Manage Peered Clodexes…',
  '[Sandboxes]',
  '● Box A ▸',
  'Manage Clodex Sandboxes…',
];

const MANAGE_PEERS = 'Manage Peered Clodexes…';
const MANAGE_SANDBOXES = 'Manage Clodex Sandboxes…';
const PEERS_HEAD = '[Peers]';
const SANDBOXES_HEAD = '[Sandboxes]';

// Two spaces on the desktop's peerEntry, one on the web's peerRow. That gap is
// cosmetic, not structural, so it is normalized away rather than pinned.
const squeeze = (s) => String(s).replace(/\s+/g, ' ').trim();

// An Electron menu template row → one token. A `role` row carries no label (the
// OS fills it), so it becomes an explicit `<role:x>` token instead of vanishing:
// the normalizer must never make a row disappear silently.
function normalizeDesktop(rows) {
  const out = [];
  for (const r of rows || []) {
    if (!r) continue;
    if (r.type === 'separator') continue;
    if (!r.label && r.role) { out.push(`<role:${r.role}>`); continue; }
    const label = squeeze(r.label || '');
    if (r.submenu) out.push(`${label} ▸`);
    else if (r.enabled === false || !r.click) out.push(`[${label}]`);
    else out.push(label);
  }
  return out;
}

// The web bar's row shape → the SAME token space.
function normalizeWeb(rows) {
  const out = [];
  for (const r of rows || []) {
    if (!r) continue;
    if (r.sep) continue;
    if (r.head) { out.push(`[${squeeze(r.head)}]`); continue; }
    const label = squeeze(r.label || '');
    if (r.submenu) out.push(`${label} ▸`);
    else if (r.disabled || !r.run) out.push(`[${label}]`);
    else out.push(label);
  }
  return out;
}

// ── Desktop harness. app-menus.js requires('electron') at module load AND uses
// it while buildAppMenu runs, so the stub must be live for both; follows
// test/app-menus-plugins.test.js's buildTemplateWith. ────────────────────────
function desktopTemplate({ peers = [], boxes = [], pluginHost = null, helpCorpus = null } = {}) {
  let captured = null;
  const win = { webContents: { send: () => {} } };
  const stub = {
    // setAboutPanelOptions is a no-op on purpose: buildAppMenu calls it on mac
    // and the assertions here read the captured template, not the About panel.
    app: { getName: () => 'Clodex', getVersion: () => '0.0.0', setAboutPanelOptions: () => {} },
    BrowserWindow: { getFocusedWindow: () => win, getAllWindows: () => [win] },
    Menu: { buildFromTemplate: (t) => { captured = t; return t; }, setApplicationMenu: () => {} },
    Tray: function Tray() {},
    dialog: {}, shell: {}, nativeImage: { createFromPath: () => ({ setTemplateImage() {} }) },
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
      getManager: nothing,
      // No workspaces: the per-workspace block above the Peers section is not
      // what this file pins, and an empty list keeps the Window tail to exactly
      // the two sections under test.
      getWorkspaces: nothing,
      getPeerManager: () => ({ statuses: () => peers }),
      getSandboxManager: () => ({ list: () => boxes }),
      getUpdateInfo: () => null, getUiSettings: nothing,
      getAgentLibrary: nothing, getSkillLibrary: nothing, getEnvScopes: () => null,
      getPromptLibrary: nothing, getTemplates: nothing, getExecLibrary: nothing,
      getPluginHost: () => pluginHost,
      ...(helpCorpus ? { getHelpCorpus: () => helpCorpus } : {}),
    });
    menus.buildAppMenu();
    return captured || [];
  } finally {
    Module._load = origLoad;
    delete require.cache[require.resolve('../app-menus.js')];
  }
}

const desktopMenu = (template, label) => (template.find((m) => m && m.label === label) || {});

async function webWindowRows({ peers = [], boxes = [] } = {}) {
  const { ctx } = recordingCtx();
  const win = buildMenus({
    ...ctx,
    api: { ...ctx.api, peerList: async () => peers, sandboxListBoxes: async () => boxes },
  }).find((m) => m.label === 'Window');
  return normalizeWeb(await Promise.resolve(win.items()));
}

function desktopWindowRows(opts) {
  return normalizeDesktop(desktopMenu(desktopTemplate(opts), 'Window').submenu);
}

// The section under test is the tail of the Window menu on both. Slicing from
// the Peers header (rather than taking the last N rows) means the assertion also
// catches anything APPENDED after Manage Clodex Sandboxes…, which a
// fixed-length tail comparison would silently tolerate.
function peersSection(tokens, where) {
  const at = tokens.indexOf(PEERS_HEAD);
  assert.notStrictEqual(at, -1,
    `ENTER: ${where} — the Peers header row survived normalization (every order assertion below is vacuous without it)`);
  assert.strictEqual(tokens.filter((t) => t === PEERS_HEAD).length, 1,
    `ENTER: ${where} — exactly one Peers header, so slicing from it is unambiguous`);
  return tokens.slice(at);
}

const PEER_ONE = { id: 'p1', label: 'Peer One', online: true, sessions: [{ name: 'psess' }] };
const BOX_A_REGISTERED = [{ id: 'box-a', label: 'Box A' }];
const BOX_A_STARTED = { id: 'box-a', label: 'Box A', online: true, sessions: [{ name: 'seat' }] };

// ── 1. Section order, both files, against the one literal ───────────────────

test('t905: desktop Window peers/sandboxes section follows the literal order', () => {
  const tokens = desktopWindowRows({ peers: [PEER_ONE, BOX_A_STARTED], boxes: BOX_A_REGISTERED });
  const section = peersSection(tokens, 'desktop');
  assert.ok(section.includes(SANDBOXES_HEAD),
    'ENTER: desktop — the Sandboxes header row survived normalization');
  assert.deepStrictEqual(section, ONE_PEER_ONE_BOX);
});

test('t905: web Window peers/sandboxes section follows the same literal order', async () => {
  const tokens = await webWindowRows({ peers: [PEER_ONE, BOX_A_STARTED], boxes: BOX_A_REGISTERED });
  const section = peersSection(tokens, 'web');
  assert.ok(section.includes(SANDBOXES_HEAD),
    'ENTER: web — the Sandboxes header row survived normalization');
  assert.deepStrictEqual(section, ONE_PEER_ONE_BOX);
});

// ── 2. Manage rows are unconditional on both ────────────────────────────────
//
// The fresh-install state: no peers configured and an EMPTY box registry. This
// is the property t904 relied on — a fresh install whose seed box never started
// still has a menu route to the panel that owns box creation — and the one a
// later "simplify the empty case" edit will try to delete.

test('t905: desktop keeps both manage rows with no peers and an empty box registry', () => {
  const section = peersSection(desktopWindowRows({ peers: [], boxes: [] }), 'desktop fresh install');
  assert.deepStrictEqual(section, FRESH_INSTALL);
  assert.ok(section.includes(MANAGE_PEERS), 'route to the peers panel survives an empty peer list');
  assert.ok(section.includes(MANAGE_SANDBOXES), 'route to the sandbox panel survives an empty registry');
});

test('t905: web keeps both manage rows with no peers and an empty box registry', async () => {
  const section = peersSection(await webWindowRows({ peers: [], boxes: [] }), 'web fresh install');
  assert.deepStrictEqual(section, FRESH_INSTALL);
  assert.ok(section.includes(MANAGE_PEERS), 'route to the peers panel survives an empty peer list');
  assert.ok(section.includes(MANAGE_SANDBOXES), 'route to the sandbox panel survives an empty registry');
});

// ── 3. The Sandboxes HEADER is gated; the manage row beneath it is not ──────
//
// Two rows in the same section with opposite rules is precisely the pair a
// mirror-by-hand gets wrong, so both halves of the pair are asserted in both
// gating states on both trees. A registered box that was never started has no
// peer row (boxList is registry ids ∩ peer ids), which is the ungated state.

const GATING = [
  {
    name: 'a registered box with a peer row shows the header',
    peers: [PEER_ONE, BOX_A_STARTED],
    boxes: BOX_A_REGISTERED,
    header: true,
  },
  {
    name: 'a registered box that never started has no peer row, so no header',
    peers: [PEER_ONE],
    boxes: BOX_A_REGISTERED,
    header: false,
  },
  {
    name: 'an empty registry has no header',
    peers: [PEER_ONE],
    boxes: [],
    header: false,
  },
];

for (const c of GATING) {
  test(`t905: desktop Sandboxes header is gated on boxList, manage row is not — ${c.name}`, () => {
    const section = peersSection(desktopWindowRows(c), 'desktop gating');
    assert.strictEqual(section.includes(SANDBOXES_HEAD), c.header, 'header follows boxList');
    assert.ok(section.includes(MANAGE_SANDBOXES), 'manage row is always-on, whatever the header does');
  });

  test(`t905: web Sandboxes header is gated on boxList, manage row is not — ${c.name}`, async () => {
    const section = peersSection(await webWindowRows(c), 'web gating');
    assert.strictEqual(section.includes(SANDBOXES_HEAD), c.header, 'header follows boxList');
    assert.ok(section.includes(MANAGE_SANDBOXES), 'manage row is always-on, whatever the header does');
  });
}

// ── 4. The Plugins route rule — asymmetric, and pinned as such ──────────────
//
// The two trees have DIFFERENT rules here and this file pins what is TRUE of
// each rather than inventing a symmetry neither has (spec item 4; behaviour is
// unchanged by this ticket).
//
// Web: exactly one route. File > Plugins… is present iff the top-level Plugins
// menu is absent — the zero-plugins state a fresh install is in, where the
// dialog's "Open Plugins Folder" button is the only way to install a first one.
//
// Desktop: the File menu has NO Plugins row in ANY state, so at zero plugins
// there is no route to the dialog at all. That is the fresh-install hole
// docs/notes/renderer-web-menubar.md records — masked in practice because a
// packaged build ships plugins/workbench, so the top-level menu is present.
// Pinned here so that whoever closes the hole has to come through this test.

const HOST_ONE = { status: () => ({ ok: true, plugins: [{ id: 'demo', name: 'Demo', enabled: true }], problems: [] }) };
const HOST_NONE = { status: () => ({ ok: true, plugins: [], problems: [] }) };

const labelsOf = (menu) => (menu.submenu || []).map((r) => r && r.label).filter(Boolean);

// `pluginsTopMenu` is not exported, but it is exactly buildPluginsMenu composed
// with ctx.pluginStatus — so reading buildPluginsMenu here consults the SAME
// null rule the bar's refreshPluginsTop obeys, not a restatement of it.
test('t905: web File > Plugins… is present exactly when the top-level Plugins menu is absent', async () => {
  const route = async (status) => {
    const { ctx } = recordingCtx();
    const withStatus = { ...ctx, pluginStatus: async () => status };
    const file = await Promise.resolve(buildMenus(withStatus).find((m) => m.label === 'File').items());
    return {
      fileRow: normalizeWeb(file).includes('Plugins…'),
      topMenu: !!buildPluginsMenu(status, withStatus),
    };
  };
  const empty = await route({ ok: true, plugins: [], problems: [] });
  assert.deepStrictEqual(empty, { fileRow: true, topMenu: false },
    'zero plugins: no top-level menu, so the File fallback is the route');
  const one = await route({ ok: true, plugins: [{ id: 'demo', name: 'Demo', enabled: true }], problems: [] });
  assert.deepStrictEqual(one, { fileRow: false, topMenu: true },
    'a top-level menu is showing, so the File row would be a second route to the same dialog');
});

test('t905: desktop offers no File > Plugins… route in either state (the fresh-install hole)', () => {
  const withOne = desktopTemplate({ pluginHost: HOST_ONE });
  assert.ok(labelsOf(desktopMenu(withOne, 'File')).length > 0,
    'ENTER: the desktop File menu was found and has rows (an absence is true of an empty menu)');
  assert.ok(withOne.some((m) => m && m.label === 'Plugins'),
    'ENTER: one plugin puts the top-level Plugins menu in the template');
  assert.deepStrictEqual(labelsOf(desktopMenu(withOne, 'File')).filter((l) => /Plugins/.test(l)), []);

  const withNone = desktopTemplate({ pluginHost: HOST_NONE });
  assert.ok(labelsOf(desktopMenu(withNone, 'File')).length > 0,
    'ENTER: the desktop File menu was found and has rows in the zero-plugin state too');
  assert.strictEqual(withNone.some((m) => m && m.label === 'Plugins'), false,
    'zero plugins: the top-level menu is absent by its null rule');
  assert.deepStrictEqual(labelsOf(desktopMenu(withNone, 'File')).filter((l) => /Plugins/.test(l)), [],
    'and File still offers nothing, so the desktop has NO route at zero plugins — unlike the web');
});

const CORPUS_INDEX = {
  sections: [
    { title: 'Guides', pages: [{ name: 'how-to', title: 'How to', headings: [] }, { name: 'teams', title: 'Teams', headings: [] }] },
    { title: 'Reference', pages: [{ name: 'peering', title: 'Peering', headings: [] }] },
  ],
};

const HELP_TREE = [['Guides', ['How to', 'Teams']], ['Reference', ['Peering']]];

test('t989: desktop and web Help menus carry the same section → page tree', async () => {
  const desktop = (desktopMenu(desktopTemplate({ helpCorpus: { index: () => CORPUS_INDEX } }), 'Help').submenu || [])
    .filter((r) => Array.isArray(r.submenu))
    .map((r) => [r.label, r.submenu.map((p) => p.label)]);
  assert.ok(desktop.length > 0, 'ENTER: desktop — the Help menu has section submenus (an equality is vacuous without them)');
  assert.deepStrictEqual(desktop, HELP_TREE);

  const { ctx } = recordingCtx();
  const help = buildMenus({ ...ctx, api: { ...ctx.api, helpIndex: async () => ({ ok: true, ...CORPUS_INDEX }) } })
    .find((m) => m.label === 'Help');
  assert.ok(help, 'ENTER: web — the Help menu exists');
  const rows = await Promise.resolve(help.items());
  const web = [];
  for (const r of rows.filter((x) => x.submenu)) {
    web.push([r.label, (await Promise.resolve(r.submenu())).map((p) => p.label)]);
  }
  assert.ok(web.length > 0, 'ENTER: web — the Help menu has section submenus');
  assert.deepStrictEqual(web, HELP_TREE);
});
