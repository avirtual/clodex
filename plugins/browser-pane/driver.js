'use strict';

const SCRIPT_TIMEOUT_MS = 8000;
const SKIP_TYPES = ['WebSocket', 'EventSource', 'Ping'];

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

async function armIdle(wc, { network = true } = {}) {
  const dbg = attachCdp(wc);
  await dbg.sendCommand('Page.enable');
  await dbg.sendCommand('Page.setLifecycleEventsEnabled', { enabled: true });
  if (network) await dbg.sendCommand('Network.enable');
  const fired = { lifecycle: [], didStopLoading: false, inPage: false, requests: 0 };
  const inflight = new Map();
  let lastNet = Date.now();
  const onMsg = (_e, method, params) => {
    if (method === 'Page.lifecycleEvent') fired.lifecycle.push(params.name);
    else if (method === 'Network.requestWillBeSent' && !SKIP_TYPES.includes(params.type)) {
      inflight.set(params.requestId, params.request.url);
      fired.requests++;
      lastNet = Date.now();
    } else if (method === 'Network.loadingFinished' || method === 'Network.loadingFailed') {
      if (inflight.delete(params.requestId)) lastNet = Date.now();
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
  const wait = async ({ quietMs = 500, graceMs = 0, timeoutMs = 15000, shouldStop = null } = {}) => {
    const t0 = Date.now();
    if (graceMs) await sleep(graceMs);
    try {
      for (;;) {
        if (wc.isDestroyed()) return { ok: false, reason: 'destroyed', ms: Date.now() - t0, fired, inflight: [] };
        if (shouldStop && shouldStop()) return { ok: true, stopped: true, ms: Date.now() - t0, fired };
        if (Date.now() - t0 > timeoutMs) {
          return { ok: false, reason: 'timeout', ms: Date.now() - t0, fired, inflight: [...inflight.values()].slice(0, 5) };
        }
        if (!wc.isLoading() && inflight.size === 0) {
          const q = await withTimeout(wc.executeJavaScript(`new Promise(res => {
            let last = performance.now(); const mo = new MutationObserver(() => last = performance.now());
            mo.observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
            const tick = () => { if (performance.now() - last >= ${quietMs}) { mo.disconnect(); res(document.readyState); } else setTimeout(tick, 100); };
            setTimeout(tick, 100); })`).catch(() => null), quietMs + 3000);
          if (q === 'complete' && !wc.isLoading() && inflight.size === 0 && Date.now() - lastNet >= quietMs) {
            return { ok: true, ms: Date.now() - t0, fired };
          }
        }
        await sleep(100);
      }
    } finally {
      detach();
    }
  };
  return { wait, fired, detach };
}

async function waitIdle(wc, opts = {}) {
  return (await armIdle(wc, opts)).wait(opts);
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

module.exports = { withTimeout, attachCdp, armIdle, waitIdle, act, pinSessionCookies, sleep, SCRIPT_TIMEOUT_MS };
