// banners.js — the two top-of-window notification banners: the update banner
// (click to open the GitHub release) and the spawn-diagnostics banner (surfaces
// a broken-install warning — the usual cause of "posix_spawnp failed." — so
// Finder-launched users who never see stdout still get a pointer to
// `npx electron-rebuild`; click copies the full details for a bug report).
//
// Mostly self-contained: window.api / navigator + an injected openInstallSession
// (so the both-CLIs-missing banner can offer Install buttons, Task 18). Returns
// refreshDiagBanner, which createSession re-runs after a spawn failure.
//
// DOM-bound, so no unit tests per the R1 rule — move-only fidelity is the
// guarantee. The Install-button DECISION (which CLIs, cliMissingIsCause) is the
// tested tool-gate leaf + the diagnostics payload; this only plumbs it.

const { agentInstallButtons } = require('./lib/tool-gate');

function initBanners({ openInstallSession } = {}) {
  // ---- Update banner ----
  const updateBanner = document.getElementById('update-banner');
  const updateText = document.getElementById('update-text');

  function showUpdateBanner(info) {
    updateText.textContent = `Update available: v${info.version}`;
    updateBanner.classList.remove('hidden');
  }

  updateBanner.addEventListener('click', () => {
    window.api.openUpdate();
  });

  // Check if an update was already detected before the renderer loaded
  window.api.getUpdateInfo().then((info) => { if (info) showUpdateBanner(info); });

  // Listen for updates detected while running
  window.api.onUpdateAvailable((info) => showUpdateBanner(info));

  // ---- Spawn diagnostics banner ----
  const diagBanner = document.getElementById('diag-banner');
  const diagText = document.getElementById('diag-text');
  const diagActions = document.getElementById('diag-actions');
  let diagDetails = '';

  // Offer Install buttons only when a missing agent CLI is the warning's ACTUAL
  // cause (cliMissingIsCause, from the diagnostics payload — single-sources
  // engine.diagWarning's precedence). A helper/arch/PATH warning gets no buttons:
  // installing a CLI wouldn't fix it. Best-effort — a probe throw leaves the
  // banner as text-only.
  async function refreshDiagInstallButtons(cliMissingIsCause) {
    if (!diagActions) return;
    diagActions.textContent = '';
    if (!cliMissingIsCause || typeof openInstallSession !== 'function') return;
    let check = null;
    try { check = await window.api.toolsCheck(); } catch { check = null; }
    for (const install of agentInstallButtons(check)) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'tool-install-btn';
      btn.textContent = install.label;
      btn.title = `Run: ${install.command}`;
      // The banner itself copies diagnostics on click — don't let a button do that.
      btn.addEventListener('click', (e) => { e.stopPropagation(); openInstallSession(install); });
      diagActions.appendChild(btn);
    }
  }

  async function refreshDiagBanner() {
    try {
      const d = await window.api.getDiagnostics();
      if (d && d.warning) {
        diagText.textContent = d.warning;
        diagDetails = `${d.warning}\n${d.summary}\nhelper=${d.helperPath}`;
        diagBanner.classList.remove('hidden');
        refreshDiagInstallButtons(d.cliMissingIsCause);
      } else {
        diagBanner.classList.add('hidden');
        if (diagActions) diagActions.textContent = '';
      }
    } catch { /* diagnostics are best-effort */ }
  }

  // Clicking copies the full details so users can paste them into a bug report.
  diagBanner.addEventListener('click', () => {
    if (!diagDetails) return;
    navigator.clipboard.writeText(diagDetails).then(() => {
      const prev = diagText.textContent;
      diagText.textContent = 'Copied diagnostics to clipboard';
      setTimeout(() => { diagText.textContent = prev; }, 1500);
    }).catch(() => {});
  });

  refreshDiagBanner();

  return { refreshDiagBanner };
}

module.exports = { initBanners };
