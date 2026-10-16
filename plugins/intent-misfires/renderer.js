'use strict';

const DETAIL_CHARS = 80;
const ALL = '';

function fmtTime(ts, timeZone) {
  if (typeof ts !== 'number' || !Number.isFinite(ts)) return '';
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const p = {};
  for (const part of fmt.formatToParts(new Date(ts))) p[part.type] = part.value;
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second}`;
}

function fmtCtx(tokens) {
  if (typeof tokens !== 'number' || !Number.isFinite(tokens)) return '';
  if (tokens >= 1000) return `${Math.round(tokens / 1000)}k`;
  return String(tokens);
}

function intentLabel(row) {
  return row.sub ? `${row.intent} ${row.sub}` : row.intent;
}

function preview(text) {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim();
  return flat.length > DETAIL_CHARS ? `${flat.slice(0, DETAIL_CHARS - 1)}…` : flat;
}

function countsLine(counts) {
  const agents = Object.keys(counts || {}).sort();
  return agents.map((a) => {
    const kinds = Object.keys(counts[a]).sort().map((k) => `${k} ${counts[a][k]}`);
    return `${a}: ${kinds.join(', ')}`;
  }).join(' · ');
}

module.exports.fmtTime = fmtTime;
module.exports.fmtCtx = fmtCtx;
module.exports.intentLabel = intentLabel;
module.exports.preview = preview;
module.exports.countsLine = countsLine;

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

  function option(value, label) {
    const o = el('option', '', label);
    o.value = value;
    return o;
  }

  function fetchRows(filters) {
    if (!alive()) return Promise.resolve(null);
    return Promise.resolve()
      .then(() => rhost.invoke('list', { workspaceId: rhost.workspaceId, ...filters }))
      .then((res) => {
        if (!alive()) return null;
        if (!res || res.ok !== true) return { error: (res && res.error) || 'unknown error' };
        return {
          rows: Array.isArray(res.rows) ? res.rows : [],
          counts: res.counts && typeof res.counts === 'object' ? res.counts : {},
          kinds: Array.isArray(res.kinds) ? res.kinds : [],
        };
      })
      .catch((e) => {
        rhost.log.error('list failed', e);
        return { error: 'the misfire list could not be read' };
      });
  }

  function wire(rootEl) {
    rootEl.innerHTML = '';
    const modal = el('div', 'mf-modal');
    const topbar = el('div', 'mf-topbar');
    topbar.appendChild(el('div', 'mf-title', 'Intent Misfires'));
    const filters = el('div', 'mf-filters');
    const agentSel = el('select', 'mf-select');
    const kindSel = el('select', 'mf-select');
    filters.appendChild(agentSel);
    filters.appendChild(kindSel);
    topbar.appendChild(filters);
    const closeBtn = el('button', 'mf-close', '×');
    closeBtn.title = 'Close';
    closeBtn.addEventListener('click', () => surface.close());
    topbar.appendChild(closeBtn);
    modal.appendChild(topbar);
    const summary = el('div', 'mf-counts', '');
    modal.appendChild(summary);
    const body = el('div', 'mf-body');
    modal.appendChild(body);
    rootEl.appendChild(modal);

    let agent = ALL;
    let kind = ALL;
    let seq = 0;

    agentSel.addEventListener('change', () => { agent = agentSel.value; reload(); });
    kindSel.addEventListener('change', () => { kind = kindSel.value; reload(); });

    function fillSelect(sel, values, current, allLabel) {
      sel.innerHTML = '';
      sel.appendChild(option(ALL, allLabel));
      for (const v of values) sel.appendChild(option(v, v));
      sel.value = current;
    }

    function render(got) {
      const agents = Object.keys(got.counts).sort();
      if (agent !== ALL && !agents.includes(agent)) agents.push(agent);
      fillSelect(agentSel, agents, agent, 'All Seats');
      fillSelect(kindSel, got.kinds, kind, 'All Kinds');
      summary.textContent = countsLine(got.counts) || 'No misfires recorded in this workspace';
      body.innerHTML = '';
      if (!got.rows.length) {
        body.appendChild(el('div', 'mf-empty', 'No misfires match these filters'));
        return;
      }
      const table = el('table', 'mf-table');
      const head = el('tr', 'mf-head');
      for (const h of ['TIME', 'AGENT', 'KIND', 'INTENT', 'DETAIL', 'CTX']) head.appendChild(el('th', '', h));
      table.appendChild(head);
      for (const r of got.rows) table.appendChild(renderRow(r));
      body.appendChild(table);
    }

    function renderRow(r) {
      const tr = el('tr', 'mf-row');
      tr.appendChild(el('td', 'mf-time', fmtTime(r.ts)));
      tr.appendChild(el('td', 'mf-agent', r.agent));
      tr.appendChild(el('td', 'mf-kind', r.kind));
      tr.appendChild(el('td', 'mf-intent', intentLabel(r)));
      const detail = el('td', 'mf-detail', preview(r.detail));
      detail.title = String(r.detail ?? '');
      tr.appendChild(detail);
      const ctx = el('td', 'mf-ctx', fmtCtx(r.ctxTokens));
      if (typeof r.turnBytes === 'number') ctx.title = `reply ${r.turnBytes} bytes`;
      tr.appendChild(ctx);
      return tr;
    }

    async function reload() {
      const my = ++seq;
      body.innerHTML = '';
      body.appendChild(el('div', 'mf-empty', 'Loading…'));
      const got = await fetchRows({ ...(agent ? { agent } : {}), ...(kind ? { kind } : {}) });
      if (!alive() || my !== seq || !got) return;
      if (got.error) {
        body.innerHTML = '';
        body.appendChild(el('div', 'mf-empty', `Could not read misfires: ${got.error}`));
        return;
      }
      render(got);
    }

    return reload;
  }

  rhost.ui.sidebar.footerButton({
    id: 'open',
    glyph: '⚑',
    label: 'Misfires',
    tip: 'Intents the seats emitted that Clodex could not act on',
    onClick: () => surface.open(),
  });

  return () => { torn = true; };
};
