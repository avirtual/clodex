// Run: node --test
// Account plan quota: the /_status shaping (capability gate + field mapping)
// and the whole conditional-render DECISION. Both are DOM-free by construction
// — the renderer's only job is to paint what quotaChip returns, so pinning the
// decision here pins the behaviour rather than a guess at the markup.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { shapeQuota, quotaChip, fmtQuotaReset, QUOTA_429_RECENT_S, QUOTA_WINDOW_LABEL } = require('../proxy-util');
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
    // Every window the API published, shaped with the same guards. The chip
    // renders one segment per window off this; the top-level fields above stay
    // because the primary still drives the fallback and pickQuota's void-on-roll.
    windows: {
      '5h': { usedPct: 32.0, remainingPct: 68.0, status: 'allowed', reset: 1786794600, resetsInS: 3486 },
      '7d': { usedPct: 95.0, remainingPct: 5.0, status: 'allowed_warning', reset: 1787043600, resetsInS: 252486 },
      overage: { usedPct: null, remainingPct: null, status: 'rejected', reset: null, resetsInS: null },
    },
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
    windows: {},
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

// The three windows the operator's own account reports, at the percentages
// that motivated the feature. The resets are chosen so fmtQuotaReset renders
// exactly the tooltip literals below: 17520s = 4h 52m, 66720s = 18h 32m.
const THREE = (over = {}) => shapeQuota({
  status: 'allowed_warning', age_s: 1,
  primary: { window: '7d_oi', used_pct: 86, remaining_pct: 14, status: 'allowed_warning', resets_in_s: 66720 },
  windows: {
    '5h': { used_pct: 0, status: 'allowed', resets_in_s: 17520 },
    '7d': { used_pct: 76, status: 'allowed', resets_in_s: 66720 },
    '7d_oi': { used_pct: 86, status: 'allowed_warning', resets_in_s: 66720 },
  },
  ...over,
}, CAPS);

test('quotaChip: all three windows read compactly, labelled the way the CLI names them', () => {
  const chip = quotaChip(THREE());
  assert.strictEqual(chip.level, 'warn');
  assert.strictEqual(chip.text, '5h:0% | W:76% | F:86%');
  // The resets moved here, one line per window in the same order. Whole-prefix
  // literal: the point of the change is which window each number belongs to,
  // and a regex on a percentage cannot tell those apart.
  assert.ok(chip.tip.startsWith(
    '5h: 0% used, resets in 4h 52m\nweek (all models): 76% used, resets in 18h 32m\nweek (Fable): 86% used, resets in 18h 32m'),
  `tooltip did not lead with the three window lines: ${JSON.stringify(chip.tip)}`);
  assert.match(chip.tip, /not this session/i);
  assert.strictEqual(chip.stale, false);
});

test('quotaChip: a recent refusal stays last after the window bar', () => {
  const chip = quotaChip(THREE({ last_429_age_s: 120 }));
  assert.strictEqual(chip.level, 'loud');
  assert.strictEqual(chip.text, '5h:0% | W:76% | F:86% · rate-limited 2m ago');
});

test('quotaChip: every window allowed and no refusal → nothing rendered at all', () => {
  const q = THREE({
    status: 'allowed',
    primary: { window: '7d_oi', used_pct: 86, status: 'allowed', resets_in_s: 66720 },
    windows: {
      '5h': { used_pct: 0, status: 'allowed', resets_in_s: 17520 },
      '7d': { used_pct: 76, status: 'allowed', resets_in_s: 66720 },
      '7d_oi': { used_pct: 86, status: 'allowed', resets_in_s: 66720 },
    },
  });
  assert.strictEqual(Object.keys(q.windows).length, 3,
    'ENTER: the fixture must really carry three windows, or this asserts the empty-map branch');
  assert.strictEqual(quotaChip(q), null);
});

test('quotaChip: one window at rejected takes the whole chip loud', () => {
  const q = THREE({
    windows: {
      '5h': { used_pct: 0, status: 'allowed', resets_in_s: 17520 },
      '7d': { used_pct: 76, status: 'allowed', resets_in_s: 66720 },
      '7d_oi': { used_pct: 100, status: 'rejected', resets_in_s: 66720 },
    },
  });
  const chip = quotaChip(q);
  assert.strictEqual(chip.level, 'loud');
  assert.strictEqual(chip.text, '5h:0% | W:76% | F:100%');
});

test('quotaChip: a window with no percentage neither renders nor votes on the level', () => {
  // The live shape, not a hypothetical: an org with overage disabled publishes
  // `overage` at status 'rejected' with a null percentage on every payload. A
  // level scan over the raw map would hold the chip permanently loud over a
  // window it does not show.
  const q = THREE({
    windows: {
      '5h': { used_pct: 0, status: 'allowed', resets_in_s: 17520 },
      '7d': { used_pct: 76, status: 'allowed', resets_in_s: 66720 },
      '7d_oi': { used_pct: 86, status: 'allowed_warning', resets_in_s: 66720 },
      overage: { used_pct: null, status: 'rejected', resets_in_s: null, disabled_reason: 'org_level_disabled' },
    },
  });
  assert.strictEqual(q.windows.overage.status, 'rejected',
    'ENTER: the shaped map must really carry a rejected overage, or nothing is being suppressed');
  const chip = quotaChip(q);
  assert.strictEqual(chip.level, 'warn');
  assert.strictEqual(chip.text, '5h:0% | W:76% | F:86%');
  assert.doesNotMatch(chip.tip, /overage/);
});

test('quotaChip: an unknown window key falls back to the key itself, chip and tooltip alike', () => {
  const q = THREE({
    windows: {
      '5h': { used_pct: 0, status: 'allowed', resets_in_s: 17520 },
      x1: { used_pct: 12, status: 'allowed_warning', resets_in_s: 2400 },
    },
  });
  const chip = quotaChip(q);
  assert.strictEqual(chip.text, '5h:0% | x1:12%');
  assert.match(chip.tip, /^5h: 0% used, resets in 4h 52m\nx1: 12% used, resets in 40m\n/);
});

test('quotaChip: the live payload renders the windows it carries, overage dropped', () => {
  // LIVE is a verbatim /_status: three windows, `overage` percentage-less.
  const chip = quotaChip(shapeQuota(LIVE, CAPS));
  assert.strictEqual(chip.level, 'warn');
  assert.strictEqual(chip.text, '5h:32% | W:95%');
  assert.strictEqual(chip.stale, false);
});

test('quotaChip: no windows map at all → the single-window statement, reset still inline', () => {
  // A wirescope payload from a proxy that publishes only the representative
  // window. Its reset stays in the TEXT because there is no tooltip line to
  // move it to, which is the whole reason this branch is kept.
  const q = shapeQuota({ status: 'allowed_warning', age_s: 1, primary: { window: '7d', used_pct: 80, remaining_pct: 20, resets_in_s: 2400 } }, CAPS);
  assert.deepStrictEqual(q.windows, {}, 'ENTER: the fixture must carry no window map, or this pins the multi-window branch');
  const chip = quotaChip(q);
  assert.strictEqual(chip.text, 'week (all models) quota 80% used · resets in 40m');
  assert.strictEqual(chip.level, 'warn');
  assert.match(chip.tip, /20% of the week \(all models\) left\./);
});

test('quotaChip: the fallback names a 5h window the same way the bar abbreviates it', () => {
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

test('quotaChip: a top-level rejected with no window map is still loud', () => {
  const q = shapeQuota({ status: 'rejected', age_s: 1, primary: { window: '7d', used_pct: 100, resets_in_s: 2400 } }, CAPS);
  assert.deepStrictEqual(q.windows, {}, 'ENTER: no map, so the top-level status is what decides');
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

// LIVE with every shown window comfortable. The top-level status alone cannot
// silence the chip once a window map is present — the per-window statuses are
// what decide — so a test about the OTHER reasons to hide it has to calm both.
const CALM = {
  ...LIVE, status: 'allowed',
  primary: { ...LIVE.primary, status: 'allowed' },
  windows: {
    ...LIVE.windows,
    '7d': { ...LIVE.windows['7d'], status: 'allowed' },
  },
};

test('quotaChip: an OLD last_429 does not keep the chip up on its own', () => {
  const q = shapeQuota({ ...CALM, last_429_age_s: QUOTA_429_RECENT_S + 1 }, CAPS);
  assert.strictEqual(quotaChip({ ...q, last429AgeS: QUOTA_429_RECENT_S - 1 }).level, 'loud',
    'ENTER: a RECENT refusal on this fixture must be loud, or the null below proves nothing about the age');
  assert.strictEqual(quotaChip(q), null);
});

test('quotaChip: no quota (gate closed, or nothing shaped) → nothing', () => {
  assert.strictEqual(quotaChip(null), null);
  assert.strictEqual(quotaChip(shapeQuota(LIVE, {})), null);
});

test('quotaChip: an unknown status degrades to silence, never to a permanent chip', () => {
  const q = shapeQuota({
    ...CALM, status: 'some_future_value',
    windows: { ...CALM.windows, '7d': { ...CALM.windows['7d'], status: 'some_future_value' } },
  }, CAPS);
  assert.strictEqual(q.windows['7d'].status, 'some_future_value',
    'ENTER: the unknown value must reach the per-window status, which is what the level scan reads');
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
  // window label or a longer part is measured rather than assumed. Both shapes
  // the chip can emit are generated: the single-window fallback over every
  // CLAIM_WINDOW value, and the multi-window bar over every label the table
  // knows. `23h 59m` is the longest reset rendering — fmtQuotaReset's
  // `${h}h ${m}m` branch runs up to 23h, wider than any `Nd Nh` — and 100%/59s
  // the longest pct and age.
  const RESET = 23 * 3600 + 59 * 60;
  const everyWindow = {};
  for (const k of Object.keys(QUOTA_WINDOW_LABEL)) {
    everyWindow[k] = { usedPct: 100, status: 'rejected', resetsInS: RESET };
  }
  const candidates = Object.values(CLAIM_WINDOW)
    .map((w) => quotaChip({ status: 'rejected', window: w, usedPct: 100, resetsInS: RESET, last429AgeS: 59, ageS: 1 }, 0).text)
    .concat(quotaChip({ status: 'rejected', windows: everyWindow, last429AgeS: 59, ageS: 1 }, 0).text);
  const longest = candidates.reduce((a, b) => (b.length > a.length ? b : a));
  // The FALLBACK wins, not the bar the chip normally shows: spelling the window
  // out beats four abbreviated segments. Sizing to the common shape would
  // ellipsise the refusal off a wirescope reading that carries no window map.
  assert.strictEqual(longest, 'week (all models) quota 100% used · resets in 23h 59m · rate-limited 59s ago');
  assert.strictEqual(
    candidates.find((t) => t.startsWith('5h:')), '5h:100% | W:100% | F:100% | O:100% · rate-limited 59s ago',
    'ENTER: the multi-window bar must be among the candidates, or only the fallback was measured');

  // 389px measured in Electron for this string at 10px in the app's font stack,
  // border-box (padding included); 76 × 5.2 = 396 keeps the pin at or above
  // that. Re-measure rather than rescaling the constant if the wording changes.
  assert.ok(cap >= Math.ceil(longest.length * 5.2),
    `#drawer-quota max-width ${cap}px ellipsises "${longest}" (${longest.length}ch, measured 389px) — the trailing refusal is what gets cut`);
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
