'use strict';

const { pathToFileURL } = require('node:url');

const MAC_LS_DOMAIN = 'com.apple.LaunchServices/com.apple.launchservices.secure';

function defaultBrowserMac(out) {
  const entries = [];
  let cur = null;
  let depth = 0;
  for (const raw of String(out || '').split('\n')) {
    const line = raw.trim();
    if (depth === 1 && cur) {
      const m = /^"?([A-Za-z]+)"?\s*=\s*"?([^";{]*?)"?;$/.exec(line);
      if (m) cur[m[1]] = m[2];
    }
    for (const ch of line) {
      if (ch === '{') {
        depth += 1;
        if (depth === 1) { cur = {}; entries.push(cur); }
      } else if (ch === '}') {
        depth = Math.max(0, depth - 1);
      }
    }
  }
  const row = entries.find((e) => String(e.LSHandlerURLScheme || '').toLowerCase() === 'https' && e.LSHandlerRoleAll);
  return row && /^[A-Za-z0-9.-]+$/.test(row.LSHandlerRoleAll) ? row.LSHandlerRoleAll : null;
}

const succeeds = (p) => Promise.resolve().then(() => p()).then(() => true, () => false);

async function launchInBrowser(tmpPath, { platform, execFile, openExternal, openPath, cache = {} }) {
  const viaFileUrl = () => Promise.resolve().then(() => openExternal(pathToFileURL(tmpPath).href)).then(() => '', (e) => String((e && e.message) || e));
  if (platform === 'darwin') {
    if (!('macBrowser' in cache)) {
      cache.macBrowser = await Promise.resolve().then(() => execFile('defaults', ['read', MAC_LS_DOMAIN, 'LSHandlers']))
        .then((r) => defaultBrowserMac(r && r.stdout), () => null);
    }
    if (cache.macBrowser && await succeeds(() => execFile('open', ['-b', cache.macBrowser, tmpPath]))) return '';
    if (await succeeds(() => execFile('open', ['-a', 'Safari', tmpPath]))) return '';
    return viaFileUrl();
  }
  if (platform === 'linux') {
    const desktop = await Promise.resolve().then(() => execFile('xdg-settings', ['get', 'default-web-browser']))
      .then((r) => String((r && r.stdout) || '').trim(), () => '');
    if (/^[\w.-]+\.desktop$/.test(desktop) && await succeeds(() => execFile('gtk-launch', [desktop, tmpPath]))) return '';
    return openPath(tmpPath);
  }
  return viaFileUrl();
}

module.exports = { defaultBrowserMac, launchInBrowser, MAC_LS_DOMAIN };
