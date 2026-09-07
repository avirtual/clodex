// The plugin library repo is reachable by click from two places: the library
// note in the plugins dialog, and the Help menu. Both go through openExternal
// rather than an href, because the desktop has no setWindowOpenHandler and a
// _blank anchor opens a chromeless BrowserWindow instead of the user's browser
// (the reason is spelled out at renderer.js's sbOpenLink). These are source-shape
// pins: the markup and the menu template are both static text, and no runtime
// fixture in this suite builds an Electron menu or a DOM from index.html.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

const PLUGINS_URL = 'https://github.com/avirtual/clodex-plugins';

test('the library note carries an hrefless anchor to the plugins repo', () => {
  const html = fs.readFileSync(path.join(ROOT, 'renderer', 'index.html'), 'utf8');
  const head = html.match(/<div id="plugins-library-head"[^>]*>([\s\S]*?)<\/div>/);
  assert.ok(head, 'the head element must exist');
  const anchor = head[1].match(/<a id="plugins-library-repo-link"[^>]*>/);
  assert.ok(anchor, 'the repo link must live inside the library note, not somewhere else in the dialog');
  assert.ok(anchor[0].includes(`data-url="${PLUGINS_URL}"`),
    'the url the click opens is read from data-url, so it must be the plugins repo');
  assert.ok(!/\shref=/.test(anchor[0]),
    'an href is clickable around openExternal: on the desktop it opens a chromeless BrowserWindow, '
    + 'and on web the open-external fan is also the gate that refuses a box-loopback url');
  assert.ok(anchor[0].includes('role="button"') && anchor[0].includes('tabindex="0"'),
    'an hrefless anchor is not focusable and is not announced as a control without both');
});

test('the repo link is painted as a link', () => {
  const css = fs.readFileSync(path.join(ROOT, 'renderer', 'styles.css'), 'utf8');
  assert.ok(/#plugins-library-repo-link\s*\{[^}]*cursor:\s*pointer/.test(css),
    'there is no generic `a` rule in this stylesheet and the anchor has no href, so without this the '
    + 'link renders as prose with a text cursor — the "nowhere to click" the ticket is about');
  assert.ok(/#plugins-library-repo-link\s*\{[^}]*color:\s*var\(--accent\)/.test(css),
    'nothing else distinguishes it from the sentence around it');
});

test('the library note routes the repo link through openExternal, keyboard included', () => {
  const src = fs.readFileSync(path.join(ROOT, 'renderer', 'renderer.js'), 'utf8');
  assert.ok(/pluginsLibraryRepoLink\s*=\s*document\.getElementById\('plugins-library-repo-link'\)/.test(src),
    'the handler must bind the id the markup ships');
  assert.ok(/pluginsLibraryRepoLink\.addEventListener\('click',[\s\S]{0,200}?window\.api\.openExternal\(pluginsLibraryRepoLink\.dataset\.url\)/.test(src),
    'the click must open the data-url through openExternal');
  assert.ok(/pluginsLibraryRepoLink\.addEventListener\('keydown',[\s\S]{0,200}?e\.key === 'Enter' \|\| e\.key === ' '/.test(src),
    'an anchor with no href does not synthesize a click on Enter, and role="button" promises Space too');
});

test('a Help menu points at both repos', () => {
  const src = fs.readFileSync(path.join(ROOT, 'app-menus.js'), 'utf8');
  assert.ok(/CLODEX_REPO_URL = 'https:\/\/github\.com\/avirtual\/clodex'/.test(src));
  assert.ok(new RegExp(`CLODEX_PLUGINS_REPO_URL = '${PLUGINS_URL.replace(/[./]/g, '\\$&')}'`).test(src));
  const help = src.match(/\{\s*label: 'Help',\s*role: 'help',\s*submenu: \[([\s\S]*?)\],\s*\},/);
  assert.ok(help, "the Help entry must carry role: 'help' — macOS files the search field under that role");
  assert.ok(/label: 'Clodex on GitHub', click: \(\) => shell\.openExternal\(CLODEX_REPO_URL\)/.test(help[1]),
    'the app repo item must route through shell.openExternal');
  assert.ok(/label: 'Plugin library \(clodex-plugins\)', click: \(\) => shell\.openExternal\(CLODEX_PLUGINS_REPO_URL\)/.test(help[1]),
    'the plugin library item must route through shell.openExternal');
});
