// voice-control.js — the sidebar-footer voice-mode selector: off · tap · hold.
//
// BOX-WIDE, not per-session, and the placement follows from that. `/voice` writes
// `~/.claude/settings.json`, which every Claude session on this machine shares —
// so a control sitting on the per-session proxy bar would look like it scoped to
// the seat under it while silently moving a global. The sidebar footer is also
// the only always-visible home: #proxy-bar is drawn for proxied sessions only,
// which would hide the control on an unproxied box entirely.
//
// STATE COMES FROM THE FILE, never from what we last injected. The user can type
// `/voice hold` in any terminal, so a last-injected mirror goes stale with no
// event to correct it; the read is re-run on window focus and on a slow poll.
// The CLI reads the setting at ITS startup and holds a mode in memory, so a
// long-running session and a freshly-changed file legitimately disagree — the
// label reflects the FILE and the tip says so, rather than claiming per-session
// truth the renderer cannot have.
//
// The WRITE is an injection, not an fs write: a running CLI would not pick up an
// edited file. Injection is quiet-gated (inject-queue parks it until the agent
// is quiet), so the button carries a pending affordance — mid-turn the command
// is queued, not lost, and a control that looked dead meanwhile would invite a
// second click that queues a second command.
//
// DOM-bound, so no unit tests per the R1 rule; the read behind it is
// test/voice-settings.test.js.

const { esc } = require('./lib/format');

const VOICE_ITEMS = [
  { mode: 'off', name: 'Off', desc: 'No voice input' },
  { mode: 'tap', name: 'Tap', desc: 'Tap to start dictating, tap again to stop' },
  { mode: 'hold', name: 'Hold', desc: 'Hold the key while speaking, release to send' },
];

const POLL_MS = 15000;

function createVoiceControl({ getActiveSession, sessionTypeOf, sessionList, showToast }) {
  const btn = document.getElementById('voice-open');
  const labelEl = document.getElementById('voice-label');
  if (!btn || !labelEl) return { refresh() {} };

  let state = null;      // the last read of settings.json
  let pending = null;    // a mode injected but not yet observed in the file
  let menu = null;

  // Which live LOCAL Claude session to inject into: the active tab when it is
  // one, else the first in the sidebar. A peer row is skipped — its `/voice`
  // would move the OTHER machine's settings, which this control does not claim
  // to reflect — as are archived and failed rows, which have no process to type
  // into.
  function injectTarget() {
    const active = getActiveSession();
    if (active && sessionTypeOf(active) === 'claude') return active;
    for (const el of sessionList.querySelectorAll('.session-item[data-type="claude"]')) {
      if (el.dataset.peerUi || el.dataset.failed) continue;
      if (el.classList.contains('archived') || el.classList.contains('peer-item')) continue;
      if (el.dataset.name) return el.dataset.name;
    }
    return null;
  }

  // Ruling 3 (hide for non-Claude) and ruling 5 (disable, never hide, with no
  // live session) are both about a control that cannot act, and they prescribe
  // opposite treatments — so they are split by WHY it cannot: a box with no
  // Claude session at all has no use for the control (hidden, per 3), while a
  // box that has one and cannot reach it right now shows it disabled with the
  // reason (per 5). Hiding the second case is what would flicker.
  function anyClaudeRow() {
    return !!sessionList.querySelector('.session-item[data-type="claude"]');
  }

  function render() {
    if (!anyClaudeRow()) {
      btn.classList.add('hidden');
      return;
    }
    btn.classList.remove('hidden');
    const target = injectTarget();
    const mode = pending || (state && state.effective);
    const known = VOICE_ITEMS.find((i) => i.mode === mode);
    labelEl.textContent = known ? `Voice: ${known.name}` : 'Voice';
    btn.classList.toggle('voice-pending', !!pending);
    btn.disabled = !target;
    btn.dataset.tip = !target
      ? 'Voice input mode (off · tap · hold) — no live Claude session to send /voice to.'
      : pending
        ? `Switching voice to ${pending} — the command is queued until ${target} is between turns.`
        : `Voice input mode for every Claude session on this box${known ? '' : ' — not set yet'}. ` +
          'A session already running keeps the mode it started with until it restarts.';
  }

  async function refresh() {
    let r = null;
    try { r = await window.api.getVoiceMode(); } catch { r = null; }
    if (r && r.ok) {
      state = r;
      // The file caught up with what we injected — drop the pending affordance.
      // Only an EQUAL reading clears it: a differing one means the command has
      // not landed yet, not that it was rejected.
      if (pending && r.effective === pending) pending = null;
    }
    render();
  }

  function closeMenu() { if (menu) { menu.remove(); menu = null; } }

  function openMenu() {
    closeMenu();
    const cur = pending || (state && state.effective);
    menu = document.createElement('div');
    menu.className = 'warm-menu voice-menu';
    const items = ['<div class="warm-menu-label">Voice input (all Claude sessions)</div>'];
    for (const it of VOICE_ITEMS) {
      const isCur = it.mode === cur ? ' strip-cur' : '';
      items.push(`<button class="warm-item strip-item${isCur}" data-mode="${it.mode}">` +
        `<span class="strip-name">${esc(it.name)}${it.mode === cur ? ' ✓' : ''}</span>` +
        `<span class="strip-desc">${esc(it.desc)}</span></button>`);
    }
    // Named so a stale label is legible as staleness rather than read as a bug:
    // the file is the truth, and a session that started earlier is not in it.
    if (state && state.source === 'legacy') {
      items.push('<div class="warm-menu-label">Only the legacy voiceEnabled key is set — pick a mode to set one.</div>');
    }
    menu.innerHTML = items.join('');
    menu.addEventListener('click', async (e) => {
      const item = e.target.closest('.strip-item');
      if (!item) return;
      const mode = item.dataset.mode;
      closeMenu();
      const target = injectTarget();
      if (!target) return;
      pending = mode;
      render();
      let r = null;
      try { r = await window.api.injectPrompt(target, `/voice ${mode}`); } catch (err) { r = { ok: false, error: err.message }; }
      if (!r || !r.ok) {
        pending = null;
        render();
        showToast(`Setting voice to ${mode} failed: ${(r && r.error) || 'unknown error'}`);
        return;
      }
      // The injection is quiet-gated, so the file changes only once the CLI has
      // actually run the command. Re-read on a short delay AND leave the poll to
      // catch a parked one; the pending affordance stands until a read agrees.
      setTimeout(refresh, 1500);
    });
    document.body.appendChild(menu);
    const r = btn.getBoundingClientRect();
    const w = menu.offsetWidth;
    menu.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - w - 8))}px`;
    menu.style.bottom = `${Math.max(8, window.innerHeight - r.top + 6)}px`;
  }

  btn.addEventListener('click', () => { if (menu) closeMenu(); else openMenu(); });
  document.addEventListener('click', (e) => {
    if (!menu) return;
    if (menu.contains(e.target) || e.target.closest('#voice-open')) return;
    closeMenu();
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && menu) closeMenu(); });
  // A `/voice` typed straight into a terminal changes the file with no event of
  // any kind, so focus is the cheapest moment to notice; the poll covers a
  // window that never loses focus.
  window.addEventListener('focus', refresh);
  setInterval(refresh, POLL_MS);
  // Visibility is a function of the session ROWS, and the island owns that watch
  // rather than being re-rendered from renderProxyBar: that runs during restore,
  // before this factory has been called, so a call site there would be a
  // temporal-dead-zone crash on the very path that first populates the list.
  new MutationObserver(render).observe(sessionList, { childList: true, subtree: true });

  refresh();
  return { refresh, render };
}

module.exports = { createVoiceControl, VOICE_ITEMS };
