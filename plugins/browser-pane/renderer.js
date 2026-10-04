'use strict';

const NOT_ON_SURFACE = 'plugin method not available on this surface';
const DESKTOP_ONLY_SEGMENT = 'browser: desktop only';
const DESKTOP_ONLY_NOTICE = 'Browser pane: desktop only — its windows open on the machine running Clodex.';
const ATTENTION = 'bp-attention';
const LOGIN_TEXT = {
  'logged-in': 'signed in',
  'login-page': 'sign-in page',
  'idp-refused': 'Google sign-in refused',
  unknown: 'login unknown',
};

function refused(res) {
  return !!(res && res.ok === false && res.error === NOT_ON_SURFACE);
}

function stamp(ms) {
  if (!ms) return '';
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function segmentFor(status) {
  if (!status) return null;
  if (status.desktopOnly) return { text: DESKTOP_ONLY_SEGMENT, tip: DESKTOP_ONLY_NOTICE };
  if (status.child === 'off') return null;
  if (status.child === 'unavailable') return { text: 'browser: unavailable', tip: 'The browser child crashed repeatedly; see the Clodex log.' };
  const list = Array.isArray(status.services) ? status.services : [];
  const tip = list.length ? list.map((s) => `${s.name}: ${s.state}${s.seat ? ` (${s.seat})` : ''}`).join('\n') : 'No browser windows open';
  const held = list.find((s) => s.state === 'held');
  if (held) return { text: `browser: needs you (${held.name})`, tip, accentClass: ATTENTION };
  const driving = list.find((s) => s.state === 'driving');
  if (driving) return { text: `browser: driving ${driving.seat || 'an agent'}`, tip };
  if (list.some((s) => s.state === 'gating')) return { text: 'browser: waiting for you', tip };
  return { text: 'browser: idle', tip };
}

function forgetText(name) {
  return `Forget the login for ${name}?\n\nIts cookies and site data are deleted, so the next visit starts signed out. Downloaded files are kept.`;
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

  async function pull() {
    const res = await call('status', rhost.workspaceId);
    if (!alive) return;
    if (refused(res)) status = { desktopOnly: true };
    else if (res && res.ok) status = res;
    else status = null;
    relayout();
  }

  rhost.ui.statusBar.addSegment({
    id: 'browser',
    render: () => segmentFor(status),
    onClick: () => { if (status && !status.desktopOnly) call('show'); },
  });

  const toast = (msg) => { if (rhost.ui.showToast) rhost.ui.showToast(msg, { kind: 'error' }); };

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

  function row(s, refill) {
    const r = el('div', 'bp-row');
    r.appendChild(el('span', 'bp-name', s.name));
    const when = s.loginAt ? ` (${stamp(s.loginAt)})` : '';
    r.appendChild(el('span', 'bp-login', `${LOGIN_TEXT[s.login] || LOGIN_TEXT.unknown}${when}`));
    r.appendChild(el('span', 'bp-window', s.windowOpen ? `window open · ${s.state}` : 'closed'));
    const show = el('button', 'bp-show', 'Show');
    show.addEventListener('click', () => { call('show', s.name); });
    r.appendChild(show);
    if (s.state === 'held') {
      const hb = el('button', 'bp-handback', 'Hand back');
      hb.addEventListener('click', async () => { await call('handback', s.name); refill(); });
      r.appendChild(hb);
    }
    const fg = el('button', 'bp-forget', 'Forget login');
    fg.addEventListener('click', () => forget(s.name, fg, refill));
    r.appendChild(fg);
    return r;
  }

  rhost.ui.settings.section({
    id: 'services',
    title: 'Browser Pane',
    render(bodyEl) {
      bodyEl.textContent = '';
      const list = el('div', 'bp-services');
      bodyEl.appendChild(list);
      const reveal = el('button', 'bp-reveal', 'Reveal downloads');
      reveal.addEventListener('click', async () => {
        const res = await call('downloads.dir');
        if (res && res.ok && res.dir) rhost.ui.openPath(res.dir);
        else toast(`Could not open the downloads folder: ${(res && res.error) || 'unknown error'}`);
      });
      bodyEl.appendChild(reveal);
      const fill = async () => {
        const res = await call('services.list');
        if (refused(res)) {
          bodyEl.textContent = '';
          bodyEl.appendChild(el('div', 'bp-desktop-only', DESKTOP_ONLY_NOTICE));
          return;
        }
        list.textContent = '';
        const services = (res && res.ok && Array.isArray(res.services)) ? res.services : [];
        if (!services.length) list.appendChild(el('div', 'bp-empty', 'No services yet.'));
        for (const s of services) list.appendChild(row(s, fill));
      };
      return fill();
    },
    collect: () => null,
  });

  const off = rhost.events.on('changed', () => { pull(); });
  pull();
  return () => {
    alive = false;
    if (typeof off === 'function') off();
  };
}

module.exports = { activate, segmentFor, forgetText, DESKTOP_ONLY_NOTICE, NOT_ON_SURFACE };
