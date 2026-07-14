'use strict';
// api-shim.js — the browser frontend's transport (web-frontend Phase 3b). It
// builds `window.api` from the SAME api-contract.js table the Electron preload
// loops, but each endpoint rides a WebSocket to web-host.js instead of
// ipcRenderer:
//   invoke → an id'd { t:'invoke' } request whose reply resolves/rejects the
//            returned Promise; callers transparently await the socket being ready.
//   send   → a fire-and-forget { t:'send' } frame (queued if the socket is down).
//   on     → a local subscription; the host fans every workspace event to us and
//            we route by channel to the registered callbacks.
// It also renders the minimal in-page UI for the host's degraded native-GUI
// round-trips (menu-show / dialog-show), maps the synthetic shell channels
// (open-external / open-path / show-item-in-folder / focus-hint), reports tab
// visibility, and reconnects (with a banner) on drop — reloading to re-run the
// renderer's restore flow once the socket returns.
//
// This module is browser-ONLY: it is never loaded by the Electron renderer
// (which keeps its ipcRenderer-backed preload) and is bundled only by
// build/build-web.js.

const { API_CONTRACT } = require('../../api-contract');

// ── connection params from the page URL (the host serves the page token-gated;
// the token, if any, and the ?workspace= selector ride the same query string).
const PARAMS = new URLSearchParams(location.search);
const TOKEN = PARAMS.get('token') || null;
const WORKSPACE = PARAMS.get('workspace') || 'default';

let ws = null;
let socketOpen = false;
let everWelcomed = false;         // a prior socket already welcomed → a new welcome means reconnect
let welcomeInfo = null;
let seq = 1;
const pending = new Map();        // invoke id → { resolve, reject }
const subs = new Map();           // channel → Set<callback>
let outbox = [];                  // send-kind frames queued while the socket is down
let readyResolve;
const ready = new Promise((r) => { readyResolve = r; }); // resolves on the FIRST welcome

// ── Buffer decode — inverse of the host's encodeBuffers. Peer PTY bytes arrive
// as { $type:'Buffer', b64 }; decode to a Uint8Array (xterm.write accepts it).
// Walks arrays/objects so nested carriers (peer-replay's info.data) are covered.
function decode(v) {
  if (v == null || typeof v !== 'object') return v;
  if (v.$type === 'Buffer' && typeof v.b64 === 'string') {
    const bin = atob(v.b64);
    const u8 = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    return u8;
  }
  if (Array.isArray(v)) return v.map(decode);
  const out = {};
  for (const k of Object.keys(v)) out[k] = decode(v[k]);
  return out;
}

function frameSend(frame) {
  if (socketOpen && ws && ws.readyState === WebSocket.OPEN) {
    try { ws.send(JSON.stringify(frame)); return; } catch { /* fall through to queue */ }
  }
  outbox.push(frame);
}
function flushOutbox() {
  const q = outbox; outbox = [];
  for (const f of q) frameSend(f);
}

function invoke(channel, args) {
  // Transparently wait for the socket to be ready (the watch-point: renderer code
  // calls window.api.* synchronously at parse time, before the socket opens).
  return ready.then(() => new Promise((resolve, reject) => {
    const id = seq++;
    pending.set(id, { resolve, reject });
    frameSend({ t: 'invoke', id, channel, args });
  }));
}

// ── synthetic host channels + local event fan-out.
function dispatchEvent(channel, args) {
  if (channel === 'open-external') { try { window.open(args[0], '_blank', 'noopener,noreferrer'); } catch { /* popup blocked */ } return; }
  if (channel === 'open-path') { toast(`Can't open on this machine from the browser: ${args[0]}`); return; }
  if (channel === 'show-item-in-folder') { toast(`Can't reveal in Finder from the browser: ${args[0]}`); return; }
  if (channel === 'focus-hint') { try { window.focus(); } catch { /* not permitted */ } return; }
  const set = subs.get(channel);
  if (set) for (const cb of [...set]) { try { cb(...args); } catch (err) { console.error(`event ${channel}`, err); } }
}

function onMessage(raw) {
  let frame;
  try { frame = JSON.parse(raw); } catch { return; }
  switch (frame && frame.t) {
    case 'welcome': {
      if (everWelcomed) { location.reload(); return; } // reconnected → re-run the whole restore flow
      everWelcomed = true;
      welcomeInfo = frame;
      hideBanner();
      flushOutbox();
      readyResolve(frame);
      break;
    }
    case 'reply': {
      const p = pending.get(frame.id);
      if (!p) return;
      pending.delete(frame.id);
      if (frame.ok) p.resolve(frame.value);
      else p.reject(new Error(frame.error || `invoke failed: ${frame.id}`));
      break;
    }
    case 'event':
      dispatchEvent(frame.channel, (frame.args || []).map(decode));
      break;
    case 'menu-show':
      showMenu(frame.menuId, frame.items || []);
      break;
    case 'dialog-show':
      showDialog(frame.dialogId, frame.kind, frame.opts || {});
      break;
    default:
      /* unknown frame — ignore */
  }
}

function wsUrl() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const q = new URLSearchParams();
  if (TOKEN) q.set('token', TOKEN);
  const qs = q.toString();
  return `${proto}//${location.host}/${qs ? `?${qs}` : ''}`;
}

let reconnectTimer = null;
function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => { reconnectTimer = null; connect(); }, 1000);
}

function connect() {
  try { ws = new WebSocket(wsUrl()); } catch { showBanner('Connection failed — retrying…'); scheduleReconnect(); return; }
  ws.onopen = () => {
    socketOpen = true;
    frameSend({ t: 'hello', token: TOKEN, workspaceId: WORKSPACE });
  };
  ws.onmessage = (ev) => onMessage(ev.data);
  ws.onclose = () => {
    socketOpen = false;
    showBanner(everWelcomed ? 'Disconnected — reconnecting…' : 'Connecting…');
    scheduleReconnect();
  };
  ws.onerror = () => { try { ws.close(); } catch { /* already closing */ } };
}

// ── window.api, generated from the contract table (same loop shape as preload).
function buildApi() {
  // Marks the renderer as running under the browser frontend. The Electron
  // preload never sets it; renderer code reads it to degrade actions that have no
  // browser equivalent — e.g. the file-peek "Open in the default editor" button,
  // which the container has no external editor to honour (the file is already
  // shown in-page). Set alongside window.api so it is present before renderer.js runs.
  window.__CLODEX_WEB__ = true;
  const api = {};
  for (const { name, kind, channel, argmap } of API_CONTRACT) {
    if (kind === 'invoke') {
      api[name] = (...a) => invoke(channel, argmap ? argmap(...a) : a);
    } else if (kind === 'send') {
      api[name] = (...a) => { frameSend({ t: 'send', channel, args: argmap ? argmap(...a) : a }); };
    } else { // on
      api[name] = (cb) => {
        let set = subs.get(channel);
        if (!set) { set = new Set(); subs.set(channel, set); }
        set.add(cb);
      };
    }
  }
  window.api = api;
}

// ── in-page UI: reconnect banner, toasts, degraded native menus + dialogs. All
// styling is a single injected stylesheet so the bundle stays self-contained.
const STYLE = `
.clx-banner{position:fixed;top:0;left:0;right:0;z-index:100000;background:#8a1c1c;color:#fff;
  font:600 12px/1 -apple-system,system-ui,sans-serif;text-align:center;padding:7px 12px}
.clx-toast-wrap{position:fixed;bottom:14px;right:14px;z-index:100000;display:flex;flex-direction:column;gap:8px;align-items:flex-end}
.clx-toast{background:#222;color:#eee;font:400 12px/1.4 -apple-system,system-ui,sans-serif;
  padding:9px 12px;border-radius:6px;box-shadow:0 2px 10px rgba(0,0,0,.4);max-width:340px}
.clx-toast a{color:#7db7ff}
.clx-menu{position:fixed;z-index:100001;background:#2b2b2b;border:1px solid #444;border-radius:6px;
  padding:4px 0;min-width:180px;box-shadow:0 6px 24px rgba(0,0,0,.5);
  font:400 13px/1 -apple-system,system-ui,sans-serif;color:#eee}
.clx-menu-item{padding:6px 26px 6px 22px;position:relative;white-space:nowrap;cursor:default}
.clx-menu-item[data-enabled="0"]{opacity:.4;pointer-events:none}
.clx-menu-item:hover{background:#3a6ea5;color:#fff}
.clx-menu-item .clx-mark{position:absolute;left:7px}
.clx-menu-item .clx-arrow{position:absolute;right:9px;opacity:.7}
.clx-menu-sep{height:1px;margin:4px 0;background:#444}
.clx-modal-bg{position:fixed;inset:0;z-index:100002;background:rgba(0,0,0,.45);display:flex;align-items:center;justify-content:center}
.clx-modal{background:#2b2b2b;color:#eee;border-radius:8px;padding:18px 20px;min-width:320px;max-width:480px;
  box-shadow:0 8px 32px rgba(0,0,0,.55);font:400 13px/1.5 -apple-system,system-ui,sans-serif}
.clx-modal h3{margin:0 0 8px;font-size:14px}
.clx-modal .clx-detail{opacity:.8;margin-bottom:14px;white-space:pre-wrap}
.clx-modal input{width:100%;box-sizing:border-box;margin:6px 0 14px;padding:7px 9px;background:#1c1c1c;
  border:1px solid #555;border-radius:5px;color:#eee;font:inherit}
.clx-modal-btns{display:flex;justify-content:flex-end;gap:8px}
.clx-modal-btns button{padding:6px 14px;border:1px solid #555;border-radius:5px;background:#3a3a3a;color:#eee;font:inherit;cursor:pointer}
.clx-modal-btns button.clx-default{background:#3a6ea5;border-color:#3a6ea5;color:#fff}
`;
function injectStyle() {
  const el = document.createElement('style');
  el.textContent = STYLE;
  document.head.appendChild(el);
}

let bannerEl = null;
function showBanner(text) {
  if (!bannerEl) { bannerEl = document.createElement('div'); bannerEl.className = 'clx-banner'; document.body.appendChild(bannerEl); }
  bannerEl.textContent = text;
  bannerEl.style.display = 'block';
}
function hideBanner() { if (bannerEl) bannerEl.style.display = 'none'; }

let toastWrap = null;
function toast(text, opts = {}) {
  if (!toastWrap) { toastWrap = document.createElement('div'); toastWrap.className = 'clx-toast-wrap'; document.body.appendChild(toastWrap); }
  const el = document.createElement('div');
  el.className = 'clx-toast';
  if (opts.html) el.innerHTML = opts.html; else el.textContent = text;
  toastWrap.appendChild(el);
  setTimeout(() => el.remove(), opts.sticky ? 15000 : 5000);
}

// Track the pointer so a degraded context menu appears where the click was.
let lastPointer = { x: 120, y: 120 };
document.addEventListener('mousedown', (e) => { lastPointer = { x: e.clientX, y: e.clientY }; }, true);
document.addEventListener('contextmenu', (e) => { lastPointer = { x: e.clientX, y: e.clientY }; }, true);

function showMenu(menuId, items) {
  let replied = false;
  const reply = (itemId) => {
    if (replied) return;
    replied = true;
    cleanup();
    frameSend({ t: 'menu-pick', menuId, itemId: itemId != null ? itemId : null });
  };
  const openMenus = [];
  const cleanup = () => {
    for (const m of openMenus) m.remove();
    document.removeEventListener('mousedown', onDocDown, true);
    document.removeEventListener('keydown', onKey, true);
  };
  const onDocDown = (e) => { if (!openMenus.some((m) => m.contains(e.target))) reply(null); };
  const onKey = (e) => { if (e.key === 'Escape') reply(null); };

  const buildLevel = (levelItems, x, y) => {
    const menu = document.createElement('div');
    menu.className = 'clx-menu';
    for (const it of levelItems) {
      if (it.type === 'separator') { const s = document.createElement('div'); s.className = 'clx-menu-sep'; menu.appendChild(s); continue; }
      const row = document.createElement('div');
      row.className = 'clx-menu-item';
      row.dataset.enabled = it.enabled === false ? '0' : '1';
      const mark = (it.type === 'checkbox' && it.checked) ? '✓' : (it.type === 'radio' ? (it.checked ? '●' : '○') : '');
      row.innerHTML = `<span class="clx-mark">${mark}</span>${escapeHtml(it.label || '')}${it.submenu ? '<span class="clx-arrow">▸</span>' : ''}`;
      if (it.submenu && it.submenu.length) {
        let child = null;
        row.addEventListener('mouseenter', () => {
          for (let i = openMenus.length - 1; i >= 1; i--) openMenus[i].remove(), openMenus.splice(i, 1);
          const r = row.getBoundingClientRect();
          child = buildLevel(it.submenu, r.right - 4, r.top);
        });
      } else if (it.id != null) {
        row.addEventListener('mouseup', () => reply(it.id));
      }
      menu.appendChild(row);
    }
    document.body.appendChild(menu);
    // Clamp into the viewport.
    const r = menu.getBoundingClientRect();
    const px = Math.min(x, window.innerWidth - r.width - 4);
    const py = Math.min(y, window.innerHeight - r.height - 4);
    menu.style.left = `${Math.max(4, px)}px`;
    menu.style.top = `${Math.max(4, py)}px`;
    openMenus.push(menu);
    return menu;
  };

  buildLevel(items, lastPointer.x, lastPointer.y);
  document.addEventListener('mousedown', onDocDown, true);
  document.addEventListener('keydown', onKey, true);
}

function showDialog(dialogId, kind, opts) {
  let replied = false;
  const reply = (value) => {
    if (replied) return;
    replied = true;
    bg.remove();
    document.removeEventListener('keydown', onKey, true);
    frameSend({ t: 'dialog-reply', dialogId, value: value != null ? value : null });
  };
  const onKey = (e) => { if (e.key === 'Escape') reply(null); };

  const bg = document.createElement('div');
  bg.className = 'clx-modal-bg';
  bg.addEventListener('mousedown', (e) => { if (e.target === bg) reply(null); });
  const modal = document.createElement('div');
  modal.className = 'clx-modal';
  bg.appendChild(modal);

  if (kind === 'message') {
    const buttons = Array.isArray(opts.buttons) && opts.buttons.length ? opts.buttons : ['OK'];
    const defaultId = Number.isInteger(opts.defaultId) ? opts.defaultId : 0;
    modal.innerHTML = `<h3>${escapeHtml(opts.message || 'Confirm')}</h3>${opts.detail ? `<div class="clx-detail">${escapeHtml(opts.detail)}</div>` : ''}`;
    const btnRow = document.createElement('div');
    btnRow.className = 'clx-modal-btns';
    buttons.forEach((label, i) => {
      const b = document.createElement('button');
      b.textContent = label;
      if (i === defaultId) b.classList.add('clx-default');
      b.addEventListener('click', () => reply({ response: i }));
      btnRow.appendChild(b);
    });
    modal.appendChild(btnRow);
    setTimeout(() => { const d = btnRow.children[defaultId]; if (d) d.focus(); }, 0);
  } else if (kind === 'save') {
    const suggested = basename((opts.defaultPath || '').toString()) || 'export.md';
    modal.innerHTML = `<h3>Save as…</h3><div class="clx-detail">Saved on the server; a download link will appear.</div>`;
    const input = document.createElement('input');
    input.value = suggested;
    modal.appendChild(input);
    const btnRow = mkButtons(modal);
    btnRow.save.addEventListener('click', () => {
      const filename = (input.value || '').trim() || suggested;
      reply({ filename });
      const href = `/exports/${encodeURIComponent(filename)}${TOKEN ? `?token=${encodeURIComponent(TOKEN)}` : ''}`;
      toast('', { html: `Saved on server. <a href="${href}" download>Download ${escapeHtml(filename)}</a>`, sticky: true });
    });
    btnRow.cancel.addEventListener('click', () => reply(null));
    setTimeout(() => { input.focus(); input.select(); }, 0);
  } else { // open (directory picker degraded to a typed path)
    modal.innerHTML = `<h3>Choose a folder</h3><div class="clx-detail">Type an absolute path on the server.</div>`;
    const input = document.createElement('input');
    input.placeholder = '/path/to/folder';
    modal.appendChild(input);
    const btnRow = mkButtons(modal);
    btnRow.save.textContent = 'Choose';
    btnRow.save.addEventListener('click', () => { const p = (input.value || '').trim(); reply(p ? { path: p } : null); });
    btnRow.cancel.addEventListener('click', () => reply(null));
    setTimeout(() => input.focus(), 0);
  }

  document.body.appendChild(bg);
  document.addEventListener('keydown', onKey, true);
}

function mkButtons(modal) {
  const row = document.createElement('div');
  row.className = 'clx-modal-btns';
  const cancel = document.createElement('button'); cancel.textContent = 'Cancel';
  const save = document.createElement('button'); save.textContent = 'Save'; save.classList.add('clx-default');
  row.appendChild(cancel); row.appendChild(save);
  modal.appendChild(row);
  return { row, cancel, save };
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function basename(p) { return String(p).split(/[/\\]/).pop() || ''; }

// ── entrypoint: build window.api synchronously (so it exists before renderer.js
// runs), wire visibility + styling, connect, and return the welcome promise.
function start() {
  buildApi();
  injectStyle();
  document.addEventListener('visibilitychange', () => {
    frameSend({ t: 'visible', visible: document.visibilityState === 'visible' });
  });
  connect();
  return ready;
}

// Locally fire a channel into the renderer's own `on` subscribers — used by the
// in-page menu (menubar.js) to drive the request-* drawer events that the Electron
// app menu sends but the browser has no native menu for. Same routing as an
// incoming event frame, minus the wire.
function emit(channel, ...args) { dispatchEvent(channel, args); }

module.exports = { start, emit, toast, invoke };
