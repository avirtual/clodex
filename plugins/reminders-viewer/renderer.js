'use strict';

const PREVIEW_CHARS = 60;

function fmtNextFire(row, timeZone) {
  if (!row || row.kind === 'oncompact') return 'on compact';
  if (typeof row.nextFireAt !== 'number' || !Number.isFinite(row.nextFireAt)) return '';
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit',
    timeZoneName: 'short',
  });
  const p = {};
  for (const part of fmt.formatToParts(new Date(row.nextFireAt))) p[part.type] = part.value;
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute} ${p.timeZoneName}`;
}

function preview(body) {
  const flat = String(body ?? '').replace(/\s+/g, ' ').trim();
  return flat.length > PREVIEW_CHARS ? `${flat.slice(0, PREVIEW_CHARS - 1)}…` : flat;
}

function visibleRows(rows, activeSeat, showAll) {
  if (showAll || !activeSeat) return rows.slice();
  return rows.filter((r) => r.agent === activeSeat);
}

module.exports.fmtNextFire = fmtNextFire;
module.exports.preview = preview;
module.exports.visibleRows = visibleRows;

module.exports.activate = (rhost) => {
  let torn = false;
  const alive = () => !torn;
  let refresh = null;

  const surface = rhost.ui.surfaces.overlay({
    id: 'main',
    mount(rootEl) { refresh = wire(rootEl); },
    onOpen() { if (refresh) return refresh(); return undefined; },
  });

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }

  function fetchRows() {
    if (!alive()) return Promise.resolve(null);
    return Promise.resolve()
      .then(() => rhost.invoke('list', rhost.workspaceId))
      .then((res) => {
        if (!alive()) return null;
        if (!res || res.ok !== true) return { error: (res && res.error) || 'unknown error' };
        return { rows: Array.isArray(res.rows) ? res.rows : [] };
      })
      .catch((e) => {
        rhost.log.error('list failed', e);
        return { error: 'the reminder list could not be read' };
      });
  }

  function wire(rootEl) {
    rootEl.innerHTML = '';
    const modal = el('div', 'rv-modal');
    const topbar = el('div', 'rv-topbar');
    topbar.appendChild(el('div', 'rv-title', 'Reminders'));
    const hint = el('div', 'rv-subtitle', '');
    topbar.appendChild(hint);
    const toggle = el('button', 'rv-toggle', 'All Seats');
    topbar.appendChild(toggle);
    const closeBtn = el('button', 'rv-close', '×');
    closeBtn.title = 'Close';
    closeBtn.addEventListener('click', () => surface.close());
    topbar.appendChild(closeBtn);
    modal.appendChild(topbar);
    const body = el('div', 'rv-body');
    modal.appendChild(body);
    rootEl.appendChild(modal);

    let showAll = false;
    let rows = [];
    let seq = 0;

    toggle.addEventListener('click', () => {
      showAll = !showAll;
      render();
    });

    function render() {
      const active = rhost.sessions.active();
      const all = showAll || !active;
      toggle.textContent = showAll ? 'Selected Seat' : 'All Seats';
      hint.textContent = all ? 'All seats in this workspace' : `Showing ${active}`;
      const shown = visibleRows(rows, active, showAll);
      body.innerHTML = '';
      if (!shown.length) {
        body.appendChild(el('div', 'rv-empty', all ? 'No reminders armed in this workspace' : `No reminders armed by ${active}`));
        return;
      }
      const table = el('table', 'rv-table');
      const head = el('tr', 'rv-head');
      for (const h of ['SEAT', 'KIND', 'SPEC', 'NEXT FIRE', 'TEXT', 'TICKET', '']) head.appendChild(el('th', '', h));
      table.appendChild(head);
      for (const r of shown) table.appendChild(renderRow(r));
      body.appendChild(table);
    }

    function renderRow(r) {
      const tr = el('tr', 'rv-row');
      const seat = el('td', r.live ? 'rv-seat' : 'rv-seat rv-seat-inactive', r.agent);
      if (!r.live) seat.title = 'Seat not running';
      tr.appendChild(seat);
      tr.appendChild(el('td', 'rv-kind', r.kind));
      tr.appendChild(el('td', 'rv-spec', r.spec));
      tr.appendChild(el('td', 'rv-next', fmtNextFire(r)));
      const text = el('td', 'rv-text', preview(r.body));
      text.title = String(r.body ?? '');
      tr.appendChild(text);
      tr.appendChild(el('td', 'rv-ticket', r.ticket || ''));
      const cell = el('td', 'rv-actions');
      const btn = el('button', 'rv-cancel', 'Cancel');
      btn.addEventListener('click', () => cancelRow(r, btn));
      cell.appendChild(btn);
      tr.appendChild(cell);
      return tr;
    }

    async function cancelRow(r, btn) {
      if (btn.disabled) return;
      btn.disabled = true;
      try {
        let res;
        try {
          res = await rhost.invoke('cancel', { agent: r.agent, id: r.id });
        } catch (e) {
          rhost.log.error('cancel failed', e);
          res = null;
        }
        if (!alive()) return;
        if (res && res.ok === true) {
          rhost.ui.showToast('Schedule cancelled');
        } else if (!(res && res.gone)) {
          rhost.ui.showToast(`Could not cancel: ${(res && res.error) || 'unknown error'}`, { kind: 'error' });
          return;
        }
        await reload();
      } finally {
        if (alive() && btn.isConnected) btn.disabled = false;
      }
    }

    async function reload() {
      const my = ++seq;
      body.innerHTML = '';
      body.appendChild(el('div', 'rv-empty', 'Loading…'));
      const got = await fetchRows();
      if (!alive() || my !== seq || !got) return;
      if (got.error) {
        rows = [];
        body.innerHTML = '';
        body.appendChild(el('div', 'rv-empty', `Could not read reminders: ${got.error}`));
        return;
      }
      rows = got.rows;
      render();
    }

    return reload;
  }

  rhost.ui.sidebar.footerButton({
    id: 'open',
    glyph: '⏲',
    label: 'Reminders',
    tip: 'Reminders the seats have armed',
    onClick: () => surface.open(),
  });

  return () => { torn = true; };
};
