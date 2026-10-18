'use strict';

const test = require('node:test');
const assert = require('node:assert');
const Module = require('node:module');
const path = require('node:path');

function loadAppMenus() {
  const stub = {
    app: { getName: () => 'Clodex', getVersion: () => '0.0.0', setAboutPanelOptions: () => {} },
    BrowserWindow: { getFocusedWindow: () => null, getAllWindows: () => [] },
    Menu: { buildFromTemplate: (t) => t, setApplicationMenu: () => {} },
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
    return require('../app-menus.js').createAppMenus;
  } finally {
    Module._load = origLoad;
    delete require.cache[require.resolve('../app-menus.js')];
  }
}

function rig({ windowExists }) {
  const events = [];
  const win = {
    show: () => events.push(['show']),
    focus: () => events.push(['focus']),
    webContents: {
      send: (...a) => events.push(['send', ...a]),
      once: (ev, fn) => { events.push(['once', ev]); fn(); },
    },
  };
  const seat = { name: 'alice', type: 'claude', workspaceId: 'w2' };
  const manager = {
    sessions: new Map([['alice', seat]]),
    list: () => [seat],
    allLiveWindows: () => [win],
    windowForWorkspace: (ws) => { events.push(['windowFor', ws]); return windowExists ? win : null; },
  };
  const workspaces = {
    list: () => [{ id: 'w2', name: 'Two' }],
    setView: (ws, v) => events.push(['setView', ws, v]),
  };
  const nothing = () => ({ list: () => [], get: () => ({}), sortedByRecent: () => [], statuses: () => [] });
  const createAppMenus = loadAppMenus();
  const menus = createAppMenus({
    DEFAULT_WORKSPACE_ID: 'default', LOG_FILE: '/dev/null', THEME_KEYS: [], path,
    checkForUpdate: () => {}, confirmRestartClodex: () => {},
    createWindow: (ws) => { events.push(['createWindow', ws]); return win; },
    getManager: () => manager, getPeerManager: () => null, getSandboxManager: () => null,
    getUpdateInfo: () => null, getUiSettings: nothing, getWorkspaces: () => workspaces,
    getAgentLibrary: nothing, getSkillLibrary: nothing, getEnvScopes: () => null,
    getPromptLibrary: nothing, getTemplates: nothing, getExecLibrary: nothing,
    getPluginHost: () => null,
  });
  return { menus, events };
}

function trayClick(menus) {
  const item = menus.buildTrayMenu().find((i) => i && typeof i.label === 'string' && i.label.includes('alice (claude)'));
  assert.ok(item, 'ENTER: the tray lists the seat');
  item.click();
}

for (const windowExists of [true, false]) {
  test(`tray seat click and revealSession run one code path (window ${windowExists ? 'open' : 'absent'})`, () => {
    const viaTray = rig({ windowExists });
    trayClick(viaTray.menus);
    const viaReveal = rig({ windowExists });
    assert.deepStrictEqual(viaReveal.menus.revealSession('alice'), { ok: true });
    assert.ok(viaTray.events.some((e) => e[0] === 'send' && e[1] === 'request-switch-session' && e[2] === 'alice'),
      'ENTER: the tray click switched to the seat');
    assert.deepStrictEqual(viaTray.events, viaReveal.events);
  });
}

test('the tray seat click body is a call to revealSession', () => {
  const src = require('node:fs').readFileSync(path.join(__dirname, '..', 'app-menus.js'), 'utf8');
  assert.match(src, /click: \(\) => revealSession\(s\.name\),/);
  assert.strictEqual(src.split("'request-switch-session'").length - 1, 1, 'request-switch-session is sent from one place');
});

test('revealSession refuses an unknown seat', () => {
  const { menus, events } = rig({ windowExists: true });
  assert.deepStrictEqual(menus.revealSession('ghost'), { ok: false, error: 'no session named ghost' });
  assert.deepStrictEqual(events, []);
});
