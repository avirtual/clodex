'use strict';

/**
 * memory-viewer — renderer half. One activation per window; all state lives in
 * this closure. Read-only surface over the memory store the engine half reads.
 */

module.exports.activate = (rhost) => {
  // --- per-window state ----------------------------------------------------

  /** agent name -> count, for the row badge. Refilled by fetchAgents(). */
  const counts = new Map();
  let showRowBadge = true;
  /** the in-flight unforced fetch, joined by later unforced callers */
  let inflight = null;
  /** true once any fetch has succeeded: `counts` is then a complete answer,
   *  so a name missing from it means "no memories", not "not asked yet" */
  let loaded = false;
  let torn = false;

  // The engine's own agents() cache holds for 60s, so a shorter poll here only
  // re-reads the cache, not the disk. Stated in README.md: badge counts may be
  // up to ~2 minutes stale (renderer poll + engine TTL); the overlay never is.
  const POLL_MS = 60 * 1000;

  const alive = () => !torn;

  // --- badge data ----------------------------------------------------------

  /** True if anything the sidebar would render actually differs. */
  function applyAgents(agents) {
    const next = new Map();
    for (const a of agents || []) {
      if (a && a.agent && a.count > 0) next.set(a.agent, a.count);
    }
    let changed = next.size !== counts.size;
    if (!changed) {
      for (const [name, n] of next) {
        if (counts.get(name) !== n) { changed = true; break; }
      }
    }
    counts.clear();
    for (const [name, n] of next) counts.set(name, n);
    return changed;
  }

  /**
   * Resolves to the agent rows, or null if they could not be read — callers
   * render those two differently. A forced read (the overlay) always issues
   * its own invoke: joining a background poll would let a stale or failing
   * one decide what the overlay paints. Concurrent `agents` invokes are
   * idempotent, last write to `counts` wins.
   */
  function fetchAgents(force) {
    if (!alive()) return Promise.resolve(null);
    if (!force) {
      if (inflight) return inflight;
    }
    // The invoke goes through Promise.resolve().then, not called bare: a
    // synchronous throw out of it would otherwise escape into whatever asked —
    // activation, or a sidebar render pass.
    const p = Promise.resolve()
      .then(() => rhost.invoke('agents', { force: !!force }))
      .then((res) => {
        if (!alive() || !res || res.ok !== true) return null;
        loaded = true;
        if (applyAgents(res.agents)) rhost.ui.sidebar.requestRelayout();
        return Array.isArray(res.agents) ? res.agents : [];
      })
      .catch((e) => {
        rhost.log.error('agents fetch failed', e);
        return null;
      })
      .finally(() => {
        // finally, not a tail assignment: a synchronous throw out of invoke()
        // would otherwise latch this forever and kill badge and overlay both.
        if (inflight === p) inflight = null;
      });
    if (!force) inflight = p;
    return p;
  }

  // --- slot: row badge -----------------------------------------------------

  rhost.ui.sidebar.rowBadge({
    id: 'count',
    resolve(sessionName) {
      try {
        if (!showRowBadge) return null;
        if (typeof sessionName !== 'string' || !sessionName) return null;
        const n = counts.get(sessionName);
        if (n === undefined) {
          // One fetch answers for every name at once, so a miss after the
          // first success means "this agent has no memories" — not "not asked
          // yet". Kicking on it would poll forever for the common case;
          // resolve() runs on every render pass. Refreshes are the poll's job.
          if (!loaded) fetchAgents(false);
          return null;
        }
        return { text: String(n), tip: `${n} saved memories`, cls: 'mv-badge' };
      } catch (_) {
        return null;
      }
    },
  });

  // --- overlay -------------------------------------------------------------

  let refresh = null; // assigned by mount; mount always precedes onOpen

  const surface = rhost.ui.surfaces.overlay({
    id: 'main',
    mount(rootEl) { refresh = wire(rootEl); },
    onOpen() { if (refresh) refresh(); },
  });

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    // textContent, never innerHTML: memory bodies and agent names are user
    // content and must render as text.
    if (text !== undefined) e.textContent = text;
    return e;
  }

  function fmtWhen(iso) {
    if (!iso) return '';
    const t = Date.parse(iso);
    if (!Number.isFinite(t)) return String(iso);
    const d = new Date(t);
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  function wire(rootEl) {
    rootEl.innerHTML = '';
    const modal = el('div', 'mv-modal');
    const topbar = el('div', 'mv-topbar');
    topbar.appendChild(el('div', 'mv-title', 'Memories'));
    topbar.appendChild(el('div', 'mv-subtitle', 'read-only'));
    const closeBtn = el('button', 'mv-close', '×');
    closeBtn.title = 'Close';
    closeBtn.addEventListener('click', () => surface.close());
    topbar.appendChild(closeBtn);

    const body = el('div', 'mv-body');
    const agentsPane = el('div', 'mv-agents');
    const unitsPane = el('div', 'mv-units');
    body.appendChild(agentsPane);
    body.appendChild(unitsPane);
    modal.appendChild(topbar);
    modal.appendChild(body);
    rootEl.appendChild(modal);

    let selected = null;

    function renderUnits(agent, units) {
      unitsPane.innerHTML = '';
      if (!units.length) {
        unitsPane.appendChild(el('div', 'mv-empty', `No memories for ${agent}.`));
        return;
      }
      for (const u of units) {
        const card = el('div', u.pinned ? 'mv-unit mv-pinned' : 'mv-unit');
        const head = el('div', 'mv-unit-head');
        if (u.pinned) head.appendChild(el('span', 'mv-pin-mark', 'pinned'));
        if (u.scope) head.appendChild(el('span', 'mv-scope', u.scope));
        head.appendChild(el('span', 'mv-when', fmtWhen(u.learned_at)));
        if (u.source && u.source !== agent) {
          head.appendChild(el('span', 'mv-source', `from ${u.source}`));
        }
        card.appendChild(head);
        card.appendChild(el('div', 'mv-unit-body', u.body));
        unitsPane.appendChild(card);
      }
    }

    async function selectAgent(agent) {
      selected = agent;
      for (const row of agentsPane.querySelectorAll('.mv-agent-row')) {
        row.classList.toggle('mv-selected', row.dataset.mvAgent === agent);
      }
      unitsPane.innerHTML = '';
      unitsPane.appendChild(el('div', 'mv-empty', 'Loading…'));
      let res;
      try {
        res = await rhost.invoke('units', agent);
      } catch (e) {
        rhost.log.error('units fetch failed', e);
        res = null;
      }
      if (!alive() || selected !== agent) return;
      if (!res || res.ok !== true) {
        unitsPane.innerHTML = '';
        unitsPane.appendChild(el('div', 'mv-empty',
          `Could not read memories: ${(res && res.error) || 'unknown error'}`));
        return;
      }
      renderUnits(agent, res.units || []);
    }

    function renderAgents(agents) {
      agentsPane.innerHTML = '';
      if (!agents) {
        // Not the same as an empty store, and the difference is the whole
        // point: one says "nothing saved", the other says "do not believe me".
        agentsPane.appendChild(el('div', 'mv-empty', 'Could not read the memory store.'));
        unitsPane.innerHTML = '';
        return;
      }
      if (!agents.length) {
        agentsPane.appendChild(el('div', 'mv-empty', 'No saved memories.'));
        unitsPane.innerHTML = '';
        return;
      }
      for (const a of agents) {
        const row = el('div', 'mv-agent-row');
        row.dataset.mvAgent = a.agent;
        const dot = el('span', a.live ? 'mv-live mv-live-on' : 'mv-live');
        dot.title = a.live ? 'Session is running' : 'No running session';
        row.appendChild(dot);
        row.appendChild(el('span', 'mv-agent-name', a.agent));
        const meta = a.pinned > 0 ? `${a.count} · ${a.pinned} pinned` : String(a.count);
        row.appendChild(el('span', 'mv-agent-count', meta));
        row.addEventListener('click', () => selectAgent(a.agent));
        agentsPane.appendChild(row);
      }
      if (!selected || !agents.some((a) => a.agent === selected)) {
        selected = agents[0].agent;
      }
      selectAgent(selected);
    }

    // Per-open refresh: force:true so every open re-reads the disk (the
    // freshness bound for the overlay is "as of open", cache-free).
    return async () => {
      agentsPane.innerHTML = '';
      agentsPane.appendChild(el('div', 'mv-empty', 'Loading…'));
      const agents = await fetchAgents(true);
      if (!alive()) return;
      renderAgents(agents);
    };
  }

  // --- slot: footer button -------------------------------------------------

  rhost.ui.sidebar.footerButton({
    id: 'open',
    glyph: '◈',
    label: 'Memories',
    tip: 'Browse agents’ saved memories',
    onClick: () => surface.open(),
  });

  // --- slot: settings ------------------------------------------------------

  rhost.ui.settings.section({
    id: 'prefs',
    title: 'Memory Viewer',
    render(bodyEl, values) {
      bodyEl.innerHTML = '';
      const label = el('label', 'mv-settings-row');
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.setAttribute('data-mv-key', 'showRowBadge');
      cb.checked = !values || values.showRowBadge !== false;
      label.appendChild(cb);
      label.appendChild(el('span', 'mv-settings-label', 'Show unit count on session rows'));
      bodyEl.appendChild(label);
    },
    collect(bodyEl) {
      const cb = bodyEl.querySelector('[data-mv-key="showRowBadge"]');
      if (!cb) return null;
      showRowBadge = !!cb.checked;
      rhost.ui.sidebar.requestRelayout();
      return { showRowBadge: !!cb.checked };
    },
  });

  // --- go ------------------------------------------------------------------

  rhost
    .invoke('settings.get')
    .then((res) => {
      if (!alive()) return;
      if (res && res.ok) showRowBadge = res.values.showRowBadge !== false;
    })
    .catch(() => {});

  fetchAgents(false);
  rhost.setInterval(() => {
    if (typeof document !== 'undefined' && document.hidden) return;
    fetchAgents(false);
  }, POLL_MS);

  // Registration does not paint a rowBadge; without this a live enable shows
  // nothing until an unrelated relayout.
  rhost.ui.sidebar.requestRelayout();

  return () => {
    torn = true;
    counts.clear();
  };
};
