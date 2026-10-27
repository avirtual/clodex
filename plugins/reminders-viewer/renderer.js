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

function isWeb() {
  return typeof window !== 'undefined' && Boolean(window.__CLODEX_WEB__ || !window.require);
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
    const compose = el('div', 'rv-compose');
    const seatSel = el('select', 'rv-compose-seat');
    const specIn = el('input', 'rv-compose-spec');
    specIn.placeholder = 'every 1h | in 45m | at 14:30 | cron 0 9 * * *';
    const textIn = el('textarea', 'rv-compose-text');
    textIn.placeholder = '[agent:context clear] Fresh start: …';
    const addBtn = el('button', 'rv-add', '+ reminder');
    const addErr = el('div', 'rv-compose-error', '');
    const composeRow = el('div', 'rv-compose-row');
    for (const n of [seatSel, specIn, addBtn]) composeRow.appendChild(n);
    for (const n of [composeRow, textIn, addErr]) compose.appendChild(n);
    addBtn.addEventListener('click', () => {
      submitReminder().catch((e) => rhost.log.error('add failed', e));
    });
    modal.appendChild(compose);
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
      toggle.disabled = !active;
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
      const kind = el('td', 'rv-kind', r.kind);
      if (r.by === 'operator') kind.appendChild(el('span', 'rv-chip', 'operator'));
      if (r.by === 'ticket-loop') kind.appendChild(el('span', 'rv-chip', 'loop'));
      tr.appendChild(kind);
      tr.appendChild(el('td', 'rv-spec', r.spec));
      tr.appendChild(el('td', 'rv-next', fmtNextFire(r)));
      const text = el('td', 'rv-text', preview(r.body));
      text.title = String(r.body ?? '');
      tr.appendChild(text);
      tr.appendChild(el('td', 'rv-ticket', r.ticket || ''));
      const cell = el('td', 'rv-actions');
      const fireBtn = el('button', 'rv-fire', 'Fire');
      const btn = isWeb() ? null : el('button', 'rv-cancel', 'Cancel');
      fireBtn.addEventListener('click', () => fireRow(r, fireBtn, btn));
      cell.appendChild(fireBtn);
      if (btn) {
        btn.addEventListener('click', () => cancelRow(r, btn));
        cell.appendChild(btn);
      }
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

    async function fireRow(r, fireBtn, cancelBtn) {
      if (fireBtn.disabled) return;
      fireBtn.disabled = true;
      if (cancelBtn) cancelBtn.disabled = true;
      let res;
      try {
        res = await rhost.invoke('fire', { agent: r.agent, id: r.id });
      } catch (e) {
        rhost.log.error('fire failed', e);
        res = null;
      }
      if (!alive()) return;
      if (res && res.ok === true) {
        rhost.ui.showToast(res.kept ? 'Reminder delivered' : 'Reminder delivered and spent');
        await reload();
        return;
      }
      rhost.ui.showToast(`Could not fire: ${(res && res.error) || 'unknown error'}`, { kind: 'error' });
      if (fireBtn.isConnected) fireBtn.disabled = false;
      if (cancelBtn && cancelBtn.isConnected) cancelBtn.disabled = false;
      await reload();
    }

    async function loadSeats() {
      let res;
      try {
        res = await rhost.invoke('seats', rhost.workspaceId);
      } catch (e) {
        rhost.log.error('seats failed', e);
        res = null;
      }
      if (!alive() || !res || res.ok !== true || !Array.isArray(res.seats)) return;
      const keep = seatSel.value || rhost.sessions.active() || '';
      seatSel.innerHTML = '';
      for (const s of res.seats) {
        const opt = el('option', '', s.live ? s.name : `${s.name} (saved)`);
        opt.value = s.name;
        seatSel.appendChild(opt);
      }
      if (res.seats.some((s) => s.name === keep)) seatSel.value = keep;
    }

    async function submitReminder() {
      if (addBtn.disabled) return;
      addBtn.disabled = true;
      addErr.textContent = '';
      try {
        let res;
        try {
          res = await rhost.invoke('add', { wsId: rhost.workspaceId, agent: seatSel.value, spec: String(specIn.value ?? ''), body: String(textIn.value ?? '') });
        } catch (e) {
          rhost.log.error('add failed', e);
          res = null;
        }
        if (!alive()) return;
        if (!res || res.ok !== true) {
          addErr.textContent = (res && res.error) || 'Could not add the reminder';
          return;
        }
        specIn.value = '';
        textIn.value = '';
        await reload();
      } finally {
        if (alive() && addBtn.isConnected) addBtn.disabled = false;
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

    return () => reload().then(() => loadSeats());
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
