// Run: node --test
// Account plan quota read off our own wire's response headers (t418): the
// header parse, the per-account store, and the SELECTION rule. The selection
// rule is the reason this file exists — the bug that shipped was there and not
// in the parser, because it lived in a DOM loop nothing could reach.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { QuotaStore, parseQuotaHeaders, snapshotFrom } = require('../wire/quota');
const { shapeQuota, quotaChip, pickQuota, QUOTA_429_RECENT_S } = require('../proxy-util');

// Measured verbatim off a forwarded turn on this box, 2026-08-15. Kept whole
// (unused headers included) so a parse that starts reading a new field is
// exercised against what the wire actually sends.
const LIVE_HEADERS = {
  'content-type': 'application/json',
  'request-id': 'req_011CVn8xyz',
  'anthropic-organization-id': 'a0aca1fb-5695-4f38-854c-28911e5c20e4',
  'anthropic-workspace-id': 'wrkspc_01FGfznrrC5mnFqj7Fzsi72b',
  'anthropic-ratelimit-unified-status': 'allowed_warning',
  'anthropic-ratelimit-unified-reset': '1787043600',
  'anthropic-ratelimit-unified-representative-claim': 'seven_day',
  'anthropic-ratelimit-unified-fallback-percentage': '0.5',
  'anthropic-ratelimit-unified-5h-utilization': '0.32',
  'anthropic-ratelimit-unified-5h-status': 'allowed',
  'anthropic-ratelimit-unified-5h-reset': '1786794600',
  'anthropic-ratelimit-unified-7d-utilization': '0.95',
  'anthropic-ratelimit-unified-7d-status': 'allowed_warning',
  'anthropic-ratelimit-unified-7d-reset': '1787043600',
  'anthropic-ratelimit-unified-7d-surpassed-threshold': '0.75',
};
const NOW = 1786791110; // inside every window above

// ---- parsing ----

test('parseQuotaHeaders: the live headers split into top-level, windows and nothing else', () => {
  // Whole-object per the CLAUDE.md rule: a partial match would read around a
  // field that silently stopped being mapped.
  assert.deepStrictEqual(parseQuotaHeaders(LIVE_HEADERS), {
    fields: {
      status: 'allowed_warning',
      reset: '1787043600',
      representative_claim: 'seven_day',
      fallback_percentage: '0.5',
    },
    windows: {
      '5h': { utilization: '0.32', status: 'allowed', reset: '1786794600' },
      '7d': {
        utilization: '0.95', status: 'allowed_warning', reset: '1787043600',
        surpassed_threshold: '0.75',
      },
    },
    unmapped: {},
  });
});

test('parseQuotaHeaders: no ratelimit headers at all → null, which is the codex/429 gate', () => {
  // This null IS the structural prize: a codex turn carries no such headers, so
  // a codex seat yields no quota without anyone filtering by session type.
  assert.strictEqual(parseQuotaHeaders({ 'content-type': 'application/json' }), null);
  assert.strictEqual(parseQuotaHeaders({}), null);
  assert.strictEqual(parseQuotaHeaders(null), null);
});

test('parseQuotaHeaders: an unannounced window is discovered, never hardcoded away', () => {
  // A `7d_oi` meter appeared in 256/4000 captures with no announcement. The
  // parse must find windows FROM the names.
  const p = parseQuotaHeaders({
    'anthropic-ratelimit-unified-7d_oi-utilization': '0.11',
    'anthropic-ratelimit-unified-7d_oi-reset': '1787043600',
  });
  assert.deepStrictEqual(p.windows, { '7d_oi': { utilization: '0.11', reset: '1787043600' } });
});

test('parseQuotaHeaders: an unrecognized meter lands in unmapped rather than being dropped', () => {
  const p = parseQuotaHeaders({ 'anthropic-ratelimit-unified-quantum-flux': '9' });
  assert.deepStrictEqual(p.unmapped, { 'anthropic-ratelimit-unified-quantum-flux': '9' });
  assert.deepStrictEqual(p.windows, {});
});

test('parseQuotaHeaders: header casing does not decide whether we see the quota', () => {
  const p = parseQuotaHeaders({ 'Anthropic-RateLimit-Unified-7d-Utilization': '0.5' });
  assert.deepStrictEqual(p.windows, { '7d': { utilization: '0.5' } });
});

// ---- snapshot shape ----

test('snapshotFrom: utilization becomes both directions, and reset stays ABSOLUTE', () => {
  const store = new QuotaStore();
  const snap = store.note(LIVE_HEADERS, { now: NOW });
  assert.strictEqual(snap.primary.window, '7d');
  assert.strictEqual(snap.primary.used_pct, 95.0);
  // Hazard 1: utilization is CONSUMED, not remaining.
  assert.strictEqual(snap.primary.remaining_pct, 5.0);
  // Hazard 3: status is the server's own escalation, read not re-derived.
  assert.strictEqual(snap.primary.status, 'allowed_warning');
  // The absolute epoch, NOT a baked countdown — the whole cold/idle fix.
  assert.strictEqual(snap.primary.reset, 1787043600);
  assert.strictEqual(snap.reset, 1787043600);
  assert.ok(!('resets_in_s' in snap.primary), 'a stored countdown would freeze when traffic stops');
});

test('snapshotFrom: the claim vocabulary picks primary, and is never derived from the prefix', () => {
  // Hazard 4: `seven_day_overage_included` is the claim word; `7d_oi` is the
  // header prefix. Deriving one from the other nulled primary on ~1% of turns.
  const store = new QuotaStore();
  const snap = store.note({
    'anthropic-ratelimit-unified-representative-claim': 'seven_day_overage_included',
    'anthropic-ratelimit-unified-7d_oi-utilization': '0.4',
    'anthropic-ratelimit-unified-7d_oi-status': 'allowed',
  }, { now: NOW });
  assert.strictEqual(snap.representative_claim, 'seven_day_overage_included');
  assert.strictEqual(snap.representative_window, '7d_oi');
  assert.strictEqual(snap.primary.used_pct, 40.0);
});

test('snapshotFrom: a claim naming a window we did not receive nulls primary, not the snapshot', () => {
  const store = new QuotaStore();
  const snap = store.note({
    'anthropic-ratelimit-unified-representative-claim': 'five_hour',
    'anthropic-ratelimit-unified-7d-utilization': '0.4',
  }, { now: NOW });
  assert.strictEqual(snap.representative_window, null);
  assert.strictEqual(snap.primary, null);
  assert.strictEqual(snap.windows['7d'].used_pct, 40.0);
});

test('snapshotFrom: an unknown future claim string degrades to no primary, not a crash', () => {
  const store = new QuotaStore();
  const snap = store.note({
    'anthropic-ratelimit-unified-representative-claim': 'thirty_day',
    'anthropic-ratelimit-unified-30d-utilization': '0.4',
  }, { now: NOW });
  assert.strictEqual(snap.representative_window, null);
  assert.strictEqual(snap.windows['30d'].used_pct, 40.0);
});

// ---- the 429 hazard ----

test('note: a 429 carries no headers and must NEVER overwrite the last good reading', () => {
  // Hazard 2, measured 102/102: the response proving the wall was hit cannot
  // raise the percentage.
  const store = new QuotaStore();
  const good = store.note(LIVE_HEADERS, { now: NOW });
  assert.strictEqual(good.primary.used_pct, 95.0, 'ENTER: the good reading must land, or the assertion below proves nothing');
  const after = store.note({ 'content-type': 'application/json' }, { status: 429, now: NOW + 10 });
  assert.strictEqual(after.primary.used_pct, 95.0, 'the numbers survive the refusal');
  assert.strictEqual(after.last_429, NOW + 10);
  assert.strictEqual(after.last_429_age_s, 0);
});

test('note: a 429 with no org header is filed against the account we last read from', () => {
  // Filing it under "default" would park it beside no reading at all — a stale
  // percentage with no sign of the wall being hit.
  const store = new QuotaStore();
  store.note(LIVE_HEADERS, { now: NOW });
  const after = store.note({}, { status: 429, now: NOW + 5 });
  assert.strictEqual(after.org_id, 'a0aca1fb-5695-4f38-854c-28911e5c20e4');
  assert.strictEqual(after.last_429, NOW + 5);
});

test('note: a 429 before any reading exists has nothing to attach to and says so', () => {
  const store = new QuotaStore();
  assert.strictEqual(store.note({}, { status: 429, now: NOW }), null);
  assert.strictEqual(store.snapshot(NOW), null);
});

test('note: a good reading after a 429 keeps the refusal beside it', () => {
  // The refusal is a fact about the ACCOUNT; if one turn getting through
  // cleared it, the chip would stop reporting an ongoing refusal streak.
  const store = new QuotaStore();
  store.note(LIVE_HEADERS, { now: NOW });
  store.note({}, { status: 429, now: NOW + 5 });
  const later = store.note(LIVE_HEADERS, { now: NOW + 20 });
  assert.strictEqual(later.last_429, NOW + 5);
  assert.strictEqual(later.last_429_age_s, 15);
});

test('note: a non-quota 200 (count_tokens, codex) records nothing at all', () => {
  const store = new QuotaStore();
  assert.strictEqual(store.note({ 'content-type': 'application/json' }, { now: NOW }), null);
  assert.strictEqual(store.snapshot(NOW), null);
});

// ---- multi-account ----

test('snapshot: two accounts are kept apart and the latest read one wins', () => {
  // `accounts: 2` is real (verified as two rows in wirescope's quota_state),
  // so two bases on different accounts must not alternate numbers namelessly.
  const store = new QuotaStore();
  store.note({ ...LIVE_HEADERS, 'anthropic-organization-id': 'org-a' }, { now: NOW });
  store.note({
    'anthropic-organization-id': 'org-b',
    'anthropic-ratelimit-unified-representative-claim': 'five_hour',
    'anthropic-ratelimit-unified-5h-utilization': '0.10',
    'anthropic-ratelimit-unified-5h-status': 'allowed',
  }, { now: NOW + 1 });
  const snap = store.snapshot(NOW + 1);
  assert.strictEqual(snap.accounts, 2);
  assert.strictEqual(snap.org_id, 'org-b');
  assert.strictEqual(snap.primary.used_pct, 10.0);
});

// ---- persistence ----

test('QuotaStore: a reading survives a restart, with its absolute reset intact', () => {
  // An in-memory reading is blank until the first turn after launch, which for
  // an idle fleet can be a long time.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clodex-quota-'));
  const file = path.join(dir, 'wire-quota.sqlite');
  try {
    const a = new QuotaStore({ path: file });
    a.note(LIVE_HEADERS, { now: NOW });
    a.close();

    const b = new QuotaStore({ path: file });
    const snap = b.snapshot(NOW + 3600);
    assert.ok(snap, 'ENTER: the restore must produce a snapshot, or the assertions below are vacuous');
    assert.strictEqual(snap.primary.used_pct, 95.0);
    assert.strictEqual(snap.primary.reset, 1787043600, 'the absolute reset is what keeps the countdown honest across a restart');
    assert.strictEqual(snap.age_s, 3600, 'the reading is restored STAMPED, so its staleness stays legible');
    b.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('QuotaStore: an unopenable db degrades to memory rather than taking down the wire', () => {
  const errors = [];
  // A directory path can never be a sqlite file.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clodex-quota-'));
  try {
    const store = new QuotaStore({ path: dir, onError: (m) => errors.push(m) });
    assert.strictEqual(errors.length, 1);
    assert.match(errors[0], /^open: /);
    // Still usable in memory — the request path must not care.
    const snap = store.note(LIVE_HEADERS, { now: NOW });
    assert.strictEqual(snap.primary.used_pct, 95.0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---- the selection rule (the part whose absence let the bug ship) ----

const wireQ = (over = {}) => shapeQuota({
  status: 'allowed_warning', age_s: 1,
  primary: { window: '7d', used_pct: 95, remaining_pct: 5, reset: NOW + 1000 },
  ...over,
}, { quota: true });

test('pickQuota: nothing to show → null, not a hollow reading', () => {
  assert.strictEqual(pickQuota([]), null);
  assert.strictEqual(pickQuota(null), null);
  assert.strictEqual(pickQuota([{ quota: null, at: Date.now(), source: 'wirescope' }]), null);
});

test('pickQuota: a quota-less entry cannot win the race and blank the chip', () => {
  // THE SHIPPED BUG, in one assertion: a codex seat's payload carried no quota
  // and won freshest-wins on its timestamp alone. The old fix was a sidebar-DOM
  // session-type filter; the real fix is that a quota-less entry is not a
  // candidate at all.
  const nowMs = NOW * 1000;
  const picked = pickQuota([
    { quota: wireQ(), at: nowMs - 5000, source: 'wirescope' },
    { quota: null, at: nowMs, source: 'wirescope' },
  ], nowMs);
  assert.ok(picked, 'the older real reading must survive a newer empty one');
  assert.strictEqual(picked.quota.usedPct, 95);
});

test('pickQuota: an entry with NOTHING to display ranks below a complete one, whatever its source', () => {
  // The milder cousin of the bug above: the entry is not quota-less, so it is a
  // candidate, but it carries neither a percentage nor a window — quotaChip
  // renders null for it. Letting it win on source rank blanks a chip the
  // complete wirescope reading could have filled.
  const nowMs = NOW * 1000;
  const hollow = shapeQuota({ status: 'allowed_warning', age_s: 1 }, { quota: true });
  assert.strictEqual(hollow.usedPct, null, 'ENTER: the hollow entry really has no percentage');
  assert.strictEqual(hollow.window, null, 'ENTER: and no window — this is the case under test');
  const picked = pickQuota([
    { quota: hollow, at: nowMs, source: 'wire' },
    { quota: wireQ(), at: nowMs - 5000, source: 'wirescope' },
  ], nowMs);
  assert.strictEqual(picked.quota.usedPct, 95, 'the complete reading won despite the lower-ranked source');
  assert.ok(quotaChip(picked.quota, 0), 'and the chip renders — the point of the rule');
});

test('pickQuota: the wire source outranks wirescope even when wirescope polled later', () => {
  // The wire reading comes off our own forwarded turn; the poll is of a cache
  // that the same turn updated, so the wire cannot be the staler of the two.
  const nowMs = NOW * 1000;
  const picked = pickQuota([
    { quota: wireQ({ primary: { window: '7d', used_pct: 95, reset: NOW + 1000 } }), at: nowMs - 30000, source: 'wire' },
    { quota: wireQ({ primary: { window: '5h', used_pct: 10, reset: NOW + 1000 } }), at: nowMs, source: 'wirescope' },
  ], nowMs);
  assert.strictEqual(picked.quota.window, '7d');
});

test('pickQuota: within one source, freshest wins', () => {
  const nowMs = NOW * 1000;
  const picked = pickQuota([
    { quota: wireQ({ primary: { window: '7d', used_pct: 95, reset: NOW + 1000 } }), at: nowMs - 30000, source: 'wirescope' },
    { quota: wireQ({ primary: { window: '5h', used_pct: 10, reset: NOW + 1000 } }), at: nowMs, source: 'wirescope' },
  ], nowMs);
  assert.strictEqual(picked.quota.window, '5h');
});

test('pickQuota: a rolled window is VOID, not stale — we show nothing rather than a dead number', () => {
  // Without this, an idle fleet renders a stale 95% for a window that already
  // reset, and the countdown claims time that has passed.
  const nowMs = NOW * 1000;
  const live = pickQuota([{ quota: wireQ(), at: nowMs, source: 'wire' }], nowMs);
  assert.ok(live, 'ENTER: an unrolled window must be pickable, or the void assertion proves nothing');
  const rolled = pickQuota([
    { quota: wireQ({ primary: { window: '7d', used_pct: 95, reset: NOW - 1 } }), at: nowMs, source: 'wire' },
  ], nowMs);
  assert.strictEqual(rolled, null);
});

test('pickQuota: the countdown is derived at render time, so it ticks with no traffic at all', () => {
  const nowMs = NOW * 1000;
  const q = wireQ({ primary: { window: '7d', used_pct: 95, reset: NOW + 3600 } });
  assert.strictEqual(pickQuota([{ quota: q, at: nowMs, source: 'wire' }], nowMs).quota.resetsInS, 3600);
  // Same stored reading, an hour of silence later: the remainder MOVED.
  const later = pickQuota([{ quota: q, at: nowMs, source: 'wire' }], nowMs + 1800 * 1000);
  assert.strictEqual(later.quota.resetsInS, 1800);
});

test("pickQuota: a 429's loudness decays with no traffic at all", () => {
  // The same hazard as the countdown above, on the other clock. `last_429_age_s`
  // is computed when the reading is BUILT — under the old 5s poll it was
  // recomputed 12x/min, but the wire stamps it once per forwarded turn. A
  // refusal burst is followed by the operator STOPPING the fleet, so without
  // this derivation the chip stays loud for hours after recovery.
  const nowMs = NOW * 1000;
  const q = shapeQuota({
    status: 'allowed_warning', age_s: 1,
    primary: { window: '7d', used_pct: 95, reset: NOW + 100000 },
    last_429: NOW, last_429_age_s: 0,
  }, { quota: true });
  assert.strictEqual(q.last429At, NOW, 'ENTER: the absolute refusal epoch survived shaping');

  const now = pickQuota([{ quota: q, at: nowMs, source: 'wire' }], nowMs);
  assert.strictEqual(now.quota.last429AgeS, 0);
  assert.strictEqual(quotaChip(now.quota, 0).level, 'loud', 'ENTER: it starts loud, so the decay below is a real change');

  // The SAME stored object, past the recency window, with no new reading.
  const later = pickQuota([{ quota: q, at: nowMs, source: 'wire' }], nowMs + (QUOTA_429_RECENT_S + 60) * 1000);
  assert.strictEqual(later.quota.last429AgeS, QUOTA_429_RECENT_S + 60);
  assert.notStrictEqual(quotaChip(later.quota, 0).level, 'loud', 'the refusal aged out without another turn');
});

test('pickQuota: a reading with no absolute 429 epoch keeps its relative age', () => {
  // Symmetric with the reset fallback: a source that publishes only the
  // relative age must not lose its refusal to a field it never carried.
  const nowMs = NOW * 1000;
  const q = shapeQuota({
    status: 'allowed_warning', age_s: 1,
    primary: { window: '7d', used_pct: 95, reset: NOW + 100000 },
    last_429_age_s: 30,
  }, { quota: true });
  assert.strictEqual(q.last429At, null, 'ENTER: this fixture has no absolute refusal epoch');
  assert.strictEqual(pickQuota([{ quota: q, at: nowMs, source: 'wirescope' }], nowMs).quota.last429AgeS, 30);
});

test('pickQuota: a reading with no absolute reset keeps its relative countdown', () => {
  // A wirescope payload predating the absolute field must not be discarded for
  // a field it never carried.
  const nowMs = NOW * 1000;
  const q = shapeQuota({ status: 'allowed_warning', representative_window: '7d', resets_in_s: 900, age_s: 1 }, { quota: true });
  assert.strictEqual(q.reset, null, 'ENTER: this fixture must have no absolute reset');
  const picked = pickQuota([{ quota: q, at: nowMs, source: 'wirescope' }], nowMs);
  assert.strictEqual(picked.quota.resetsInS, 900);
});

test('pickQuota: clientAgeS measures OUR silence, so a dead source dims the chip', () => {
  const nowMs = NOW * 1000;
  const picked = pickQuota([{ quota: wireQ(), at: nowMs - 3600 * 1000, source: 'wire' }], nowMs);
  assert.strictEqual(picked.clientAgeS, 3600);
  assert.strictEqual(quotaChip(picked.quota, picked.clientAgeS).stale, true);
});

test('pickQuota: the picked reading renders through quotaChip unchanged below the swap', () => {
  // The source swap must be invisible to the chip: same shape in, same chip out.
  const nowMs = NOW * 1000;
  const picked = pickQuota([{ quota: wireQ(), at: nowMs, source: 'wire' }], nowMs);
  const chip = quotaChip(picked.quota, picked.clientAgeS);
  assert.strictEqual(chip.level, 'warn');
  assert.match(chip.text, /95% of 7d/);
  assert.match(chip.text, /resets in 16m/);
});

// ---- end to end: headers in, chip out ----

test('the whole path: live headers → store → shapeQuota → pickQuota → chip', () => {
  const store = new QuotaStore();
  const snap = store.note(LIVE_HEADERS, { now: NOW });
  const shaped = shapeQuota(snap, { quota: true });
  const picked = pickQuota([{ quota: shaped, at: NOW * 1000, source: 'wire' }], NOW * 1000);
  const chip = quotaChip(picked.quota, picked.clientAgeS);
  assert.strictEqual(chip.level, 'warn');
  assert.match(chip.text, /95% of 7d/);
  assert.match(chip.tip, /not this session/i);
});

test('the whole path: a codex turn contributes no entry, so the chip is unaffected', () => {
  // No session-type filter anywhere in this chain — header absence does it.
  const store = new QuotaStore();
  store.note(LIVE_HEADERS, { now: NOW });
  const claudeSnap = store.snapshot(NOW);
  assert.strictEqual(store.note({ 'content-type': 'text/event-stream' }, { now: NOW + 1 }), null);
  assert.deepStrictEqual(store.snapshot(NOW), claudeSnap);
});
