'use strict';

/**
 * memory-viewer — renderer half. One activation per window; all state lives in
 * this closure. Read-only surface over the memory store the engine half reads.
 *
 * Pull-on-open, with no ambient state: nothing is fetched until the overlay is
 * opened. A session-row badge was removed deliberately — a standing count is
 * not something a user needs at all times, and carrying one is what forced a
 * poll, a cache and a staleness bound onto a surface that otherwise has none.
 */

module.exports.activate = (rhost) => {
  let torn = false;

  const alive = () => !torn;

  /**
   * Resolves to the agent rows, or null if they could not be read — callers
   * render those two differently. Every call re-reads the disk: the overlay's
   * freshness bound is "as of open", which is only true if nothing caches.
   */
  function fetchAgents() {
    if (!alive()) return Promise.resolve(null);
    // Through Promise.resolve().then, not called bare: a synchronous throw out
    // of invoke() would otherwise escape into whoever asked.
    return Promise.resolve()
      .then(() => rhost.invoke('agents'))
      .then((res) => {
        if (!alive() || !res || res.ok !== true) return null;
        return Array.isArray(res.agents) ? res.agents : [];
      })
      .catch((e) => {
        rhost.log.error('agents fetch failed', e);
        return null;
      });
  }

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

    return async () => {
      agentsPane.innerHTML = '';
      agentsPane.appendChild(el('div', 'mv-empty', 'Loading…'));
      const agents = await fetchAgents();
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

  return () => { torn = true; };
};
