// themes.js — theme application + switching. Chrome retints via CSS
// [data-theme]; each theme also carries an xterm color object (the terminal
// palette lives in JS, not CSS). Owns the persisted-theme read, the pre-paint
// chrome attr, the Preferences picker, and the cross-window onSetTheme sync.
//
// FACTORY (R2): applyTheme live-swaps every open terminal's palette, so it
// needs the sessions Map — the one cross-island reach-in, passed as a factory
// param (named `sessions`, so applyTheme's body stays byte-identical). Returns
// currentXtermTheme, which createSession reads at terminal creation. THEMES is
// imported from lib/constants (it is used nowhere else in renderer.js).
//
// DOM/localStorage-bound, so no unit tests per the R1 rule — move-only fidelity
// is the guarantee.

const { THEMES } = require('./lib/constants');

function initThemes({ sessions }) {
  const THEME_DEFAULT = 'midnight';
  function themeName() {
    const t = localStorage.getItem('clodex-theme');
    return THEMES[t] ? t : THEME_DEFAULT;
  }
  function currentXtermTheme() { return THEMES[themeName()].xterm; }
  // Apply a theme: retint chrome (data-theme), persist, and live-swap every
  // open terminal's palette. Midnight clears the attr so :root wins.
  function applyTheme(name) {
    if (!THEMES[name]) name = THEME_DEFAULT;
    localStorage.setItem('clodex-theme', name);
    if (name === THEME_DEFAULT) delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = name;
    for (const s of sessions.values()) {
      if (s.terminal) s.terminal.options.theme = THEMES[name].xterm;
    }
    const sel = document.getElementById('prefs-theme');
    if (sel && sel.value !== name) sel.value = name; // keep the picker in sync
  }
  // Set the chrome attr before first paint (terminals read currentXtermTheme()
  // at creation, so they're correct without a re-swap).
  (function initTheme() {
    const n = themeName();
    if (n !== THEME_DEFAULT) document.documentElement.dataset.theme = n;
  })();
  // Populate the Preferences theme picker once; apply live on change.
  (function setupThemePicker() {
    const sel = document.getElementById('prefs-theme');
    if (!sel) return;
    sel.innerHTML = Object.entries(THEMES)
      .map(([k, t]) => `<option value="${k}">${t.label}</option>`).join('');
    sel.value = themeName();
    sel.addEventListener('change', () => { applyTheme(sel.value); window.api.setTheme(sel.value); });
  })();
  // Apply theme changes pushed from the View menu / other windows, and report
  // our persisted theme up to main so the menu radio + canonical settings match
  // the value we applied pre-paint (covers first run on this machine).
  window.api.onSetTheme((name) => applyTheme(name));
  try { window.api.setTheme(themeName()); } catch {}

  return { currentXtermTheme };
}

module.exports = { initThemes };
