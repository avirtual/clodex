// popovers/session-menus.js — the three floating dropdown menus off the proxy
// bar: keep-warm duration, strip-level, and the per-session history picker
// (past conversations). Unlike the hidden-popover islands these build a
// transient .menu element and remove it on outside-click/Escape. Self-contained
// island: it OWNS its warmMenu/stripMenu/historyMenu element state + wiring.
//
// These are LOCAL session-action menus — no popoverApi. They act via window.api
// directly (proxyHold/wireHold/setAutoCompact/setStripLevel/getSessionHistory/
// restartSession). The restart re-attach dance needs core sessionList/
// createTerminal/addSessionToSidebar/switchSession; proxyState is the live poll
// payload; getActiveSession reads the live active tab (a reassigned core let).
// isWarmMenuOpen/isStripMenuOpen let the bar's toggle dispatch query open-state
// without touching the element (the subagent-popover predicate idiom).
//
// DOM-bound, so no unit tests per the R1 rule — move-only fidelity is the guarantee.

const { esc, shortTs } = require('../lib/format');
const { STRIP_LEVELS } = require('../lib/constants');
const { sessionMenuEntries } = require('../lib/session-actions');

function initSessionMenus({ getActiveSession, proxyState, sessionList, createTerminal, addSessionToSidebar, switchSession }) {
  // --- Keep-warm duration dropdown ----------------------------------------
  // The fire button in the bottom bar opens this; items arm/extend a hold
  // (1h/4h/8h) or stop it. Floats above the button, dismissed on outside-click.
  let warmMenu = null;

  function closeWarmMenu() {
    if (warmMenu) { warmMenu.remove(); warmMenu = null; }
  }

  function openWarmMenu(anchorBtn, held) {
    closeWarmMenu();
    warmMenu = document.createElement('div');
    warmMenu.className = 'warm-menu';
    const items = ['<div class="warm-menu-label">Keep cache warm for</div>'];
    for (const h of [1, 4, 8]) items.push(`<button class="warm-item" data-hours="${h}">${h} hours</button>`);
    if (held) items.push('<button class="warm-item warm-stop" data-act="off">Stop keeping warm</button>');
    // Auto-compact-before-cold lives here because it's the OTHER answer to the
    // same moment as keep-warm: the cache is about to expire. Default on; the
    // authoritative state rides the poll payload (main-side persistence).
    const acOn = proxyState.get(getActiveSession())?.payload?.autoCompact !== false;
    items.push('<div class="warm-menu-label">When cache is about to cool</div>');
    items.push(`<button class="warm-item warm-autocompact" data-act="autocompact" title="With no keep-warm hold and over 100k context, Clodex runs /compact just before the cache expires — compacting while warm re-reads the context at cache prices instead of paying a full cold re-write later.">Auto-compact: ${acOn ? 'on' : 'off'}</button>`);
    warmMenu.innerHTML = items.join('');
    warmMenu.addEventListener('click', async (e) => {
      const item = e.target.closest('.warm-item');
      if (!item || !getActiveSession()) return;
      const name = getActiveSession();
      closeWarmMenu();
      if (item.dataset.act === 'autocompact') {
        await window.api.setAutoCompact(name, !acOn);
        // Optimistic: the poll confirms within 5s, but a re-open shouldn't lie.
        const st = proxyState.get(name);
        if (st && st.payload) st.payload.autoCompact = !acOn;
      } else if (item.dataset.act === 'off') await doWarmHold(name, { off: true });
      else await doWarmHold(name, { hours: Number(item.dataset.hours) });
    });
    document.body.appendChild(warmMenu);
    // Anchor above the button, clamped to the viewport.
    const r = anchorBtn.getBoundingClientRect();
    const w = warmMenu.offsetWidth;
    warmMenu.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - w - 8))}px`;
    warmMenu.style.bottom = `${Math.max(8, window.innerHeight - r.top + 6)}px`;
  }

  // off:true disarms; otherwise arms/extends for opts.hours. Mirrors the prior
  // inline handler (confirm, force-on-not-warm, armed/pending feedback).
  // The hold owner is the payload's choice, not the renderer's: holdSource
  // 'wire' (in-process HoldKeeper, W2 cutover) routes to wire:hold, anything
  // else to the external proxy's /_hold. Same return contract on both.
  function holdApiFor(name) {
    const st = proxyState.get(name);
    return (st && st.payload && st.payload.holdSource === 'wire')
      ? window.api.wireHold : window.api.proxyHold;
  }

  async function doWarmHold(name, opts) {
    const holdApi = holdApiFor(name);
    if (opts.off) {
      const r = await holdApi(name, 0, false);
      if (!r.ok) alert('Disarm hold failed: ' + r.error);
      return;
    }
    const hours = opts.hours;
    if (!confirm(`Keep "${name}" prompt cache warm for ${hours}h?\n\nThe proxy auto-pings to refresh the cache until ${hours}h after the last turn; each ping costs ~1 token.`)) return;
    let r = await holdApi(name, hours, false);
    if (r.ok && !r.armed && r.skipped) {
      if (confirm(`Proxy declined (${r.skipped}): the cache prefix isn't warm yet, so there's nothing to keep warm. Force the hold anyway?`)) {
        r = await holdApi(name, hours, true);
      } else return;
    }
    if (!r.ok) alert('Hold failed: ' + r.error);
    else if (!r.armed) alert('Hold not armed' + (r.skipped ? ` (${r.skipped})` : ''));
    else if (r.body && r.body.pingable === false) {
      alert(`Hold armed for "${name}". It will start keeping the cache warm after the next turn (nothing to ping yet).`);
    }
    // The armed/disarmed state shows on the next poll (≤5s).
  }

  document.addEventListener('click', (e) => {
    if (!warmMenu) return;
    if (warmMenu.contains(e.target)) return;
    if (e.target.closest('.px-hold[data-act="warm-menu"]')) return; // toggle handled by the bar
    closeWarmMenu();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && warmMenu) closeWarmMenu();
  });

  // --- Strip-level dropdown ------------------------------------------------
  // The 🧠 strip button opens this. A cumulative ladder (each level a superset):
  // 0 off · 1 prior-turn thinking · 2 + edit-acks/failed-call stubs. Level 2 is
  // gated on the proxy advertising strip_thinking.max_level>=2 — shown disabled
  // until the L2 build is live, then it lights up automatically. Mirrors keep-warm.
  let stripMenu = null;
  function closeStripMenu() { if (stripMenu) { stripMenu.remove(); stripMenu = null; } }

  function openStripMenu(anchorBtn, currentLevel) {
    closeStripMenu();
    const caps = (getActiveSession() && proxyState.get(getActiveSession())?.payload?.capabilities) || {};
    // L2 folds into strip_thinking as a level; gate on the advertised max_level.
    const toolsAvail = (caps.strip_thinking && caps.strip_thinking.max_level >= 2);
    stripMenu = document.createElement('div');
    stripMenu.className = 'warm-menu strip-menu';
    const items = ['<div class="warm-menu-label">Wire stripping level</div>'];
    for (const s of STRIP_LEVELS) {
      const cur = s.lvl === currentLevel ? ' strip-cur' : '';
      const lock = (s.lvl === 2 && !toolsAvail);
      const dis = lock ? ' disabled' : '';
      const note = lock ? '<span class="strip-soon">coming soon</span>' : `<span class="strip-desc">${esc(s.desc)}</span>`;
      items.push(`<button class="warm-item strip-item${cur}" data-level="${s.lvl}"${dis}>` +
        `<span class="strip-name">${esc(s.name)}${s.lvl === currentLevel ? ' ✓' : ''}</span>${note}</button>`);
    }
    stripMenu.innerHTML = items.join('');
    stripMenu.addEventListener('click', async (e) => {
      const item = e.target.closest('.strip-item');
      if (!item || item.disabled || !getActiveSession()) return;
      const level = Number(item.dataset.level) || 0;
      const name = getActiveSession();
      closeStripMenu();
      if (level === currentLevel) return;
      // Changing strip state on a WARM cache forces a one-time full-window premium
      // re-write: stripped vs unstripped is a maximal prefix byte-difference, so the
      // whole cached message region busts (wirescope measured 95k–261k tokens/flip).
      // It's cheap on a cold cache, and pays off if you KEEP the new level — but
      // flipping back and forth is the most expensive mode of all. So gate it: free
      // when cold, confirm-with-warning when the cache is established/warm.
      const pl = proxyState.get(name)?.payload;
      const warm = pl && pl.warmth ? pl.warmth.state === 'warm' : (pl && pl.turns > 0);
      if (warm && !confirm(
        `Changing the strip level mid-session forces a one-time full-window cache re-write ` +
        `(premium-priced — often 100k–250k tokens). It only pays off if you keep the new level ` +
        `for the rest of this conversation; flipping back and forth is the most expensive option.\n\n` +
        `Set ${(STRIP_LEVELS.find((s) => s.lvl === level) || {}).name || `level ${level}`} now?\n\n` +
        `(Tip: cheapest to set the level on a fresh session, or after /clear when the cache is cold.)`
      )) return;
      const r = await window.api.setStripLevel(name, level);
      if (!r || !r.ok) alert('Change strip level failed: ' + ((r && r.error) || 'unknown error'));
      // New level shows on the next poll (≤5s).
    });
    document.body.appendChild(stripMenu);
    const r = anchorBtn.getBoundingClientRect();
    const w = stripMenu.offsetWidth;
    stripMenu.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - w - 8))}px`;
    stripMenu.style.bottom = `${Math.max(8, window.innerHeight - r.top + 6)}px`;
  }

  document.addEventListener('click', (e) => {
    if (!stripMenu) return;
    if (stripMenu.contains(e.target)) return;
    if (e.target.closest('.px-strip[data-act="strip-menu"]')) return; // toggle handled by the bar
    closeStripMenu();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && stripMenu) closeStripMenu();
  });

  // --- Per-session history picker (past conversations) ---------------------
  // A lightweight dynamic menu (like the warm menu) listing the agent's prior
  // conversations: observed ids first (authoritative — clodex watched them mint
  // on each /clear), then dimmed "inferred" transcripts found in the same project
  // dir but never observed. Picking one restarts the session with --resume <id>,
  // switching it to that conversation; the live one stays re-selectable here.
  let historyMenu = null;
  function closeHistoryMenu() { if (historyMenu) { historyMenu.remove(); historyMenu = null; } }

  function histRelTime(iso) {
    const t = Date.parse(iso || '');
    if (!isFinite(t)) return '';
    const s = (Date.now() - t) / 1000;
    if (s < 60) return 'just now';
    if (s < 3600) return `${Math.floor(s / 60)}m ago`;
    if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
    if (s < 7 * 86400) return `${Math.floor(s / 86400)}d ago`;
    return shortTs(iso);
  }

  async function openHistoryMenu(name, anchorBtn) {
    closeHistoryMenu();
    const res = await window.api.getSessionHistory(name);
    if (getActiveSession() !== name) return; // user switched away while it loaded
    historyMenu = document.createElement('div');
    historyMenu.className = 'history-menu';
    if (!res || !res.ok) {
      historyMenu.innerHTML = '<div class="history-empty">Could not load history.</div>';
    } else if (!res.sessions.length) {
      historyMenu.innerHTML = '<div class="history-empty">No past conversations yet.</div>';
    } else {
      const rows = res.sessions.map((s) => {
        const title = s.title || (s.missing ? 'conversation (transcript gone)' : 'untitled conversation');
        const badges =
          (s.active ? '<span class="history-badge active">active</span>' : '') +
          (s.inferred ? '<span class="history-badge inferred" title="found in the project dir but not observed by clodex — may belong to another agent sharing this cwd">inferred</span>' : '');
        const meta = [s.lastActive ? histRelTime(s.lastActive) : '', s.turns ? `${s.turns} msgs` : '']
          .filter(Boolean).join(' · ');
        const cls = 'history-item' + (s.active ? ' is-active' : '') + (s.inferred ? ' is-inferred' : '');
        const dis = (s.active || s.missing) ? ' data-disabled="1"' : '';
        return `<button class="${cls}"${dis} data-sid="${esc(s.sessionId)}" title="${esc(s.sessionId)}">` +
          `<span class="history-title">${esc(title)}${badges}</span>` +
          `<span class="history-meta">${esc(meta)}</span></button>`;
      }).join('');
      historyMenu.innerHTML = `<div class="history-menu-label">Past conversations — ${esc(name)}</div>` + rows;
    }
    historyMenu.addEventListener('click', async (e) => {
      const item = e.target.closest('.history-item');
      if (!item || item.dataset.disabled) return;
      const sid = item.dataset.sid;
      closeHistoryMenu();
      if (!confirm(`Switch "${name}" to this past conversation?\n\nThe session restarts with --resume on ${sid.slice(0, 8)}…. The current conversation is kept and stays re-selectable here.`)) return;
      const el = sessionList.querySelector(`[data-name="${CSS.escape(name)}"]`);
      const snapType = el ? el.dataset.type || null : null;
      const snapCwd = el ? el.dataset.cwd : null;
      const rr = await window.api.restartSession(name, { resumeId: sid });
      if (!rr || !rr.ok) { alert(`Resume failed: ${rr && rr.error ? rr.error : 'unknown error'}`); return; }
      if (snapType) { createTerminal(name); addSessionToSidebar(name, snapType, snapCwd, null); switchSession(name); }
    });
    document.body.appendChild(historyMenu);
    // Anchor above the button, clamped to the viewport (mirrors the warm menu).
    const r = anchorBtn.getBoundingClientRect();
    const w = historyMenu.offsetWidth;
    historyMenu.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - w - 8))}px`;
    historyMenu.style.bottom = `${Math.max(8, window.innerHeight - r.top + 6)}px`;
  }
  document.addEventListener('click', (e) => {
    if (!historyMenu) return;
    if (historyMenu.contains(e.target)) return;
    // History now opens from the consolidated ⚙ session menu (async, after an
    // await — so the opening click never reaches here), not a standalone toggle
    // button; any outside click, including re-opening the session menu, dismisses.
    closeHistoryMenu();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && historyMenu) closeHistoryMenu();
  });

  // Hard restart: respawn the CLI in a FRESH conversation (no --resume). The CLI
  // snapshots its tool/skill/settings roster at process launch and rebuilds it
  // only when a new conversation is created — /clear and --resume both replay the
  // frozen roster — so this is the one action that picks up an edited settings.json
  // (re-enabled tools, skill changes, MCP, etc.). Not destructive: the prior
  // conversation is preserved on disk and stays resumable via the 🕘 history picker.
  async function doHardRestart(name) {
    if (!confirm(
      `Hard-restart "${name}"?\n\n` +
      `Starts a fresh conversation so the CLI reloads tools, skills, and settings ` +
      `from disk (a plain restart, --resume, or /clear keeps the old roster). ` +
      `The current conversation isn't lost — it stays available under 🕘 history.`
    )) return;
    const el = sessionList.querySelector(`[data-name="${CSS.escape(name)}"]`);
    const snapType = el ? el.dataset.type || null : null;
    const snapCwd = el ? el.dataset.cwd : null;
    const rr = await window.api.restartSession(name, { fresh: true });
    if (!rr || !rr.ok) { alert(`Hard restart failed: ${rr && rr.error ? rr.error : 'unknown error'}`); return; }
    if (snapType) { createTerminal(name); addSessionToSidebar(name, snapType, snapCwd, null); switchSession(name); }
  }

  // --- Consolidated session-actions menu (the `⚙ session ▾` bar button) ------
  // Replaces the old row of standalone launcher buttons (tools/skills/agents/
  // edit/history/reload) with one button + this menu, freeing the proxy bar for
  // dynamic state (📄 files, keep-warm, context/cost). Entries come from the pure
  // session-actions leaf (type-conditioned); picking one fires onPick(act) — the
  // core (renderer.js) owns the act→opener routing because the openers span two
  // islands (checklist-popovers + this one) plus a core dialog. Same transient-
  // menu idiom as the strip/history menus.
  let sessionMenu = null;
  function closeSessionMenu() { if (sessionMenu) { sessionMenu.remove(); sessionMenu = null; } }

  function openSessionMenu(anchorBtn, type, onPick) {
    closeSessionMenu();
    const entries = sessionMenuEntries(type);
    if (!entries.length) return;
    sessionMenu = document.createElement('div');
    sessionMenu.className = 'warm-menu session-menu';
    sessionMenu.innerHTML = entries
      .map((en) => `<button class="warm-item session-item" data-act="${en.act}">${esc(en.label)}</button>`)
      .join('');
    sessionMenu.addEventListener('click', (e) => {
      const item = e.target.closest('.session-item');
      if (!item) return;
      const act = item.dataset.act;
      closeSessionMenu();
      if (typeof onPick === 'function') onPick(act, anchorBtn);
    });
    document.body.appendChild(sessionMenu);
    const r = anchorBtn.getBoundingClientRect();
    const w = sessionMenu.offsetWidth;
    sessionMenu.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - w - 8))}px`;
    sessionMenu.style.bottom = `${Math.max(8, window.innerHeight - r.top + 6)}px`;
  }

  document.addEventListener('click', (e) => {
    if (!sessionMenu) return;
    if (sessionMenu.contains(e.target)) return;
    if (e.target.closest('.px-action[data-act="session-menu"]')) return; // toggle handled by the bar
    closeSessionMenu();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && sessionMenu) closeSessionMenu();
  });

  // Open-state predicates for the bar's toggle dispatch — it used to read the
  // warmMenu/stripMenu element vars directly; the island exposes them instead of
  // leaking the state (the subagent-popover predicate idiom).
  const isWarmMenuOpen = () => !!warmMenu;
  const isStripMenuOpen = () => !!stripMenu;
  const isSessionMenuOpen = () => !!sessionMenu;

  return {
    openWarmMenu, closeWarmMenu, isWarmMenuOpen,
    openStripMenu, closeStripMenu, isStripMenuOpen,
    openSessionMenu, closeSessionMenu, isSessionMenuOpen,
    openHistoryMenu, doHardRestart,
  };
}

module.exports = { initSessionMenus };
