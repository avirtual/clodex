'use strict';
// auth-banner.test.js — the "Claude login owed" notice.
//
// `proxy.auth_refresh.stalled` means the OAuth refresh token is dead: the proxy
// cannot renew by itself, and every keep-warm hold on the box dies at the next
// lapse while the next turn pays a full cold re-cache. The failure is otherwise
// completely silent, so an inverted `hidden` or a banner that never gets called
// is the whole feature gone with nothing on screen to say so.
//
// Two halves, both pinned:
//   - the decision (renderer/lib/login-owed.js), which is DOM-free;
//   - the wiring, since a correct decision nobody calls shows nothing. The
//     banner's own toggling runs against the REAL initBanners under a DOM stub;
//     renderer.js has no harness, so its call is a source-shape pin.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { loginOwedView } = require('../renderer/lib/login-owed');

const stalled = (v) => ({ payload: { authRefresh: { stalled: v, lapsed: v, lastOutcome: null, readError: null } } });

test('no payload carries a stalled refresh → nothing shown', () => {
  assert.deepStrictEqual(loginOwedView([]), { hidden: true, text: '', tip: '' });
  assert.deepStrictEqual(loginOwedView([stalled(false), stalled(false)]), { hidden: true, text: '', tip: '' });
});

// The older proxy sends no auth_refresh block at all, so `authRefresh` arrives
// null — that must read as "nothing to show", never as a crash that takes out
// the quota refresh this runs beside.
test('a proxy too old to report it, and a malformed payload, both read as not owed', () => {
  const cases = [undefined, null, {}, { payload: null }, { payload: {} }, { payload: { authRefresh: null } }];
  for (const c of cases) {
    assert.deepStrictEqual(loginOwedView([c]), { hidden: true, text: '', tip: '' },
      `${JSON.stringify(c) || String(c)} is not a stalled reading`);
  }
  assert.deepStrictEqual(loginOwedView(null), { hidden: true, text: '', tip: '' });
});

// Account-wide, not per session: the token belongs to the box. One stalled
// payload among healthy ones is the real shape — most seats are unlinked
// precisely because the refresh failed.
test('one stalled payload among many shows the notice', () => {
  const v = loginOwedView([stalled(false), stalled(true), stalled(false)]);
  assert.strictEqual(v.hidden, false, 'ENTER: the notice is shown');
  assert.match(v.text, /claude login/i, 'and it names the command that fixes it');
  assert.match(v.text, /keep-warm/i, 'and says what is paused meanwhile');
});

test('it accepts a Map values() iterator, which is what proxyState hands it', () => {
  const proxyState = new Map([['alpha', stalled(false)], ['beta', stalled(true)]]);
  assert.strictEqual(loginOwedView(proxyState.values()).hidden, false);
  proxyState.set('beta', stalled(false));
  assert.strictEqual(loginOwedView(proxyState.values()).hidden, true);
});

// ---- the wiring ----

function el(id) {
  const e = {
    id, textContent: '', dataset: {}, classes: new Set(['hidden']),
    classList: {
      add: (c) => e.classes.add(c),
      remove: (c) => e.classes.delete(c),
      toggle: () => {},
    },
    addEventListener() {},
    appendChild(c) { return c; },
  };
  return e;
}

function withDom(fn) {
  const had = { d: global.document, w: global.window };
  const nodes = new Map(['update-banner', 'update-text', 'diag-banner', 'diag-text', 'diag-actions', 'auth-banner', 'auth-text']
    .map((id) => [id, el(id)]));
  global.document = {
    getElementById: (id) => nodes.get(id) || null,
    createElement: () => el('made'),
    addEventListener() {},
  };
  global.window = {
    api: {
      openUpdate() {},
      getUpdateInfo: async () => null,
      onUpdateAvailable() {},
      getDiagnostics: async () => null,
      toolsCheck: async () => null,
    },
  };
  try { return fn(nodes); } finally { global.document = had.d; global.window = had.w; }
}

const { initBanners } = require('../renderer/banners');

test('refreshAuthBanner shows #auth-banner on a stalled payload and hides it the tick it clears', () => {
  withDom((nodes) => {
    const { refreshAuthBanner } = initBanners({});
    assert.strictEqual(typeof refreshAuthBanner, 'function',
      'ENTER: initBanners must export the setter — an undefined one makes every assertion below vacuous');
    const banner = nodes.get('auth-banner');
    const text = nodes.get('auth-text');

    refreshAuthBanner([stalled(false)]);
    assert.ok(banner.classes.has('hidden'), 'healthy: hidden');

    refreshAuthBanner([stalled(true)]);
    assert.ok(!banner.classes.has('hidden'), 'stalled: shown');
    assert.match(text.textContent, /claude login/i, 'and the element carries the remedy text');
    assert.ok(banner.dataset.tip.length > 0, 'and a tip explaining it');

    refreshAuthBanner([stalled(false)]);
    assert.ok(banner.classes.has('hidden'), 'cleared: hidden again, on the very next call');
  });
});

// renderer.js is DOM-bound and has no harness, so the call that drives the
// banner is pinned by source shape. Without it the decision above is correct and
// nothing on screen ever changes — which is the state this feature replaces.
test('renderer.js drives the banner from the same sweep that feeds the quota chip', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'renderer.js'), 'utf8');
  assert.match(src, /const \{ refreshDiagBanner, refreshAuthBanner \} = initBanners\(/,
    'the setter must be destructured off initBanners');
  const fn = src.slice(src.indexOf('function refreshQuotaChip()'));
  const body = fn.slice(0, fn.indexOf('\n}\n'));
  assert.ok(body.length > 0 && body.includes('drawerHost.setQuota('),
    'ENTER: refreshQuotaChip\'s body must be the slice under test — an empty slice passes the check below vacuously');
  assert.match(body, /refreshAuthBanner\(proxyState\.values\(\)\)/,
    'refreshQuotaChip must re-evaluate the banner: it already runs on every payload AND on the 1s clock');
});

// The markup half. A setter aimed at an element that does not exist is a
// no-op that no source-shape pin can see.
test('the sidebar markup carries the banner the setter writes to', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'index.html'), 'utf8');
  assert.match(html, /id="auth-banner"[^>]*class="hidden"/, 'present and shipping hidden');
  assert.match(html, /id="auth-text"/);
});
