// Run: node --test
// Account plan quota: the /_status shaping (capability gate + field mapping)
// and the whole conditional-render DECISION. Both are DOM-free by construction
// — the renderer's only job is to paint what quotaChip returns, so pinning the
// decision here pins the behaviour rather than a guess at the markup.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { shapeQuota, quotaChip, fmtQuotaReset, QUOTA_429_RECENT_S } = require('../proxy-util');
const { CLAIM_WINDOW } = require('../wire/quota');

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
    // Absolute epoch (t418): pickQuota derives the live remainder from this, so
    // an idle reading's countdown keeps ticking and a rolled window goes void.
    reset: 1787043600,
    ageS: 3.4,
    last429AgeS: null,
    // Absolute epoch of the last refusal, for the same reason: pickQuota
    // derives the live age from it, so the loud chip decays with no traffic.
    last429At: null,
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
    // A payload from a proxy that publishes no absolute reset: the relative
    // countdown is all there is, and pickQuota keeps it rather than voiding a
    // reading for a field it never carried.
    reset: null,
    ageS: 1,
    last429AgeS: null,
    last429At: null,
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
  // Literal, not a regex: /95%/ is true of the old "95% of 7d" shape and the
  // new one both, so only the whole string pins which one ships.
  const chip = quotaChip(shapeQuota(LIVE, CAPS));
  assert.strictEqual(chip.level, 'warn');
  assert.strictEqual(chip.text, '7d quota 95% used · resets in 2d 22h');
  assert.strictEqual(chip.stale, false);
});

test('quotaChip: the quota statement leads even when the window is at 100% and rejected', () => {
  const q = shapeQuota({ ...LIVE, status: 'rejected', primary: { ...LIVE.primary, used_pct: 100 } }, CAPS);
  const chip = quotaChip(q);
  assert.strictEqual(chip.level, 'loud');
  assert.strictEqual(chip.text, '7d quota 100% used · resets in 2d 22h');
});

test('quotaChip: a 5h window reads as its own quota statement', () => {
  const q = shapeQuota({ status: 'allowed_warning', primary: { window: '5h', used_pct: 80, resets_in_s: 2400 }, age_s: 1 }, CAPS);
  assert.strictEqual(quotaChip(q).text, '5h quota 80% used · resets in 40m');
});

test('quotaChip: a percentage with no window still says "quota", not a bare number', () => {
  // Reachable: shapeQuota maps `window` and `used_pct` independently, so a
  // payload whose representative claim did not resolve keeps the percentage.
  const q = shapeQuota({ status: 'allowed_warning', age_s: 1, primary: { used_pct: 80, resets_in_s: 2400 } }, CAPS);
  assert.strictEqual(q.window, null, 'ENTER: the window must really be absent, or this pins the windowed branch');
  assert.strictEqual(quotaChip(q).text, 'quota 80% used · resets in 40m');
});

test('quotaChip: rejected → loud', () => {
  const q = shapeQuota({ ...LIVE, status: 'rejected' }, CAPS);
  assert.strictEqual(quotaChip(q).level, 'loud');
});

test('quotaChip: a recent last_429 is loud even while status still says allowed', () => {
  // A 429 carries NO ratelimit headers, so the response that proves the wall was
  // hit cannot raise the percentage. A recent 429 beside a comfortable status is
  // the EXPECTED shape and is exactly when the operator most wants to know.
  const q = shapeQuota({ status: 'allowed', last_429_age_s: 120, age_s: 1, primary: { window: '5h', used_pct: 20, resets_in_s: 2400 } }, CAPS);
  const chip = quotaChip(q);
  assert.strictEqual(chip.level, 'loud');
  // The refusal comes LAST and past-tense: a present-tense lead made from one
  // 429 up to five minutes old contradicted the 20% beside it.
  assert.strictEqual(chip.text, '5h quota 20% used · resets in 40m · rate-limited 2m ago');
  assert.match(chip.tip, /rate-limited 2m ago/);
});

test('quotaChip: a refusal under a minute reads in seconds, and needs no percentage', () => {
  const q = shapeQuota({ status: 'allowed', last_429_age_s: 30, age_s: 1, primary: { window: '5h' } }, CAPS);
  const chip = quotaChip(q);
  assert.strictEqual(chip.level, 'loud');
  assert.strictEqual(chip.text, '5h quota · rate-limited 30s ago');
});

test('quotaChip: a fractional refusal age floors, so the seconds form never reads "60s"', () => {
  // The wire stamps last_429_age_s to 0.1s and shapeQuota passes it through
  // unrounded, so rounding would emit a seconds value the minutes branch can
  // never produce.
  const q = shapeQuota({ status: 'allowed', last_429_age_s: 59.6, age_s: 1, primary: { window: '5h' } }, CAPS);
  assert.strictEqual(quotaChip(q).text, '5h quota · rate-limited 59s ago');
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

test('quotaChip: a dead POLLER dims the chip even while the server age stays young', () => {
  // The failure the age_s rule exists to prevent, reached by the other route:
  // if delivery stops (proxy down, machine asleep, every base idle) age_s
  // freezes at whatever it last said, and a chip trusting it alone would render
  // "resets in 2d 22h" at full confidence forever.
  const q = shapeQuota({ ...LIVE, age_s: 0.5 }, CAPS);
  assert.strictEqual(quotaChip(q, 0).stale, false, 'ENTER: fresh on both clocks must be non-stale, or the assertion below proves nothing');
  const dead = quotaChip(q, 3600);
  assert.strictEqual(dead.stale, true);
  assert.match(dead.tip, /has not reported in/);
});

test('quotaChip: the two staleness causes read differently in the tip', () => {
  // "The API has not spoken" and "we are not receiving" have different
  // remedies, so one wording for both would misdirect.
  const serverStale = quotaChip(shapeQuota({ ...LIVE, age_s: 3600 }, CAPS), 0);
  assert.match(serverStale.tip, /updates only on a forwarded turn/);
  assert.doesNotMatch(serverStale.tip, /has not reported in/);
});

test('quotaChip: client age defaults to fresh when the caller omits it', () => {
  // The shaping tests and any other caller pass one argument; that must not
  // silently mean "infinitely stale".
  assert.strictEqual(quotaChip(shapeQuota(LIVE, CAPS)).stale, false);
});

test('quotaChip: the tip says the figure is the account, not the session', () => {
  // The bottom bar's neighbouring numbers are all per-SESSION; an unlabelled
  // account percentage beside them invites a category error.
  assert.match(quotaChip(shapeQuota(LIVE, CAPS)).tip, /not this session/i);
});

// The chip is DOM-free everywhere above; this one case is not, because the cap
// that decides whether the text SURVIVES to the screen lives in CSS. An
// ellipsis eats the tail, and the tail is the refusal — so a wording change
// that outgrows the cap silently hides the loudest part of the loudest chip
// while every assertion above stays green.
test('#drawer-quota max-width fits the longest string quotaChip can emit', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'styles.css'), 'utf-8');
  const rule = css.replace(/\/\*[\s\S]*?\*\//g, '').match(/#drawer-quota\s*\{([^}]*)\}/);
  assert.ok(rule, 'ENTER: the #drawer-quota rule must be found, or the width below is read off nothing');
  const cap = Number((rule[1].match(/max-width:\s*(\d+)px/) || [])[1]);
  assert.ok(Number.isFinite(cap), 'the rule sets an explicit px max-width');
  assert.match(rule[1], /text-overflow:\s*ellipsis/, 'ENTER: it ellipsises, which is what makes overflow silent');

  // Worst case built through the real function rather than hardcoded, so a new
  // window label or a longer part is measured rather than assumed. 'overage' is
  // the longest CLAIM_WINDOW label; `23h 59m` is the longest reset rendering —
  // fmtQuotaReset's `${h}h ${m}m` branch runs up to 23h, one digit wider than
  // the `4h 59m` this was first sized to and than any `Nd Nh` — and 100%/59s
  // the longest pct and age.
  const longest = Object.values(CLAIM_WINDOW)
    .map((w) => quotaChip({ status: 'rejected', window: w, usedPct: 100, resetsInS: 23 * 3600 + 59 * 60, last429AgeS: 59, ageS: 1 }, 0).text)
    .reduce((a, b) => (b.length > a.length ? b : a));
  assert.strictEqual(longest, 'overage quota 100% used · resets in 23h 59m · rate-limited 59s ago');

  // 343px measured in Electron for this string at 10px in the app's font stack,
  // border-box (padding included); 66 × 5.2 = 344 keeps the pin at or above
  // that. Re-measure rather than rescaling the constant if the wording changes.
  assert.ok(cap >= Math.ceil(longest.length * 5.2),
    `#drawer-quota max-width ${cap}px ellipsises "${longest}" (${longest.length}ch, measured 343px) — the trailing refusal is what gets cut`);
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
