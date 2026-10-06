'use strict';

const NOT_ON_SURFACE = 'plugin method not available on this surface';
const DESKTOP_ONLY_SEGMENT = 'browser: desktop only';
const DESKTOP_ONLY_NOTICE = 'Browser pane: desktop only — its windows open on the machine running Clodex.';
const ATTENTION = 'bp-attention';
const HANDED_MS = 5000;
const PICKER_MAX_W = 560;
const LOGIN_TEXT = {
  'logged-in': 'signed in',
  'login-page': 'sign-in page',
  'idp-refused': 'Google sign-in refused',
  none: 'signed out',
  unknown: 'login unknown',
};

function refused(res) {
  return !!(res && res.ok === false && res.error === NOT_ON_SURFACE);
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function stampShort(ms, now = Date.now()) {
  if (!ms) return '';
  const d = new Date(ms);
  const n = new Date(now);
  const p = (x) => String(x).padStart(2, '0');
  const hm = `${p(d.getHours())}:${p(d.getMinutes())}`;
  const today = d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth() && d.getDate() === n.getDate();
  return today ? hm : `${MONTHS[d.getMonth()]} ${d.getDate()} ${hm}`;
}

function loginText(s, now) {
  const when = stampShort(s.loginAt, now);
  return `${LOGIN_TEXT[s.login] || LOGIN_TEXT.unknown}${when ? ` · ${when}` : ''}`;
}

function hostText(s) {
  if (!s || !s.lastUrl) return '';
  try { return new URL(s.lastUrl).hostname.replace(/^www\./, ''); } catch { return ''; }
}

function windowText(s) {
  if (!s.windowOpen) return '';
  const state = s.operator ? `${s.state} by operator` : String(s.state);
  return `open · ${state}${s.visible === false ? ' · hidden' : ''}`;
}

function segmentFor(status) {
  if (!status) return null;
  if (status.desktopOnly) return { text: DESKTOP_ONLY_SEGMENT, tip: DESKTOP_ONLY_NOTICE };
  if (status.child === 'off') return null;
  if (status.child === 'unavailable') return { text: 'browser: unavailable', tip: 'The browser child crashed repeatedly; see the Clodex log.' };
  const list = Array.isArray(status.services) ? status.services : [];
  const tip = list.length ? list.map((s) => `${s.name}: ${stateLabel(s)}${s.openedBy || s.seat ? ` (${s.openedBy || s.seat})` : ''}`).join('\n') : 'No browser windows open';
  const more = list.length > 1 ? ` +${list.length - 1}` : '';
  const held = list.find((s) => s.state === 'held' && !s.operator);
  if (held) return { text: `browser: needs you (${held.name})${more}`, tip, accentClass: ATTENTION };
  const mine = list.find((s) => s.state === 'held');
  if (mine) return { text: `browser: ${mine.name} operator${more}`, tip };
  const driving = list.find((s) => s.state === 'driving');
  if (driving) return { text: `browser: driving ${driving.seat || 'an agent'}${more}`, tip };
  if (list.some((s) => s.state === 'gating')) return { text: `browser: waiting for you${more}`, tip };
  if (list.length > 1) return { text: `browser: ${list.length} windows`, tip };
  if (status.child === 'starting' && !list.length) return { text: 'browser: starting', tip };
  return { text: 'browser: idle', tip };
}

function stateLabel(s) {
  return s.operator ? `${s.state} (operator)` : String(s.state);
}

function clickActionFor(status) {
  if (!status || status.desktopOnly) return 'none';
  const n = Array.isArray(status.services) ? status.services.length : 0;
  if (n === 0) return 'none';
  return n === 1 ? 'show' : 'pick';
}

function pickerLabel(s) {
  return `${s.name} · ${stateLabel(s)}${s.seat ? ` · ${s.seat}` : ''}`;
}

const TITLE_MAX = 40;

function pickerSite(s) {
  const title = String(s.title || '');
  const clipped = title.length > TITLE_MAX ? `${title.slice(0, TITLE_MAX - 1).trimEnd()}…` : title;
  return { host: s.host ? ` ${s.host}` : '', title: clipped ? ` — ${clipped}` : '' };
}

function pickerName(s) {
  const site = pickerSite(s);
  return `${s.name}${site.host}${site.title}`;
}

function pickerState(s) {
  return `${stateLabel(s)}${s.seat ? ` · ${s.seat}` : ''}${s.visible === false ? ' · hidden' : ''}`;
}

function pickerHeading(list) {
  const hidden = list.filter((s) => s.visible === false).length;
  return hidden ? `Browser windows · ${list.length} open · ${hidden} hidden` : 'Browser windows';
}

function forgetText(name) {
  return `Forget the login for ${name}?\n\nIts cookies and site data are deleted, so the next visit starts signed out. The service, its last page, its downloads and its site notes are kept.`;
}

function removeText(name) {
  return `Remove ${name}?\n\nIts login, last page and downloads are deleted and it leaves this list.`;
}

function removeNotesText(host, n) {
  return `Also delete the ${n} site notes for ${host}? Other services on ${host} lose them too.`;
}

function el(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text != null) node.textContent = String(text);
  return node;
}

function activate(rhost) {
  let status = null;
  let alive = true;

  const relayout = () => {
    const sb = rhost.ui && rhost.ui.statusBar;
    if (sb && typeof sb.requestRelayout === 'function') sb.requestRelayout();
  };

  const call = async (method, ...args) => {
    try { return await rhost.invoke(method, ...args); } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
  };

  let noticeSeen = null;

  async function pull() {
    const res = await call('status', rhost.workspaceId);
    if (!alive) return;
    if (refused(res)) status = { desktopOnly: true };
    else if (res && res.ok) status = res;
    else status = null;
    const seq = status && status.notice ? status.notice.seq : 0;
    if (noticeSeen !== null && seq > noticeSeen) toast(status.notice.text, 'info');
    if (noticeSeen === null || seq > noticeSeen) noticeSeen = seq;
    relayout();
  }

  const toast = (msg, kind = 'error') => { if (rhost.ui.showToast) rhost.ui.showToast(msg, { kind }); };
  const showIt = async (name) => {
    const res = await call('show', name);
    if (!res || res.ok === false) toast(`Could not show ${name}: ${(res && res.error) || 'unknown error'}`);
  };
  const later = (fn, ms) => (typeof rhost.setTimeout === 'function' ? rhost.setTimeout(fn, ms) : setTimeout(fn, ms));

  async function agentSeats() {
    const sess = rhost.sessions;
    if (!sess || typeof sess.listWorkspace !== 'function') return [];
    let all = [];
    try { all = await sess.listWorkspace(rhost.workspaceId); } catch { all = []; }
    return (Array.isArray(all) ? all : []).filter((x) => x && (x.type === 'claude' || x.type === 'codex'));
  }

  function handControl(name, refill, seatList) {
    const box = el('span', 'bp-hand');
    box.appendChild(el('span', 'bp-hand-label', 'Hand to agent…'));
    const pick = el('select', 'bp-hand-seat');
    const text = el('input', 'bp-hand-text');
    text.placeholder = 'what should it do?';
    const go = el('button', 'bp-hand-go bp-btn primary', 'Give control');
    box.appendChild(pick);
    box.appendChild(text);
    box.appendChild(go);
    const ready = (seatList || agentSeats()).then((seats) => {
      for (const x of seats) {
        const o = el('option', null, x.name);
        o.value = x.name;
        pick.appendChild(o);
      }
      if (seats.length) pick.value = seats[0].name;
      else go.disabled = true;
    });
    go.addEventListener('click', async () => {
      await ready;
      if (go.disabled || !pick.value) return;
      go.disabled = true;
      const res = await call('operator.handover', { service: name, seat: pick.value, instruction: text.value || '' });
      if (!res || res.ok === false) {
        toast(`Could not hand ${name} over: ${(res && res.error) || 'unknown error'}`);
        go.disabled = false;
        return;
      }
      box.textContent = '';
      box.appendChild(el('span', 'bp-handed', `handed to ${res.seat || pick.value}`));
      later(() => { refill(); }, HANDED_MS);
    });
    return box;
  }

  let picker = null;

  function windowControls(r, name, refill, opts = {}) {
    const show = el('button', 'bp-show bp-btn', 'Show');
    show.addEventListener('click', () => showIt(name));
    r.appendChild(show);
    const owner = () => opts.owner || picker;
    const open = el('button', 'bp-hand-open bp-btn', 'Hand over');
    let form = null;
    const fold = () => {
      if (form && form.parentNode) form.parentNode.removeChild(form);
      form = null;
      const o = owner();
      if (o && o.fold === fold) o.fold = null;
    };
    open.addEventListener('click', () => {
      if (form) { fold(); return; }
      const o = owner();
      if (o && o.fold) o.fold();
      form = (opts.formHost || r).appendChild(handControl(name, refill, o ? o.seats : null));
      if (o) o.fold = fold;
    });
    r.appendChild(open);
  }

  function closePicker() {
    if (!picker) return;
    const p = picker;
    picker = null;
    document.removeEventListener('mousedown', p.onDown, true);
    document.removeEventListener('keydown', p.onKey, true);
    if (p.node.parentNode) p.node.parentNode.removeChild(p.node);
  }

  function fillPicker() {
    if (!picker) return;
    const node = picker.node;
    node.textContent = '';
    const list = (status && Array.isArray(status.services)) ? status.services : [];
    if (!list.length) { closePicker(); return; }
    picker.fold = null;
    node.appendChild(el('div', 'bp-picker-label', pickerHeading(list)));
    for (const s of list) {
      const r = el('div', 'bp-row bp-pick-row');
      const name = el('span', 'bp-pick-name');
      const site = pickerSite(s);
      name.appendChild(el('b', null, s.name));
      if (site.host) name.appendChild(el('span', 'bp-pick-host', site.host));
      if (site.title) name.appendChild(el('span', 'bp-pick-title', site.title));
      r.appendChild(name);
      r.appendChild(el('span', 'bp-pick-state', pickerState(s)));
      windowControls(r, s.name, async () => { await pull(); fillPicker(); });
      node.appendChild(r);
    }
  }

  function openPicker(anchorEl) {
    closePicker();
    const node = el('div', 'bp-picker');
    const rect = anchorEl && typeof anchorEl.getBoundingClientRect === 'function' ? anchorEl.getBoundingClientRect() : null;
    if (rect) {
      const vw = typeof window === 'undefined' ? 0 : window.innerWidth || 0;
      const vh = typeof window === 'undefined' ? 0 : window.innerHeight || 0;
      const width = vw ? Math.min(PICKER_MAX_W, vw - 16) : PICKER_MAX_W;
      const bottom = Math.max(4, vh - rect.top + 4);
      node.style.maxWidth = `${width}px`;
      if (vw && rect.left + width > vw - 8) node.style.right = '8px';
      else node.style.left = `${vw ? Math.max(8, rect.left) : Math.max(4, rect.left)}px`;
      node.style.bottom = `${bottom}px`;
      if (vh) node.style.maxHeight = `${Math.max(0, vh - bottom - 8)}px`;
    }
    const act = anchorEl && typeof anchorEl.getAttribute === 'function' ? anchorEl.getAttribute('data-act') : null;
    const onAnchor = (t) => (act && t && typeof t.closest === 'function' ? !!t.closest(`[data-act="${act}"]`) : t === anchorEl);
    const onDown = (e) => { if (picker && !picker.node.contains(e.target) && !onAnchor(e.target)) closePicker(); };
    const onKey = (e) => {
      if (e.key !== 'Escape') return;
      if (picker && picker.fold) picker.fold(); else closePicker();
    };
    picker = { node, onDown, onKey, fold: null, seats: agentSeats() };
    document.body.appendChild(node);
    document.addEventListener('mousedown', onDown, true);
    document.addEventListener('keydown', onKey, true);
    fillPicker();
  }

  rhost.ui.statusBar.addSegment({
    id: 'browser',
    render: () => segmentFor(status),
    onClick: (anchorEl) => {
      const act = clickActionFor(status);
      if (act === 'show') call('show');
      else if (act === 'pick') { if (picker) closePicker(); else openPicker(anchorEl); }
    },
  });

  async function forget(name, btn, refill) {
    if (btn.disabled) return;
    btn.disabled = true;
    try {
      if (!confirm(forgetText(name))) return;
      const res = await call('services.forget', name);
      if (!res || res.ok === false) toast(`Could not forget ${name}: ${(res && res.error) || 'unknown error'}`);
      refill();
    } finally {
      btn.disabled = false;
    }
  }

  async function remove(s, btn, refill) {
    if (btn.disabled) return;
    btn.disabled = true;
    try {
      if (!confirm(removeText(s.name))) return;
      const notes = s.notes > 0 ? confirm(removeNotesText(s.host || hostText(s), s.notes)) : false;
      const res = await call('services.remove', { name: s.name, notes });
      if (!res || res.ok === false) toast(`Could not remove ${s.name}: ${(res && res.error) || 'unknown error'}`);
      refill();
    } finally {
      btn.disabled = false;
    }
  }

  function row(s, refill, hands) {
    const r = el('div', 'bp-row');
    const nm = el('span', 'bp-name', s.name);
    nm.title = s.lastUrl || 'no page yet';
    r.appendChild(nm);
    const hs = el('span', 'bp-host', hostText(s));
    if (s.lastUrl) hs.title = s.lastUrl;
    r.appendChild(hs);
    r.appendChild(el('span', 'bp-login', loginText(s)));
    const tabbed = !!(s.tabs && s.tabs.length);
    const win = r.appendChild(el('span', 'bp-window', tabbed ? null : windowText(s)));
    if (tabbed) {
      win.appendChild(el('span', null, windowText(s) + ' · '));
      win.appendChild(el('span', 'bp-tabs', 'tabs: ' + s.tabs.map((t) => t.name.split(':')[1] + ' (' + t.state + ')').join(', ')));
    }
    const acts = el('span', 'bp-actions');
    r.appendChild(acts);
    if (s.windowOpen) windowControls(acts, s.name, refill, { owner: hands, formHost: r });
    else if (s.lastUrl) {
      const reopen = el('button', 'bp-reopen bp-btn', 'Open');
      reopen.addEventListener('click', async () => {
        if (reopen.disabled) return;
        reopen.disabled = true;
        try {
          const res = await call('operator.open', { service: s.name, url: s.lastUrl });
          if (!res || res.ok === false) toast(`Could not open ${s.name}: ${(res && res.error) || 'unknown error'}`);
          await refill();
        } finally {
          reopen.disabled = false;
        }
      });
      acts.appendChild(reopen);
    }
    if (s.state === 'held') {
      const hb = el('button', 'bp-handback bp-btn', 'Hand back');
      hb.addEventListener('click', async () => { await call('handback', s.name); refill(); });
      acts.appendChild(hb);
    }
    const fg = el('button', 'bp-forget bp-btn quiet', 'Forget login');
    fg.addEventListener('click', () => forget(s.name, fg, refill));
    r.appendChild(fg);
    const rm = el('button', 'bp-remove bp-btn quiet', 'Remove');
    if (s.windowOpen) {
      rm.disabled = true;
      rm.title = 'close its window first';
    } else rm.addEventListener('click', () => remove(s, rm, refill));
    r.appendChild(rm);
    return r;
  }

  function denyBlock(label, scope, patterns) {
    const box = el('div', 'bp-deny');
    box.appendChild(el('div', 'bp-deny-label', label));
    const area = el('textarea', 'bp-deny-text');
    area.value = (patterns || []).join('\n');
    area.rows = 3;
    area.placeholder = 'one pattern per line: example.com, *.example.com, example.com/path/*, http://…, !exception';
    box.appendChild(area);
    const save = el('button', 'bp-deny-save', 'Save');
    const err = el('span', 'bp-deny-error', '');
    save.addEventListener('click', async () => {
      if (save.disabled) return;
      save.disabled = true;
      try {
        const res = await call('denylist.set', { scope, patterns: String(area.value || '').split('\n') });
        if (res && res.ok) {
          area.value = (res.patterns || []).join('\n');
          err.textContent = 'Saved';
        } else {
          err.textContent = `${res && res.line ? `line ${res.line}: ` : ''}${(res && res.error) || 'unknown error'}`;
        }
      } finally {
        save.disabled = false;
      }
    });
    box.appendChild(save);
    box.appendChild(err);
    return box;
  }

  function attachRow() {
    const r = el('div', 'bp-row bp-attach');
    r.style.display = 'none';
    r.appendChild(el('span', 'bp-attach-label', 'Attach reads up to ≈'));
    const field = el('input', 'bp-attach-tokens');
    field.type = 'number';
    field.min = '100';
    field.max = '20000';
    field.step = '100';
    r.appendChild(field);
    r.appendChild(el('span', 'bp-attach-unit', 'tokens'));
    const save = el('button', 'bp-attach-save', 'Save');
    const err = el('span', 'bp-attach-error', '');
    save.addEventListener('click', async () => {
      if (save.disabled) return;
      save.disabled = true;
      try {
        const res = await call('attach.set', { tokens: Number(field.value) });
        err.textContent = res && res.ok ? 'Saved' : (res && res.error) || 'unknown error';
      } finally {
        save.disabled = false;
      }
    });
    r.appendChild(save);
    r.appendChild(err);
    const show = (tokens) => {
      r.style.display = '';
      if (document.activeElement !== field) field.value = String(tokens);
    };
    return { row: r, show };
  }

  function openRow(refill) {
    const r = el('div', 'bp-row bp-open');
    r.appendChild(el('span', 'bp-open-label', 'Open a window:'));
    const name = el('input', 'bp-open-service');
    name.placeholder = 'service name';
    const url = el('input', 'bp-open-url');
    url.placeholder = 'https://…';
    const go = el('button', 'bp-open-go bp-btn primary', 'Open');
    go.addEventListener('click', async () => {
      if (go.disabled) return;
      go.disabled = true;
      try {
        const service = String(name.value || '').trim();
        const res = await call('operator.open', { service, url: String(url.value || '').trim() });
        if (!res || res.ok === false) toast(`Could not open ${service || 'the window'}: ${(res && res.error) || 'unknown error'}`);
        await refill();
      } finally {
        go.disabled = false;
      }
    });
    r.appendChild(name);
    r.appendChild(url);
    r.appendChild(go);
    return r;
  }

  rhost.ui.settings.section({
    id: 'services',
    render(bodyEl) {
      bodyEl.textContent = '';
      const hands = { seats: agentSeats(), fold: null };
      const list = el('div', 'bp-services');
      bodyEl.appendChild(openRow(() => fill().then(fillDeny)));
      const windows = el('div', 'bp-sect');
      windows.appendChild(el('div', 'bp-section', 'Windows'));
      windows.appendChild(list);
      const reveal = el('button', 'bp-reveal bp-btn', 'Reveal downloads');
      reveal.addEventListener('click', async () => {
        const res = await call('downloads.dir');
        if (res && res.ok && res.dir) rhost.ui.openPath(res.dir);
        else toast(`Could not open the downloads folder: ${(res && res.error) || 'unknown error'}`);
      });
      windows.appendChild(reveal);
      bodyEl.appendChild(windows);
      const attach = el('div', 'bp-sect bp-attach-box');
      attach.style.display = 'none';
      attach.appendChild(el('div', 'bp-section', 'Reads'));
      const budget = attachRow();
      attach.appendChild(budget.row);
      bodyEl.appendChild(attach);
      const deny = el('div', 'bp-sect bp-denylist');
      bodyEl.appendChild(deny);
      const fill = async () => {
        const res = await call('services.list');
        if (refused(res)) {
          bodyEl.textContent = '';
          bodyEl.appendChild(el('div', 'bp-desktop-only', DESKTOP_ONLY_NOTICE));
          return;
        }
        hands.fold = null;
        list.textContent = '';
        const services = (res && res.ok && Array.isArray(res.services)) ? res.services : [];
        if (!services.length) list.appendChild(el('div', 'bp-empty', 'No services yet.'));
        else for (const h of ['Service', 'Site', 'Sign-in', 'Window', '', '', '']) list.appendChild(el('span', 'bp-th', h));
        for (const s of services) list.appendChild(row(s, fill, hands));
        const a = await call('attach.get');
        if (a && a.ok && Number.isInteger(a.global)) {
          attach.style.display = '';
          budget.show(a.global);
        }
        return services;
      };
      const fillDeny = async (services) => {
        if (!services) return;
        const d = await call('denylist.get');
        deny.textContent = '';
        if (!d || !d.ok) return;
        deny.appendChild(el('div', 'bp-section', 'Denylist'));
        deny.appendChild(el('div', 'bp-deny-title', 'URLs the browser windows refuse to visit'));
        deny.appendChild(denyBlock('All services', 'global', d.global));
        const named = [...new Set([...services.map((s) => s.name), ...Object.keys(d.services || {})])].sort();
        for (const name of named) deny.appendChild(denyBlock(name, name, (d.services || {})[name]));
      };
      return fill().then(fillDeny);
    },
    collect: () => null,
  });

  const off = rhost.events.on('changed', () => { pull(); });
  pull();
  return () => {
    alive = false;
    closePicker();
    if (typeof off === 'function') off();
  };
}

module.exports = { activate, stampShort, loginText, hostText, windowText, segmentFor, clickActionFor, pickerLabel, pickerName, pickerState, pickerHeading, forgetText, removeText, removeNotesText, DESKTOP_ONLY_NOTICE, NOT_ON_SURFACE };
