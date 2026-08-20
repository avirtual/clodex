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
// A local port-forward to the BOX'S wirescope, put here by the viewer's own
// Clodex when it opened this page through a peer tunnel (t443). A PORT, not a
// base: the forward is on the viewer's loopback by construction, so this can
// only ever compose a 127.0.0.1 origin — a crafted value cannot re-point
// dashboard links somewhere else.
// Digits-only, then range: parseInt alone TRUNCATES rather than rejecting, so
// `80.5` arrives as 80 and `7800abc` as 7800 — a malformed param silently
// becoming a different, plausible port is the one way a value we refuse to
// trust could still be used.
const WIRESCOPE_PORT = (() => {
  const raw = PARAMS.get('wirescope') || '';
  if (!/^\d{1,5}$/.test(raw)) return null;
  const n = Number(raw);
  return n > 0 && n <= 65535 ? n : null;
})();
const WIRESCOPE_LOCAL_BASE = WIRESCOPE_PORT ? `http://127.0.0.1:${WIRESCOPE_PORT}` : '';
// Was this tab opened BY the viewer's own Clodex through a peer web-view forward
// (t445)? Set by peer-wiring.js `pageUrl`. It exists because the page origin
// cannot answer that question: such a tab is served from `127.0.0.1:<pinned>` on
// the VIEWER's machine and is indistinguishable by origin from a tab opened on
// the box itself — yet the engine's loopback links are correct in the second case
// and wrong in the first. `?wirescope=` could not stand in for this: it is absent
// whenever the box has no wirescope to forward, which would read as "on the box".
// Trusted only to REFUSE links, never to compose one, so a crafted value costs a
// viewer nothing but a suppressed link.
const VIA_TUNNEL = PARAMS.get('via') === 'tunnel';

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

// Does this url resolve against the engine's LOOPBACK proxyBase? The origin rule
// lives here alone: both the rewrite and the reachability gate below key on it,
// and a second copy would let them disagree about which urls are the box's.
function matchesProxyOrigin(url, proxyBase) {
  if (!url || !proxyBase) return false;
  let origin, proxyOrigin;
  try { origin = new URL(url).origin; } catch { return false; }
  try { proxyOrigin = new URL(proxyBase).origin; } catch { return false; }
  return origin === proxyOrigin;
}

// Rewrite a wirescope/proxy dashboard url so it resolves FROM THE BROWSER. The
// renderer builds those links against the engine's loopback proxyBase
// (127.0.0.1:<port>), which the browser can't reach; the container publishes
// wirescope on a separate host port advertised as wirescopePublicBase (welcome).
// If the url's origin matches proxyBase, swap the origin for publicBase, keeping
// the path/query/hash. Anything else (github links, a blank publicBase, an
// unparseable url) passes through untouched. Pure + exported for unit testing.
function rewriteExternalUrl(url, proxyBase, publicBase) {
  if (!publicBase || !matchesProxyOrigin(url, proxyBase)) return url;
  const origin = new URL(url).origin;
  return publicBase.replace(/\/+$/, '') + url.slice(origin.length);
}

// A proxyBase-origin url with NO publicBase to rewrite it to must not be opened.
// It would resolve against the VIEWER's own machine, where a local wirescope is
// usually listening on the very same port — so the operator gets their own
// dashboard rendering a foreign sessionId: confidently wrong, not visibly broken.
// Only the ssh installer leaves the public base unset, so this is the common case
// there. Keyed on origin-match AND empty publicBase — never on publicBase alone,
// which would swallow every github/release link too. Pure + exported for testing.
//
// Sees only the GLOBAL uiSettings.proxyUrl (web-host.js wirescopeReach). A
// session spawned with a per-session proxy string, or one spawned while
// proxyEnabled is false, renders its link against a base this cannot recognise
// and is still opened — rarer configurations of the same defect, left open
// deliberately rather than by oversight.
function unreachableProxyUrl(url, proxyBase, publicBase) {
  return !publicBase && matchesProxyOrigin(url, proxyBase);
}

// Which base a wirescope link is rewritten to, and THE single source of that
// answer (t443). Two candidates, and the LOCAL one wins whenever it exists: the
// box's `wirescopePublicBase` is the box's own idea of where it is publicly
// reachable, which is by construction not reachable from a viewer on the far
// side of a tunnel (it is set for a browser on the box's own host — the compose
// case). A local forward is a port on THIS machine that the viewer's Clodex
// raised specifically for this page, so it is the only candidate known to
// resolve here.
//
// Nothing outside this function may read `wirescopePublicBase`. The gate above
// and the rewrite must be fed the SAME base: if the gate kept reading the raw
// welcome field while the rewrite read the forward, a live forward would be
// suppressed as unreachable and t442 and t443 would cancel each other out. That
// single-reader rule is pinned by a source-level test.
function wirescopeBase(info) {
  return WIRESCOPE_LOCAL_BASE || (info && info.wirescopePublicBase) || '';
}

// ── the broad loopback rule (t445) ───────────────────────────────────────────
// `unreachableProxyUrl` above answers a narrow question — is THIS wirescope link
// rewritable — and its key is settled. But the defect it caught is not specific
// to wirescope: the renderer composes loopback URLs at several sites (the
// sandbox "open in browser" links compose `http://localhost:<webPort>` from a
// managed box's reported ports), and every one of them is built against the
// ENGINE's loopback while being clicked in a browser that may be somewhere else.
// So the question is asked once, about the browser, instead of once per link.
//
// A loopback URL the engine composes is correct in exactly ONE topology: the
// browser is running on the engine's own machine. Anywhere else it silently
// re-targets the viewer's own loopback, where something plausible is usually
// listening — the failure this whole class produces is a real-looking page that
// is confidently wrong, never a visible error.

// Loopback by NAME, matching what the composers actually emit: `localhost`
// (sandbox-view's openUrl) and `127.0.0.1` (proxy bases, peer forwards). The
// whole 127/8 block and IPv6 `::1` count too — a host reachable only from this
// machine is the property, not the spelling. Hostnames are already lowercased
// and bracket-stripped by URL parsing. `127.0.0.1.evil.com` is deliberately NOT
// matched: it is a public DNS name, so the suffix must not be a substring test.
function isLoopbackHost(hostname) {
  const h = String(hostname || '').replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h === '::1' || h === '0:0:0:0:0:0:0:1') return true;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h);
}

// Is this browser running on the engine's own machine? Page origin alone cannot
// answer it: a tab opened through a peer web-view forward is served from
// `127.0.0.1:<pinned>` on the VIEWER's machine, so it looks exactly like a tab
// opened on the box. Those two are the cases with opposite answers, so the
// discriminator has to be explicit — `peer-wiring.js` marks the tunnelled tab it
// opens (`pageUrl`), and this reads that mark. Anything unmarked and non-loopback
// is plainly a remote viewer.
function browserSharesEngineHost() {
  return isLoopbackHost(location.hostname) && !VIA_TUNNEL;
}

// The rule, as a pure predicate. True → the url must not be opened.
//   • not http/https, or unparseable → refuse. This is also where a proxyBase
//     typed with no scheme lands: `new URL('127.0.0.1:7800/x')` throws, so the
//     origin match above returns false and the narrow gate passes it — and
//     `window.open` then resolves it RELATIVE to the page, producing a request to
//     the box for a nonsense path. Refusing unparseable urls closes that.
//   • loopback origin while the browser is elsewhere → refuse.
// Everything else opens: github, release notes, and every loopback link when the
// browser really is on the engine's machine.
function refuseExternalUrl(url, onEngineHost) {
  let u;
  try { u = new URL(String(url)); } catch { return true; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return true;
  return isLoopbackHost(u.hostname) && !onEngineHost;
}

// ── synthetic host channels + local event fan-out.
function dispatchEvent(channel, args) {
  if (channel === 'open-external') {
    const proxyBase = welcomeInfo && welcomeInfo.proxyBase;
    // ONE base, feeding both the gate and the rewrite — see wirescopeBase.
    const publicBase = wirescopeBase(welcomeInfo);
    if (unreachableProxyUrl(args[0], proxyBase, publicBase)) {
      toast("The wirescope dashboard runs on the box's loopback — this browser has no route to it.");
      return;
    }
    const url = rewriteExternalUrl(args[0], proxyBase, publicBase);
    // A dashboard link that the rewrite claimed is EXEMPT from the broad rule
    // below, and must be: its target is `wirescopeBase`'s answer, which for a
    // tunnelled tab is a 127.0.0.1 forward raised on THIS machine for THIS page
    // — loopback, and correct. Re-judging it here would suppress exactly the
    // links t443 made work, and would make this a SECOND authority on whether a
    // dashboard link resolves. There is one authority; this defers to it.
    // (Reaching here with an origin match implies a non-empty base — the gate
    // above already returned for the empty case.)
    const claimed = matchesProxyOrigin(args[0], proxyBase);
    if (!claimed && refuseExternalUrl(url, browserSharesEngineHost())) {
      toast(`That link points at the box's own machine (${args[0]}), which this browser can't reach.`);
      return;
    }
    try { window.open(url, '_blank', 'noopener,noreferrer'); } catch { /* popup blocked */ } return;
  }
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
// The menus, dialogs and toasts follow the active theme via the same CSS custom
// properties the desktop dialogs use (defined per-theme in styles.css, bundled
// into the web build) — --sidebar-bg panels, --border edges, --accent primary,
// --text ink — so they recolour under Claude/Paper/Light instead of staying
// always-dark. The mapping mirrors the desktop analogs: .prompt-modal (modal +
// input), #btn-create/.secondary (buttons), and menubar.js's .clx-mb-* (menu).
// The reconnect banner is the deliberate exception: a fixed deep-red alarm bar,
// theme-independent so "connection lost" reads the same on every theme.
const STYLE = `
.clx-banner{position:fixed;top:0;left:0;right:0;z-index:100000;background:#8a1c1c;color:#fff;
  font:600 12px/1 -apple-system,system-ui,sans-serif;text-align:center;padding:7px 12px}
.clx-toast-wrap{position:fixed;bottom:14px;right:14px;z-index:100000;display:flex;flex-direction:column;gap:8px;align-items:flex-end}
.clx-toast{background:var(--sidebar-bg);color:var(--text);border:1px solid var(--border);
  font:400 12px/1.4 -apple-system,system-ui,sans-serif;
  padding:9px 12px;border-radius:6px;box-shadow:0 2px 10px rgba(0,0,0,.4);max-width:340px}
.clx-toast a{color:var(--accent)}
.clx-menu{position:fixed;z-index:100001;background:var(--sidebar-bg);border:1px solid var(--border);border-radius:6px;
  padding:4px 0;min-width:180px;box-shadow:0 6px 24px rgba(0,0,0,.5);
  font:400 13px/1 -apple-system,system-ui,sans-serif;color:var(--text)}
.clx-menu-item{padding:6px 26px 6px 22px;position:relative;white-space:nowrap;cursor:default}
.clx-menu-item[data-enabled="0"]{opacity:.4;pointer-events:none}
.clx-menu-item:hover{background:var(--accent);color:#fff}
.clx-menu-item .clx-mark{position:absolute;left:7px}
.clx-menu-item .clx-arrow{position:absolute;right:9px;opacity:.7}
.clx-menu-sep{height:1px;margin:4px 0;background:var(--border)}
.clx-modal-bg{position:fixed;inset:0;z-index:100002;background:rgba(0,0,0,.5);display:flex;align-items:center;justify-content:center}
.clx-modal{background:var(--sidebar-bg);color:var(--text);border:1px solid var(--border);border-radius:8px;padding:18px 20px;min-width:320px;max-width:480px;
  box-shadow:0 8px 32px rgba(0,0,0,.55);font:400 13px/1.5 -apple-system,system-ui,sans-serif}
.clx-modal h3{margin:0 0 8px;font-size:14px}
.clx-modal .clx-detail{opacity:.8;margin-bottom:14px;white-space:pre-wrap}
.clx-modal input{width:100%;box-sizing:border-box;margin:6px 0 14px;padding:7px 9px;background:var(--input-bg,var(--active-bg));
  border:1px solid var(--border);border-radius:5px;color:var(--text);font:inherit}
.clx-modal input:focus{outline:none;border-color:var(--accent)}
.clx-modal-btns{display:flex;justify-content:flex-end;gap:8px}
.clx-modal-btns button{padding:6px 14px;border:1px solid var(--border);border-radius:5px;background:var(--border);color:var(--text);font:inherit;cursor:pointer}
.clx-modal-btns button.clx-default{background:var(--accent);border-color:var(--accent);color:#fff}
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

// The ENGINE's version, as the host reported it in the welcome frame
// (web-host.js:308). Deliberately one field rather than exporting `welcomeInfo`
// wholesale: the frame also carries the token-bearing proxy reach, and a
// module-wide getter would make every future field ambiently readable.
//
// Load-bearing, not decoration: `web-dist/index.html` is tracked, so a git-deployed
// box gets a rebuilt bundle from a plain `git pull`, and this string is how an
// operator confirms the pull actually took effect. It must therefore be the
// RUNNING app's version off the wire — never re-derived browser-side, where the
// answer would come from the very bundle whose freshness is in question.
function appVersion() { return (welcomeInfo && welcomeInfo.appVersion) || null; }

module.exports = {
  start, emit, toast, invoke, rewriteExternalUrl, unreachableProxyUrl, wirescopeBase, appVersion,
  isLoopbackHost, browserSharesEngineHost, refuseExternalUrl,
};
