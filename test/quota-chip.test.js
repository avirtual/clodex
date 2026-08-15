// Run: node --test
// Account plan quota: the /_status shaping (capability gate + field mapping)
// and the whole conditional-render DECISION. Both are DOM-free by construction
// — the renderer's only job is to paint what quotaChip returns, so pinning the
// decision here pins the behaviour rather than a guess at the markup.
const { test } = require('node:test');
const assert = require('node:assert');
const { shapeQuota, quotaChip, fmtQuotaReset, QUOTA_429_RECENT_S } = require('../proxy-util');

// Measured verbatim off this box's wirescope v0.6.53 /_status at 95% weekly.
// Kept whole (unused keys included) so a shaping that starts reading a new
// field is exercised against a payload the server actually sends.
const LIVE = {
  as_of: 1786791110.2520661,
  age_s: 3.4,
  source: 'response_headers',
  status: 'allowed_warning',
  reset: 1787043600,
  resets_in_s: 252486,
  representative_claim: 'seven_day',
  representative_window: '7d',
  primary: {
    window: '7d',
    utilization: 0.95,
    used_pct: 95.0,
    remaining_pct: 5.0,
    status: 'allowed_warning',
    reset: 1787043600,
    resets_in_s: 252486,
    surpassed_threshold: 0.75,
  },
  windows: {
    '5h': { window: '5h', utilization: 0.32, used_pct: 32.0, remaining_pct: 68.0, status: 'allowed', reset: 1786794600, resets_in_s: 3486 },
    '7d': { window: '7d', utilization: 0.95, used_pct: 95.0, remaining_pct: 5.0, status: 'allowed_warning', reset: 1787043600, resets_in_s: 252486, surpassed_threshold: 0.75 },
    overage: { window: 'overage', utilization: null, used_pct: null, remaining_pct: null, status: 'rejected', reset: null, resets_in_s: null, disabled_reason: 'org_level_disabled' },
  },
  org_id: 'a0aca1fb-5695-4f38-854c-28911e5c20e4',
  workspace_id: 'wrkspc_01FGfznrrC5mnFqj7Fzsi72b',
  accounts: 1,
  fallback_percentage: 0.5,
  last_429: null,
  last_429_age_s: null,
};

const CAPS = { quota: true, stats: true };

// ---- shaping ----

test('shapeQuota: the live payload maps to the whole shaped object', () => {
  // Whole-object, per the CLAUDE.md rule: a partial match would read around a
  // field that silently stopped being mapped, and every downstream assertion
  // here is about values that are legal when undefined.
  assert.deepStrictEqual(shapeQuota(LIVE, CAPS), {
    status: 'allowed_warning',
    window: '7d',
    usedPct: 95.0,
    remainingPct: 5.0,
    resetsInS: 252486,
    ageS: 3.4,
    last429AgeS: null,
  });
});

test('shapeQuota: gated on capabilities.quota — an older proxy shapes to null', () => {
  // ENTER: the same payload with the capability present must shape, or this
  // asserts the gate using an input that was going to be null anyway.
  assert.notStrictEqual(shapeQuota(LIVE, CAPS), null);
  assert.strictEqual(shapeQuota(LIVE, { stats: true }), null);
  assert.strictEqual(shapeQuota(LIVE, {}), null);
  assert.strictEqual(shapeQuota(LIVE, null), null);
});

test('shapeQuota: capability on but no block (or a junk one) → null, not a hollow object', () => {
  assert.strictEqual(shapeQuota(null, CAPS), null);
  assert.strictEqual(shapeQuota(undefined, CAPS), null);
  assert.strictEqual(shapeQuota('nope', CAPS), null);
});

test('shapeQuota: a missing primary falls back to the top-level window/reset', () => {
  const q = shapeQuota({ status: 'allowed_warning', representative_window: '7d', resets_in_s: 900, age_s: 1 }, CAPS);
  assert.deepStrictEqual(q, {
    status: 'allowed_warning',
    window: '7d',
    usedPct: null,
    remainingPct: null,
    resetsInS: 900,
    ageS: 1,
    last429AgeS: null,
  });
});

test('shapeQuota: non-finite numbers do not survive as numbers', () => {
  // A NaN here would render as "NaN%" — legal arithmetic, plausible-looking output.
  const q = shapeQuota({ status: 'allowed_warning', primary: { window: '7d', used_pct: NaN, resets_in_s: Infinity } }, CAPS);
  assert.strictEqual(q.usedPct, null);
  assert.strictEqual(q.resetsInS, null);
});

// ---- the render decision ----

test('quotaChip: allowed → nothing rendered at all', () => {
  const q = shapeQuota({ ...LIVE, status: 'allowed', primary: { ...LIVE.primary, status: 'allowed', used_pct: 32 } }, CAPS);
  assert.notStrictEqual(q, null, 'ENTER: the shaping must succeed, or this pins the gate rather than the allowed branch');
  assert.strictEqual(quotaChip(q), null);
});

test('quotaChip: allowed_warning → visible, carrying percent, window and reset', () => {
  const chip = quotaChip(shapeQuota(LIVE, CAPS));
  assert.strictEqual(chip.level, 'warn');
  assert.match(chip.text, /95%/);
  assert.match(chip.text, /7d/);
  assert.match(chip.text, /resets in 2d 22h/);
  assert.strictEqual(chip.stale, false);
});

test('quotaChip: rejected → loud', () => {
  const q = shapeQuota({ ...LIVE, status: 'rejected' }, CAPS);
  assert.strictEqual(quotaChip(q).level, 'loud');
});

test('quotaChip: a recent last_429 is loud even while status still says allowed', () => {
  // A 429 carries NO ratelimit headers, so the response that proves the wall was
  // hit cannot raise the percentage. A recent 429 beside a comfortable status is
  // the EXPECTED shape and is exactly when the operator most wants to know.
  const q = shapeQuota({ ...LIVE, status: 'allowed', last_429_age_s: 30 }, CAPS);
  const chip = quotaChip(q);
  assert.strictEqual(chip.level, 'loud');
  assert.match(chip.text, /rate limited/);
});

test('quotaChip: an OLD last_429 does not keep the chip up on its own', () => {
  const q = shapeQuota({ ...LIVE, status: 'allowed', last_429_age_s: QUOTA_429_RECENT_S + 1 }, CAPS);
  assert.strictEqual(quotaChip(q), null);
});

test('quotaChip: no quota (gate closed, or nothing shaped) → nothing', () => {
  assert.strictEqual(quotaChip(null), null);
  assert.strictEqual(quotaChip(shapeQuota(LIVE, {})), null);
});

test('quotaChip: an unknown status degrades to silence, never to a permanent chip', () => {
  const q = shapeQuota({ ...LIVE, status: 'some_future_value' }, CAPS);
  assert.strictEqual(quotaChip(q), null);
});

test('quotaChip: a stale reading is marked, since nothing polls the API', () => {
  const fresh = quotaChip(shapeQuota({ ...LIVE, age_s: 3 }, CAPS));
  const old = quotaChip(shapeQuota({ ...LIVE, age_s: 3600 }, CAPS));
  assert.strictEqual(fresh.stale, false);
  assert.strictEqual(old.stale, true);
  assert.match(old.tip, /Stale/);
});

test('quotaChip: the tip says the figure is the account, not the session', () => {
  // The bottom bar's neighbouring numbers are all per-SESSION; an unlabelled
  // account percentage beside them invites a category error.
  assert.match(quotaChip(shapeQuota(LIVE, CAPS)).tip, /not this session/i);
});

test('fmtQuotaReset: minutes, hours and days; nothing for absent or elapsed', () => {
  assert.strictEqual(fmtQuotaReset(90), '1m');
  assert.strictEqual(fmtQuotaReset(3600), '1h');
  assert.strictEqual(fmtQuotaReset(5400), '1h 30m');
  assert.strictEqual(fmtQuotaReset(252486), '2d 22h');
  assert.strictEqual(fmtQuotaReset(0), null);
  assert.strictEqual(fmtQuotaReset(null), null);
  assert.strictEqual(fmtQuotaReset(NaN), null);
});
