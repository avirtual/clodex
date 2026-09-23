'use strict';

function defaultAddonClass() {
  return require('@xterm/addon-webgl').WebglAddon;
}

function loadWebglIfEnabled(terminal, enabled, { Addon = null, warn = null } = {}) {
  if (enabled !== true || !terminal) return null;
  const log = warn || ((msg, err) => console.warn(msg, err));
  let addon = null;
  try {
    const Ctor = Addon || defaultAddonClass();
    addon = new Ctor();
    addon.onContextLoss(() => addon.dispose());
    terminal.loadAddon(addon);
    return addon;
  } catch (err) {
    if (addon) {
      try { addon.dispose(); } catch {}
    }
    log('WebGL terminal renderer unavailable; using the DOM renderer', err);
    return null;
  }
}

module.exports = { loadWebglIfEnabled };
