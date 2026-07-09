// banners.js — the two top-of-window notification banners: the update banner
// (click to open the GitHub release) and the spawn-diagnostics banner (surfaces
// a broken-install warning — the usual cause of "posix_spawnp failed." — so
// Finder-launched users who never see stdout still get a pointer to
// `npx electron-rebuild`; click copies the full details for a bug report).
//
// Fully self-contained: only window.api / navigator, no core state. Returns
// refreshDiagBanner, which createSession re-runs after a spawn failure.
//
// DOM-bound, so no unit tests per the R1 rule — move-only fidelity is the
// guarantee.

function initBanners() {
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
  let diagDetails = '';

  async function refreshDiagBanner() {
    try {
      const d = await window.api.getDiagnostics();
      if (d && d.warning) {
        diagText.textContent = d.warning;
        diagDetails = `${d.warning}\n${d.summary}\nhelper=${d.helperPath}`;
        diagBanner.classList.remove('hidden');
      } else {
        diagBanner.classList.add('hidden');
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
