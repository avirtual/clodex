'use strict';

const SCRIPT_TIMEOUT_MS = 8000;
const SKIP_TYPES = ['WebSocket', 'EventSource', 'Ping'];
const LIFECYCLE_MAX = 64;
const DONE_MAX = 64;
const POLL_MIN_MS = 100;
const STREAM_MS = 8000;
const SKIP_SCHEMES = /^(blob|data):/i;

const pathOf = (u) => { try { const x = new URL(u); return x.origin + x.pathname; } catch { return String(u).split(/[?#]/)[0]; } };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const withTimeout = (p, ms, v = null) => {
  let t;
  return Promise.race([
    Promise.resolve(p).finally(() => clearTimeout(t)),
    new Promise((r) => { t = setTimeout(() => r(v), ms); }),
  ]);
};

function attachCdp(wc) {
  if (!wc.debugger.isAttached()) wc.debugger.attach('1.3');
  return wc.debugger;
}

async function emulateFocus(wc) {
  const dbg = attachCdp(wc);
  await dbg.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {});
}

async function armIdle(wc, { network = true, now = Date.now, sleepFn = sleep } = {}) {
  const dbg = attachCdp(wc);
  await dbg.sendCommand('Page.enable');
  await dbg.sendCommand('Page.setLifecycleEventsEnabled', { enabled: true });
  if (network) await dbg.sendCommand('Network.enable');
  const fired = { lifecycle: [], didStopLoading: false, inPage: false, requests: 0 };
  const inflight = new Map();
  const done = [];
  let lastNet = now();
  const onMsg = (_e, method, params) => {
    if (method === 'Page.lifecycleEvent') {
      fired.lifecycle.push(params.name);
      if (fired.lifecycle.length > LIFECYCLE_MAX) fired.lifecycle.shift();
    }
    else if (method === 'Network.requestWillBeSent' && !SKIP_TYPES.includes(params.type) && !SKIP_SCHEMES.test(String((params.request || {}).url || ''))) {
      inflight.set(params.requestId, { url: params.request.url, method: params.request.method, at: now() });
      fired.requests++;
      lastNet = now();
    } else if (method === 'Network.loadingFinished' || method === 'Network.loadingFailed') {
      const v = inflight.get(params.requestId);
      if (v) { done.push({ path: pathOf(v.url), method: v.method, at: now(), ms: now() - v.at }); if (done.length > DONE_MAX) done.shift(); }
      if (inflight.delete(params.requestId)) lastNet = now();
    }
  };
  const onStop = () => { fired.didStopLoading = true; };
  const onInPage = () => { fired.inPage = true; };
  dbg.on('message', onMsg);
  wc.on('did-stop-loading', onStop);
  wc.on('did-navigate-in-page', onInPage);
  const detach = () => {
    dbg.removeListener('message', onMsg);
    wc.removeListener('did-stop-loading', onStop);
    wc.removeListener('did-navigate-in-page', onInPage);
  };
  const active = () => {
    const cut = now() - STREAM_MS;
    return [...inflight.values()].filter((v) => v.at > cut);
  };
  const wait = async ({ quietMs = 500, graceMs = 0, timeoutMs = 15000, shouldStop = null } = {}) => {
    const t0 = now();
    let lastChurn = [];
    let lastPolls = null;
    const polling = () => { const cut = now() - quietMs * 4; const recent = done.filter((d) => d.at > cut && d.ms < 2000); const by = new Map(); for (const d of recent) { const k = d.method + ' ' + d.path; by.set(k, (by.get(k) || 0) + 1); } const tops = [...by.entries()].filter(([, n]) => n >= 3).sort((a, b) => b[1] - a[1]).slice(0, 3); if (!tops.length) return null; const keys = new Set(tops.map(([k]) => k)); const ts = recent.filter((d) => keys.has(d.method + ' ' + d.path)).map((d) => d.at).sort((a, b) => a - b); const everyMs = Math.round((ts[ts.length - 1] - ts[0]) / (ts.length - 1)); if (everyMs < POLL_MIN_MS) return null; const other = recent.filter((d) => !keys.has(d.method + ' ' + d.path)); if (other.length > tops.length) return null; return { paths: tops.map(([k]) => k.slice(k.indexOf(' ') + 1)), keys: [...keys], everyMs }; };
    const pub = (p) => p ? { paths: p.paths, everyMs: p.everyMs } : null;
    const held = () => { const cut = now() - 2000; const recent = done.filter((d) => d.at > cut); if (!recent.length) return null; const by = new Map(); for (const d of recent) { const k = d.method + ' ' + d.path; by.set(k, (by.get(k) || 0) + 1); } return { n: recent.length, top: [...by.entries()].sort((a, b) => b[1] - a[1]).slice(0, 2).map(([k, n]) => ({ method: k.slice(0, k.indexOf(' ')), path: k.slice(k.indexOf(' ') + 1), n })) }; };
    const onlyPolls = (p) => active().length === 0 || (!!p && active().every((v) => p.keys.includes(v.method + ' ' + pathOf(v.url))));
    if (graceMs) await sleep(graceMs);
    try {
      for (;;) {
        if (wc.isDestroyed()) return { ok: false, reason: 'destroyed', ms: now() - t0, fired, inflight: [] };
        if (shouldStop && shouldStop()) return { ok: true, stopped: true, ms: now() - t0, fired };
        if (now() - t0 > timeoutMs) {
          return { ok: false, reason: 'timeout', ms: now() - t0, fired, inflight: active().slice(0, 5).map((v) => v.url), ...(lastChurn.length ? { churn: lastChurn } : {}), ...(lastPolls ? { polls: pub(lastPolls) } : {}), ...(held() ? { held: held() } : {}) };
        }
        const polls = polling();
        if (polls) lastPolls = polls;
        if (!wc.isLoading() && onlyPolls(polls)) {
          const q = await withTimeout(wc.executeJavaScript(`new Promise(res => {
            let last = performance.now(); const hits = new Map(); const label = k => k.tagName.toLowerCase() + (k.id ? '#' + k.id : '') + (k.classList && k.classList[0] ? '.' + k.classList[0] : ''); const mo = new MutationObserver(ms => { last = performance.now(); for (const m of ms) { const k = m.target.nodeType === 1 ? m.target : m.target.parentElement; if (k) hits.set(k, (hits.get(k) || 0) + 1); } });
            mo.observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
            const t0 = performance.now(); const tick = () => { const q = performance.now() - last; if (q >= ${quietMs}) { mo.disconnect(); res({ state: document.readyState }); return; } if (performance.now() - t0 >= ${quietMs} * 4 && hits.size > 0 && hits.size <= 8 && [...hits.values()].every(n => n >= 3)) { mo.disconnect(); const k = [...hits.entries()].sort((a, b) => b[1] - a[1])[0][0]; res({ state: document.readyState, ticker: label(k) }); return; } if (performance.now() - t0 >= ${quietMs} * 4 + 2000) { mo.disconnect(); res({ state: document.readyState, churn: [...hits.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k]) => label(k)) }); return; } setTimeout(tick, 100); }; setTimeout(tick, 100); })`).catch(() => null), quietMs * 4 + 3000);
          const state = q && typeof q === 'object' ? q.state : q; const ticker = q && typeof q === 'object' && q.ticker ? String(q.ticker).replace(/[^\w#.:-]/g, '').slice(0, 60) : '';
          const churn = q && typeof q === 'object' && Array.isArray(q.churn) ? q.churn.map(x => String(x).replace(/[^\w#.:-]/g, '').slice(0, 40)).filter(Boolean).slice(0, 3) : [];
          if (churn.length) lastChurn = churn;
          if (state === 'complete' && !churn.length && !wc.isLoading() && onlyPolls(polls) && (polls ? !done.some((d) => !polls.keys.includes(d.method + ' ' + d.path) && d.at > now() - quietMs) : now() - lastNet >= quietMs)) {
            return { ok: true, ms: now() - t0, fired, ...(ticker ? { ticker } : {}), ...(pub(polls) ? { polls: pub(polls) } : {}) };
          }
        }
        await sleepFn(100);
      }
    } finally {
      detach();
    }
  };
  const size = (minAgeMs = 0) => {
    const cut = now() - minAgeMs;
    return active().filter((v) => v.at <= cut).length;
  };
  const background = () => inflight.size - active().length;
  return { wait, fired, detach, size, background, reset: () => { inflight.clear(); done.length = 0; }, lastNet: () => lastNet };
}

async function waitIdle(wc, opts = {}) {
  return (await armIdle(wc, opts)).wait(opts);
}

let synth = false;

function S(wc, ev) {
  synth = true;
  try { wc.sendInputEvent(ev); } finally { synth = false; }
}

const KEYS = {
  Enter: { code: 'Return', char: '\r' },
  Tab: { code: 'Tab' },
  Escape: { code: 'Escape' },
  Backspace: { code: 'Backspace' },
  Delete: { code: 'Delete' },
  ArrowUp: { code: 'Up' },
  ArrowDown: { code: 'Down' },
  ArrowLeft: { code: 'Left' },
  ArrowRight: { code: 'Right' },
  PageUp: { code: 'PageUp' },
  PageDown: { code: 'PageDown' },
  Home: { code: 'Home' },
  End: { code: 'End' },
  Space: { code: 'Space', char: ' ' },
};

function installFilters(wc, { driving, onOperator }) {
  wc.on('before-input-event', (e, i) => {
    if (synth) return;
    if (driving()) { e.preventDefault(); return; }
    if (i && (i.type === 'keyDown' || i.type === 'rawKeyDown')) onOperator();
  });
  wc.on('before-mouse-event', (e, m) => {
    if (synth) return;
    if (driving()) { e.preventDefault(); return; }
    if (m && (m.type === 'mouseDown' || m.type === 'mouseWheel')) onOperator();
  });
}

async function quietGate({ lastInputAt, quietMs = 3000, maxMs = 60000, shouldStop = null, now = Date.now, sleepFn = sleep, stepMs = 100 }) {
  const t0 = now();
  for (;;) {
    if (shouldStop && shouldStop()) return 'stopped';
    if (now() - lastInputAt() >= quietMs) return 'quiet';
    if (now() - t0 >= maxMs) return 'busy';
    await sleepFn(stepMs);
  }
}

function click(wc, pt) {
  const z = wc.getZoomFactor() || 1;
  const x = Math.round(pt.x * z);
  const y = Math.round(pt.y * z);
  S(wc, { type: 'mouseMove', x, y });
  S(wc, { type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
  S(wc, { type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
}

async function typeText(wc, text) {
  for (const ch of String(text)) {
    if (ch.codePointAt(0) > 0xffff) { await wc.insertText(ch); continue; }
    S(wc, { type: 'keyDown', keyCode: ch });
    S(wc, { type: 'char', keyCode: ch });
    S(wc, { type: 'keyUp', keyCode: ch });
  }
}

function pressKey(wc, name) {
  const k = KEYS[name];
  if (!k) throw new Error(`unknown key ${name}`);
  S(wc, { type: 'keyDown', keyCode: k.code });
  if (k.char) S(wc, { type: 'char', keyCode: k.char });
  S(wc, { type: 'keyUp', keyCode: k.code });
}

async function act(wc, fn, opts = {}) {
  const idle = await armIdle(wc, opts);
  let r;
  try {
    r = await fn();
  } catch (e) {
    idle.detach();
    throw e;
  }
  return { r, idle: await idle.wait(opts) };
}

async function pinSessionCookies(ses, days = 30) {
  const all = await ses.cookies.get({});
  let n = 0;
  for (const c of all.filter((x) => x.session)) {
    const host = String(c.domain || '').replace(/^\./, '');
    const hostPrefixed = c.name.startsWith('__Host-');
    const url = (c.secure ? 'https://' : 'http://') + host + (hostPrefixed ? '/' : c.path || '/');
    try {
      await ses.cookies.set({
        url,
        name: c.name,
        value: c.value,
        domain: c.hostOnly || hostPrefixed ? undefined : c.domain,
        path: hostPrefixed ? '/' : c.path,
        secure: hostPrefixed ? true : c.secure,
        httpOnly: c.httpOnly,
        sameSite: c.sameSite,
        expirationDate: Date.now() / 1000 + days * 86400,
      });
      n++;
    } catch {}
  }
  await ses.cookies.flushStore();
  return n;
}

module.exports = {
  withTimeout, attachCdp, emulateFocus, armIdle, waitIdle, act, pinSessionCookies, sleep, SCRIPT_TIMEOUT_MS, LIFECYCLE_MAX, STREAM_MS,
  S, installFilters, quietGate, click, typeText, pressKey, KEYS,
};
