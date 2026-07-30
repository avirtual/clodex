'use strict';

/**
 * memory-viewer — renderer half. One activation per window; all state lives in
 * this closure. Displays the memory store, with exactly one mutation: delete.
 *
 * Pull-on-open, with no ambient state: nothing is fetched until the overlay is
 * opened. A session-row badge was removed deliberately — a standing count is
 * not something a user needs at all times, and carrying one is what forced a
 * poll, a cache and a staleness bound onto a surface that otherwise has none.
 */

function fmtWhen(iso) {
  if (!iso) return '';
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return String(iso);
  const d = new Date(t);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * The text the user actually decides on, and the ONLY safeguard on an
 * irreversible unlink — hence module scope, so it can be asserted directly.
 *
 * An id is unidentifiable: confirming `mem-1785440884251-q4d5j2` is confirming
 * a string, so the body leads. The pinned state is its own line, never folded
 * into the body text — a pinned unit is served in full to every new session of
 * that agent, so deleting one is a bigger decision than deleting an index
 * entry.
 */
function confirmText(agent, u) {
  const MAX_CHARS = 400;
  const MAX_LINES = 12;
  // Collapsed before interpolation: these land OUTSIDE the fence, in the region
  // the fence declares trustworthy, and a filename may legally contain a
  // newline. Same reasoning as the fence itself.
  const flat = (v) => String(v ?? '').replace(/\s+/g, ' ').trim();
  const key = flat(u.key);
  const id = flat(u.id);
  let body = String(u.body || '');
  let clipped = body.length > MAX_CHARS;
  if (clipped) body = body.slice(0, MAX_CHARS);
  // Lines as well as characters: 400 characters of short lines is ~200 dialog
  // lines, which pushes the trailer and the buttons off-screen — and a dialog
  // whose "This cannot be undone." is not visible is not a safeguard.
  const lines = body.split('\n');
  if (lines.length > MAX_LINES) { body = lines.slice(0, MAX_LINES).join('\n'); clipped = true; }
  if (clipped) body += '\n…';

  const out = [`Delete this memory from ${flat(agent)}?`, ''];
  if (u.pinned) out.push('THIS UNIT IS PINNED — it is served in full to every new session of this agent.', '');
  if (u.idMismatch) out.push(`Note: this unit's id line says "${id}" but its filename is "${key}". The filename is what gets deleted.`, '');
  // Fenced: an unfenced body ending in `saved: …` or `This cannot be undone.`
  // would impersonate the dialog's own metadata, and the user cannot tell which
  // lines are the app talking and which are the memory.
  out.push('----- memory -----', body || '(empty)', '------------------', '');
  if (u.scope) out.push(`scope: ${flat(u.scope)}`);
  out.push(`file: ${key}`);
  out.push(`saved: ${fmtWhen(u.learned_at) || 'unknown'}`, '');
  out.push('This cannot be undone.');
  return out.join('\n');
}

/**
 * A failed delete, in words the user can act on.
 *
 * This surface lists every `*.md` with frontmatter, but core only deletes units
 * matching its own id grammar, so a hand-authored `project-notes.md` gets a
 * button, a confirmation, and then a refusal. The grammar is deliberately NOT
 * mirrored here — a second copy would drift from core's — so the refusal is
 * translated after the fact instead.
 */
function deleteErrorText(res) {
  const raw = (res && res.error) || 'unknown error';
  if (/^invalid unit id\b/.test(raw)) {
    return 'This file was not created by [agent:memory remember], so Clodex will not delete it from here. Remove it by hand if you meant to.';
  }
  return `Could not delete: ${raw}`;
}

module.exports.confirmText = confirmText;
module.exports.deleteErrorText = deleteErrorText;

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

  function wire(rootEl) {
    rootEl.innerHTML = '';
    const modal = el('div', 'mv-modal');
    const topbar = el('div', 'mv-topbar');
    topbar.appendChild(el('div', 'mv-title', 'Memories'));
    topbar.appendChild(el('div', 'mv-subtitle', 'bodies on disk — deleting is permanent'));
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
    let selectSeq = 0;
    let reloadSeq = 0;

    async function deleteUnit(agent, u, btn) {
      // Re-entrancy guard: a double-click would otherwise raise two dialogs and
      // fire a second forget that fails with `no unit`, reading as a broken
      // delete rather than a duplicate one.
      if (btn.disabled) return;
      btn.disabled = true;
      try {
        // The same primitive core and the workbench pilot use; a custom modal
        // here would be a second confirmation idiom for no gain.
        if (!confirm(confirmText(agent, u))) return;
        let res;
        try {
          // u.key, NOT u.id: core resolves a unit as `<dir>/<key>.md`, so the
          // basename is what gets unlinked. Deleting by the `id:` frontmatter
          // would aim at a different file than the one just confirmed.
          res = await rhost.invoke('forget', { agent, id: u.key });
        } catch (e) {
          rhost.log.error('forget failed', e);
          res = null;
        }
        if (!alive()) return;
        if (!res || res.ok !== true) {
          rhost.ui.showToast(deleteErrorText(res), { kind: 'error' });
          return;
        }
        // Full reload, not just dropping the card: the agent list's counts are
        // derived from the store, and the overlay's stated freshness bound is
        // "as of open" — leaving `12 · 3 pinned` beside a pane showing 11 breaks
        // the one guarantee this surface makes.
        await reload();
      } finally {
        if (alive() && btn.isConnected) btn.disabled = false;
      }
    }

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
        if (u.idMismatch) {
          const warn = el('span', 'mv-id-mismatch', `id≠file (${u.key})`);
          warn.title = `The id line says "${u.id}" but the file is "${u.key}". Deleting removes the file.`;
          head.appendChild(warn);
        }
        const del = el('button', 'mv-delete', '✕');
        // u.key, never u.id: a unit with no `id:` line would otherwise label
        // itself `Delete ` — and the label must name what actually gets deleted.
        del.title = `Delete ${u.key}`;
        del.setAttribute('aria-label', `Delete memory ${u.key}`);
        // The promise is discarded, so it needs its own catch: an unhandled
        // rejection out of a click handler is invisible to the user.
        del.addEventListener('click', () => {
          deleteUnit(agent, u, del).catch((e) => rhost.log.error('delete failed', e));
        });
        head.appendChild(del);
        card.appendChild(head);
        card.appendChild(el('div', 'mv-unit-body', u.body));
        unitsPane.appendChild(card);
      }
    }

    async function selectAgent(agent) {
      // A monotonic token, not `selected !== agent`: agent identity cannot tell
      // two requests for the SAME agent apart, and deleteUnit's reload makes
      // that collision reachable — delete, then click the same row while forget
      // is in flight, and the slower fetch wins, painting a ghost card for a
      // unit that is gone.
      const my = ++selectSeq;
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
      if (!alive() || my !== selectSeq) return;
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

    // Named because deleteUnit re-runs it: a delete changes the agent list's
    // counts, not just the unit pane.
    async function reload() {
      // Its own token, matching selectSeq: two overlapping reloads can otherwise
      // repaint pre-delete COUNTS while selectSeq keeps the units pane correct,
      // leaving the two panes disagreeing about the same store.
      const my = ++reloadSeq;
      agentsPane.innerHTML = '';
      agentsPane.appendChild(el('div', 'mv-empty', 'Loading…'));
      const agents = await fetchAgents();
      if (!alive() || my !== reloadSeq) return;
      renderAgents(agents);
    }

    return reload;
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
