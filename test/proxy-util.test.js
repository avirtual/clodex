// Run: node --test
// Covers the reviewed risk surface: proxy-agent identity lifecycle (which
// session actions preserve vs reset identity), nonce uniqueness, and the
// /_status record shaping.
const { test } = require('node:test');
const assert = require('node:assert');
const {
  PROXY_AGENT_PREFIX, mintProxyAgent, resolveProxyAgentId, pickProxyRecord, shapeProxyRecord,
} = require('../proxy-util');

test('mintProxyAgent: prefixed, name-embedded, unique against taken set', () => {
  let n = 0;
  const seq = ['aaaa', 'aaaa', 'bbbb']; // first two collide, third is free
  const rand = () => seq[n++];
  const taken = new Set(['clodex-foo-aaaa']);
  const id = mintProxyAgent('foo', taken, rand);
  assert.ok(id.startsWith(PROXY_AGENT_PREFIX));
  assert.strictEqual(id, 'clodex-foo-bbbb'); // skipped the collision
});

test('lifecycle: fresh create mints a new id', () => {
  const id = resolveProxyAgentId({ name: 'a', fork: false, existing: null, taken: new Set(), rand: () => 'dead' });
  assert.strictEqual(id, 'clodex-a-dead');
});

test('lifecycle: resume/restart/restore reuse the persisted id', () => {
  const existing = { proxyAgent: 'clodex-a-keep' };
  const id = resolveProxyAgentId({ name: 'a', fork: false, existing, taken: new Set(), rand: () => 'new' });
  assert.strictEqual(id, 'clodex-a-keep'); // continuity → same ledger
});

test('lifecycle: fork mints a new id even when one is persisted', () => {
  const existing = { proxyAgent: 'clodex-a-old' };
  const id = resolveProxyAgentId({ name: 'a', fork: true, existing, taken: new Set(), rand: () => 'fork' });
  assert.strictEqual(id, 'clodex-a-fork'); // divergent session → fresh ledger
});

test('lifecycle: legacy entry without proxyAgent lazy-mints', () => {
  const existing = { name: 'a' }; // predates the field
  const id = resolveProxyAgentId({ name: 'a', fork: false, existing, taken: new Set(), rand: () => 'mint' });
  assert.strictEqual(id, 'clodex-a-mint');
});

test('lifecycle: recycled name cannot inherit old telemetry', () => {
  // Old session "foo" left a record under clodex-foo-old. A brand-new "foo"
  // (no persisted entry) mints a different id, so an exact-equality match
  // against the stale record is impossible.
  const oldId = 'clodex-foo-old';
  const newId = resolveProxyAgentId({ name: 'foo', fork: false, existing: null, taken: new Set([oldId]), rand: () => 'newx' });
  assert.notStrictEqual(newId, oldId);
});

test('shapeProxyRecord: null record → unlinked, carries probe metadata', () => {
  const probe = { version: 'v1', capabilities: { stats: true } };
  const p = shapeProxyRecord(null, probe, 123);
  assert.deepStrictEqual(p, { ts: 123, version: 'v1', capabilities: { stats: true }, linked: false });
});

test('shapeProxyRecord: maps wire fields to renderer payload', () => {
  const probe = { version: 'v1', capabilities: { stats: true } };
  const r = {
    session_id: 'sid', model: 'claude-opus-4-8',
    cost: { est_usd: 1.25, main_est_usd: 0.07, requests: 7 },
    turns_completed: 4, refusals: 2,
    context: { turns_in_context: 9, n_messages: 30, input_tokens: 185218 },
    warmth: { state: 'warm', remaining_s: 280.4, ttl_s: 300 },
    pingable: true,
    hold: { until: 123, hours: 4 },
  };
  const p = shapeProxyRecord(r, probe, 1);
  assert.strictEqual(p.linked, true);
  assert.deepStrictEqual(p.cost, { usd: 1.25, mainUsd: 0.07, requests: 7 });
  assert.deepStrictEqual(p.context, { turns: 9, messages: 30, inputTokens: 185218 });
  assert.deepStrictEqual(p.warmth, { state: 'warm', remaining_s: 280.4, ttl_s: 300 });
  assert.strictEqual(p.refusals, 2);
  assert.strictEqual(p.turns, 4);
  assert.strictEqual(p.pingable, true);
  assert.deepStrictEqual(p.hold, { until: 123, hours: 4 });
});

test('shapeProxyRecord: since_compact shaped per the frozen wirescope contract', () => {
  const probe = { version: 'v1', capabilities: {} };
  const r = {
    session_id: 's',
    since_compact: { turns: 12, requests: 61, est_usd: 0.4321, boundary_ts: 1752570000.5, compacted: true },
  };
  const p = shapeProxyRecord(r, probe, 1);
  assert.deepStrictEqual(p.sinceCompact, {
    turns: 12, requests: 61, estUsd: 0.4321, boundaryTs: 1752570000.5, compacted: true,
  });
});

test('shapeProxyRecord: since_compact absent or null → null (absent === null per contract)', () => {
  const probe = { version: 'v1', capabilities: {} };
  assert.strictEqual(shapeProxyRecord({ session_id: 's' }, probe, 1).sinceCompact, null);
  assert.strictEqual(shapeProxyRecord({ session_id: 's', since_compact: null }, probe, 1).sinceCompact, null);
});

test('shapeProxyRecord: pingable defaults false when absent', () => {
  const probe = { version: 'v1', capabilities: {} };
  const p = shapeProxyRecord({ session_id: 's' }, probe, 1);
  assert.strictEqual(p.pingable, false);
});

test('shapeProxyRecord: codex-style nulls (no warmth/context) degrade cleanly', () => {
  const probe = { version: 'v1', capabilities: { stats: true } };
  const r = { session_id: 's', model: 'gpt-5.1-codex', cost: { est_usd: 0.01, requests: 3 }, warmth: null, context: null };
  const p = shapeProxyRecord(r, probe, 1);
  assert.strictEqual(p.warmth, null);
  assert.strictEqual(p.context, null);
  // pre-.22 wire: no main_est_usd → mainUsd null (unbilled ≠ $0)
  assert.deepStrictEqual(p.cost, { usd: 0.01, mainUsd: null, requests: 3 });
});

test('pickProxyRecord: empty / null candidates → null', () => {
  assert.strictEqual(pickProxyRecord(null, 'x'), null);
  assert.strictEqual(pickProxyRecord([], 'x'), null);
});

test('pickProxyRecord: /clear regression — binds the live session, not the clear-ended one', () => {
  // The real /_status order that bit us: live record FIRST, clear-ended SECOND,
  // both under one agent id. Last-writer-wins would pick the dead one.
  const live = { agent: 'clodex-clodex-1bf', session_id: 'new', ended: null, last_seen: 200 };
  const dead = { agent: 'clodex-clodex-1bf', session_id: 'old', ended: { reason: 'clear' }, last_seen: 100 };
  assert.strictEqual(pickProxyRecord([live, dead], 'new'), live);
});

test('pickProxyRecord: exact session id wins even against a newer record', () => {
  const tracked = { session_id: 'mine', ended: null, last_seen: 1 };
  const newer = { session_id: 'other', ended: null, last_seen: 999 };
  assert.strictEqual(pickProxyRecord([newer, tracked], 'mine'), tracked);
});

test('pickProxyRecord: no session id → prefer live, most-recently-seen', () => {
  const dead = { session_id: 'a', ended: { reason: 'clear' }, last_seen: 999 };
  const liveOld = { session_id: 'b', ended: null, last_seen: 10 };
  const liveNew = { session_id: 'c', ended: null, last_seen: 50 };
  assert.strictEqual(pickProxyRecord([dead, liveOld, liveNew], null), liveNew);
});

test('pickProxyRecord: all ended → fall back to most-recently-seen', () => {
  const older = { session_id: 'a', ended: { reason: 'clear' }, last_seen: 10 };
  const newer = { session_id: 'b', ended: { reason: 'clear' }, last_seen: 20 };
  assert.strictEqual(pickProxyRecord([older, newer], 'missing'), newer);
});

// --- subagent child-row labels ----------------------------------------------
// Live-wire regression (stocks session, 07-07): named spawns arrived with
// display_name null + role "subagent" + the given name inside agent_id — three
// rows all rendered the generic "subagent". The label must prefer the id's
// name part; built-ins whose agent_id is a bare UUID keep their role label.
const { shapeSubagent } = require('../proxy-util');

test('shapeSubagent label: named spawn — agent_id name beats generic role', () => {
  const s = shapeSubagent({
    key: 'stock-diligence-FIG@session-2bcc26b4',
    agent_id: 'stock-diligence-FIG@session-2bcc26b4',
    role: 'subagent', display_name: null, model: 'claude-sonnet-5',
  }, 1000);
  assert.strictEqual(s.label, 'stock-diligence-FIG');
  assert.strictEqual(s.key, 'stock-diligence-FIG@session-2bcc26b4'); // key untouched — detail param
});

test('shapeSubagent label: UUID agent_id falls back to role', () => {
  const s = shapeSubagent({
    key: 'k1', agent_id: '4a59af49-cc52-44b7-8b02-7f4196a4b486', role: 'Explore',
  }, 1000);
  assert.strictEqual(s.label, 'Explore');
});

test('shapeSubagent label: hex-blob agent_id falls back to role', () => {
  const s = shapeSubagent({
    key: 'k2', agent_id: 'deadbeefdeadbeefdeadbeef@session-1', role: 'Plan',
  }, 1000);
  assert.strictEqual(s.label, 'Plan');
});

test('shapeSubagent label: explicit display_name always wins', () => {
  const s = shapeSubagent({
    key: 'k3', agent_id: 'nice-name@session-1', role: 'subagent', display_name: 'Given Name',
  }, 1000);
  assert.strictEqual(s.label, 'Given Name');
});

test('shapeSubagent label: no agent_id, no display_name → role, then key', () => {
  assert.strictEqual(shapeSubagent({ key: 'k4', role: 'general-purpose' }, 1000).label, 'general-purpose');
  assert.strictEqual(shapeSubagent({ key: 'k5' }, 1000).label, 'k5');
});

// --- auto-compact-before-cold -------------------------------------------------
// Policy gate for injecting /compact into a session whose prompt cache is about
// to expire. Every clause is a safety guard (permission dialogs, half-typed
// drafts, keep-warm holds) — each one must independently veto.
const { shouldAutoCompact, AUTO_COMPACT, isHumanPtyInput } = require('../proxy-util');

test('isHumanPtyInput: terminal auto-replies are not human', () => {
  // Focus reporting (mode 1004) — fires on every pane focus/blur; the live
  // 2026-07-08 auto-compact miss was a focus event killing the atPrompt latch.
  assert.strictEqual(isHumanPtyInput('\x1b[I'), false);
  assert.strictEqual(isHumanPtyInput('\x1b[O'), false);
  assert.strictEqual(isHumanPtyInput('\x1b[I\x1b[O'), false);
  // Terminal query replies — no human involved.
  assert.strictEqual(isHumanPtyInput('\x1b[24;80R'), false); // cursor position (DSR 6)
  assert.strictEqual(isHumanPtyInput('\x1b[0n'), false); // status ok (DSR 5)
  assert.strictEqual(isHumanPtyInput('\x1b[?1;2c'), false); // DA1
  assert.strictEqual(isHumanPtyInput('\x1b[>0;276;0c'), false); // DA2
  assert.strictEqual(isHumanPtyInput('\x1b]11;rgb:1e1e/1e1e/1e1e\x07'), false); // OSC color reply (BEL)
  assert.strictEqual(isHumanPtyInput('\x1b]10;rgb:ffff/ffff/ffff\x1b\\'), false); // OSC reply (ST)
  // Mouse tracking (modes 1000/1006) — scroll-reading a Claude pane emits these;
  // misclassifying them as human parked every DM for 300s (the fix's whole point).
  assert.strictEqual(isHumanPtyInput('\x1b[<64;12;4M'), false); // SGR wheel-up (press)
  assert.strictEqual(isHumanPtyInput('\x1b[<0;12;4m'), false); // SGR button release (lowercase m)
  assert.strictEqual(isHumanPtyInput('\x1b[<35;40;12M'), false); // SGR drag
  assert.strictEqual(isHumanPtyInput('\x1b[M\x20\x21\x22'), false); // legacy X10 mouse (3 raw bytes)
  assert.strictEqual(isHumanPtyInput('\x1b[M \n!'), false); // X10 with a raw \n among the 3 bytes ([\s\S]{3})
  // Other terminal reports.
  assert.strictEqual(isHumanPtyInput('\x1b[?24;80R'), false); // ?-prefixed cursor position report
  assert.strictEqual(isHumanPtyInput('\x1b[?1u'), false); // kitty keyboard flags report
  assert.strictEqual(isHumanPtyInput('\x1b[?2026;2$y'), false); // DECRPM mode report
  assert.strictEqual(isHumanPtyInput('\x1b[?6n'), false); // DECDSR startup one-shot
  assert.strictEqual(isHumanPtyInput('\x1b[>q'), false); // XTVERSION startup one-shot
  assert.strictEqual(isHumanPtyInput('\x1bP>|term 1.0\x1b\\'), false); // DCS reply, ST-terminated
  assert.strictEqual(isHumanPtyInput(''), false);
  assert.strictEqual(isHumanPtyInput(null), false);
});

test('isHumanPtyInput: keystrokes are human, unknown sequences fail toward human', () => {
  assert.strictEqual(isHumanPtyInput('a'), true);
  assert.strictEqual(isHumanPtyInput('\r'), true);
  assert.strictEqual(isHumanPtyInput('\x15'), true); // Ctrl-U
  assert.strictEqual(isHumanPtyInput('\x1b[A'), true); // arrow key
  // Chatter mixed with a real keystroke is still human — the strip removes the
  // auto-reply and a genuine keystroke remains, so we must not swallow it.
  assert.strictEqual(isHumanPtyInput('\x1b[Ihello'), true);
  assert.strictEqual(isHumanPtyInput('\x1b[<64;12;4Mx'), true); // a scroll report + a typed 'x'
  assert.strictEqual(isHumanPtyInput('a\x1b[M \n!'), true); // a typed 'a' before an X10 mouse report
  // Unknown escape → human (fails toward a missed compact, never a bad injection).
  assert.strictEqual(isHumanPtyInput('\x1b[?999z'), true);
});

// --- draft tracking: draftChunkSignal + isDraftOpen --------------------------
// Level-triggered draft latch behind the inject park divert: a keystroke opens
// the draft (stamp lastUserInputTs); a submit/abort OUTSIDE a bracketed-paste
// region closes it (stamp lastUserSubmitTs). draftOpen = input > submit.
const { draftChunkSignal, isDraftOpen } = require('../proxy-util');

test('draftChunkSignal: Enter and Ctrl-C close; plain keys/edits do not', () => {
  assert.deepStrictEqual(draftChunkSignal('\r'), { closes: true, inPaste: false });    // Enter submits
  assert.deepStrictEqual(draftChunkSignal('\x03'), { closes: true, inPaste: false });  // Ctrl-C abandons
  assert.deepStrictEqual(draftChunkSignal('a'), { closes: false, inPaste: false });    // a plain key opens/extends
  assert.deepStrictEqual(draftChunkSignal('hello'), { closes: false, inPaste: false });
  assert.deepStrictEqual(draftChunkSignal('\x7f'), { closes: false, inPaste: false }); // backspace edits
  assert.deepStrictEqual(draftChunkSignal('\x1b[A'), { closes: false, inPaste: false });// arrow nav
  assert.deepStrictEqual(draftChunkSignal(''), { closes: false, inPaste: false });
  assert.deepStrictEqual(draftChunkSignal(null), { closes: false, inPaste: false });
});

test('draftChunkSignal: type-then-Enter batched into one read counts as closed', () => {
  // Fast type-then-Enter (not a paste): the trailing \r is a real submit.
  assert.deepStrictEqual(draftChunkSignal('done\r'), { closes: true, inPaste: false });
  assert.deepStrictEqual(draftChunkSignal('ab\x03cd'), { closes: true, inPaste: false });
});

test('draftChunkSignal: a multiline bracketed paste does NOT close (interior \\r is literal)', () => {
  // The false-close bug: paste never submits in bracketed mode, so the \r
  // between lines must NOT stamp a close — the draft stays open.
  const chunk = '\x1b[200~line1\rline2\rline3\x1b[201~';
  assert.deepStrictEqual(draftChunkSignal(chunk, false), { closes: false, inPaste: false });
});

test('draftChunkSignal: a paste SPANNING two chunks (\\r in each) does not close', () => {
  // node-pty splits a large paste: the 200~ region opens in chunk A and closes
  // in chunk B; the running inPaste bit must carry across so neither \r closes.
  const a = draftChunkSignal('\x1b[200~alpha\rbeta', false);
  assert.deepStrictEqual(a, { closes: false, inPaste: true });   // still inside the paste
  const b = draftChunkSignal('gamma\rdelta\x1b[201~', a.inPaste);
  assert.deepStrictEqual(b, { closes: false, inPaste: false });  // region closed, no submit
});

test('draftChunkSignal: a \\r AFTER the 201~ closer in the same chunk closes', () => {
  // Paste ends, then the operator hits Enter — same read. We're back outside the
  // region by the \r, so it's a real submit.
  const chunk = '\x1b[200~pasted\x1b[201~\r';
  assert.deepStrictEqual(draftChunkSignal(chunk, false), { closes: true, inPaste: false });
});

test('draftChunkSignal: \\x03 INSIDE a paste is literal, does not close (fail-safe)', () => {
  // Judgment call (clodex leaned the other way): a pasted 0x03 byte is content,
  // not a live Ctrl-C — closing on it would be the same false-close class. So it
  // stays open; only a Ctrl-C outside the region aborts.
  assert.deepStrictEqual(draftChunkSignal('\x1b[200~a\x03b\x1b[201~', false), { closes: false, inPaste: false });
  // ...but a Ctrl-C after the paste closer still closes.
  assert.deepStrictEqual(draftChunkSignal('\x1b[200~a\x1b[201~\x03', false), { closes: true, inPaste: false });
});

test('isDraftOpen: open once a keystroke post-dates the last submit; closed otherwise', () => {
  assert.strictEqual(isDraftOpen({ lastUserInputTs: 100, lastUserSubmitTs: 50 }), true);  // typed after submit
  assert.strictEqual(isDraftOpen({ lastUserInputTs: 50, lastUserSubmitTs: 100 }), false); // submitted last
  assert.strictEqual(isDraftOpen({ lastUserInputTs: 100, lastUserSubmitTs: 100 }), false); // mixed chunk: equal ⇒ closed
  assert.strictEqual(isDraftOpen({ lastUserInputTs: 100 }), true);   // never submitted → open
  assert.strictEqual(isDraftOpen({}), false);                        // no input ever → closed
  assert.strictEqual(isDraftOpen(), false);                          // defaults → closed
});

const AC_NOW = 10_000_000;
function acArgs(over = {}, payloadOver = {}) {
  return {
    payload: {
      linked: true,
      hold: null,
      warmth: { state: 'warm', remaining_s: 45, ttl_s: 300 },
      context: { turns: 5, messages: 20, inputTokens: 150_000 },
      ...payloadOver,
    },
    enabled: true,
    atPrompt: true,
    lastInputTs: 0,
    lastFiredTs: 0,
    now: AC_NOW,
    ...over,
  };
}

test('shouldAutoCompact: fires on the canonical about-to-cool heavy session', () => {
  assert.strictEqual(shouldAutoCompact(acArgs()), true);
});

test('shouldAutoCompact: opt-out and not-at-prompt each veto', () => {
  assert.strictEqual(shouldAutoCompact(acArgs({ enabled: false })), false);
  // atPrompt false = last main-line stop was non-terminal (or never stamped):
  // could be a permission dialog where the injected Enter answers the dialog.
  assert.strictEqual(shouldAutoCompact(acArgs({ atPrompt: false })), false);
});

test('shouldAutoCompact: keep-warm hold owns the moment — never both', () => {
  assert.strictEqual(shouldAutoCompact(acArgs({}, { hold: { until: 123, hours: 4 } })), false);
});

test('shouldAutoCompact: warmth gates — cold, absent, not yet expiring, unlinked', () => {
  assert.strictEqual(shouldAutoCompact(acArgs({}, { warmth: { state: 'cold', remaining_s: null, ttl_s: null } })), false);
  assert.strictEqual(shouldAutoCompact(acArgs({}, { warmth: null })), false);
  assert.strictEqual(shouldAutoCompact(acArgs({}, { warmth: { state: 'warm', remaining_s: AUTO_COMPACT.WARMTH_HEADROOM_S + 1, ttl_s: 300 } })), false);
  assert.strictEqual(shouldAutoCompact(acArgs({}, { linked: false })), false);
});

test('shouldAutoCompact: light context is not worth a lossy compact', () => {
  assert.strictEqual(shouldAutoCompact(acArgs({}, { context: { turns: 2, messages: 4, inputTokens: 50_000 } })), false);
  assert.strictEqual(shouldAutoCompact(acArgs({}, { context: null })), false);
  assert.strictEqual(shouldAutoCompact(acArgs({}, { context: { turns: 2, messages: 4, inputTokens: AUTO_COMPACT.MIN_INPUT_TOKENS } })), true);
});

test('shouldAutoCompact: recent keystrokes veto (Ctrl-U would eat a draft)', () => {
  assert.strictEqual(shouldAutoCompact(acArgs({ lastInputTs: AC_NOW - AUTO_COMPACT.INPUT_QUIET_MS + 1 })), false);
  assert.strictEqual(shouldAutoCompact(acArgs({ lastInputTs: AC_NOW - AUTO_COMPACT.INPUT_QUIET_MS - 1 })), true);
});

test('shouldAutoCompact: cooldown latch — one fire per window, not per poll tick', () => {
  assert.strictEqual(shouldAutoCompact(acArgs({ lastFiredTs: AC_NOW - AUTO_COMPACT.COOLDOWN_MS + 1 })), false);
  assert.strictEqual(shouldAutoCompact(acArgs({ lastFiredTs: AC_NOW - AUTO_COMPACT.COOLDOWN_MS - 1 })), true);
});

// autoCompactDecision exposes the REASON behind a non-fire — the ops-log line
// that makes a silent never-fired case diagnosable. shouldAutoCompact is just
// its .fire, so these lock the reason strings each gate emits.
const { autoCompactDecision } = require('../proxy-util');

test('autoCompactDecision: fire path reports reason "fire"', () => {
  // Return shape gained band/remaining_s (fed into the fired log line), so assert
  // the fields rather than exact object equality. Default acArgs = ttl_s 300 →
  // band clamps to the 60s floor; remaining_s 45 <= 60 → fires (old semantics).
  const d = autoCompactDecision(acArgs());
  assert.strictEqual(d.fire, true);
  assert.strictEqual(d.reason, 'fire');
  assert.strictEqual(d.band, 60);
});

test('autoCompactDecision: each gate names why it blocked', () => {
  assert.strictEqual(autoCompactDecision(acArgs({ enabled: false })).reason, 'disabled');
  assert.strictEqual(autoCompactDecision(acArgs({ atPrompt: false })).reason, 'not-at-prompt');
  assert.strictEqual(autoCompactDecision(acArgs({}, { linked: false })).reason, 'unlinked');
  assert.strictEqual(autoCompactDecision(acArgs({}, { hold: { until: 1, hours: 4 } })).reason, 'keep-warm-hold');
  assert.strictEqual(autoCompactDecision(acArgs({}, { warmth: { state: 'cold', remaining_s: null } })).reason, 'cache-not-warm');
  assert.match(autoCompactDecision(acArgs({}, { warmth: { state: 'warm', remaining_s: AUTO_COMPACT.WARMTH_HEADROOM_S + 1, ttl_s: 300 } })).reason, /^warmth-headroom/);
  assert.match(autoCompactDecision(acArgs({}, { context: { inputTokens: 50_000 } })).reason, /^below-min-tokens/);
  assert.strictEqual(autoCompactDecision(acArgs({}, { context: { turns: 1 } })).reason, 'no-context-tokens');
  assert.strictEqual(autoCompactDecision(acArgs({ lastInputTs: AC_NOW })).reason, 'recent-user-input');
  assert.strictEqual(autoCompactDecision(acArgs({ lastFiredTs: AC_NOW })).reason, 'cooldown');
});

test('autoCompactDecision: no-payload short-circuits before warmth deref', () => {
  assert.deepStrictEqual(autoCompactDecision(acArgs({}, {})).fire !== undefined, true);
  assert.strictEqual(autoCompactDecision({ ...acArgs(), payload: null }).reason, 'no-payload');
});

// TTL-relative headroom band (the fix for the never-fired-in-production bug: a
// fixed 60s band was unreachable under the production 3600s TTL). The band is
// HEADROOM_FRAC (0.15) of ttl_s, clamped to [WARMTH_HEADROOM_S floor, HEADROOM_MAX_S].
const { headroomBand } = require('../proxy-util');

test('headroomBand: fraction of ttl_s, clamped to [floor, max]', () => {
  // 0.15*3600 = 540, inside [60, 900]
  assert.strictEqual(headroomBand(3600), 540);
  // 0.15*300 = 45 → clamps UP to the 60s floor (preserves old ~300s semantics)
  assert.strictEqual(headroomBand(300), 60);
  // 0.15*10000 = 1500 → clamps DOWN to the 900s max
  assert.strictEqual(headroomBand(10000), 900);
  // missing / non-numeric / non-positive ttl_s → flat floor, never NaN
  assert.strictEqual(headroomBand(undefined), 60);
  assert.strictEqual(headroomBand(null), 60);
  assert.strictEqual(headroomBand(0), 60);
  assert.strictEqual(headroomBand(-5), 60);
});

test('autoCompactDecision: at ttl_s 3600 the band is 540 — fires under it, suppressed over it', () => {
  // remaining 500 <= 540 → fires (this is what NEVER happened under the old fixed 60)
  const fires = autoCompactDecision(acArgs({}, { warmth: { state: 'warm', remaining_s: 500, ttl_s: 3600 } }));
  assert.strictEqual(fires.fire, true);
  assert.strictEqual(fires.band, 540);
  // remaining 600 > 540 → suppressed, reason carries both numbers for the wild-data log
  const supp = autoCompactDecision(acArgs({}, { warmth: { state: 'warm', remaining_s: 600, ttl_s: 3600 } }));
  assert.strictEqual(supp.fire, false);
  assert.strictEqual(supp.band, 540);
  assert.match(supp.reason, /^warmth-headroom\(600s\/band 540s\)$/);
});

// The suppression-log dedup keys on reasonClass, which must be STABLE while the
// live numbers inside the reason decay — the full-string compare logged one
// line per 5s poll (the warmth-headroom ops-log flood).
test('autoCompactDecision: reasonClass strips live numbers so poll ticks dedup', () => {
  const at = (remaining_s) => autoCompactDecision(acArgs({}, { warmth: { state: 'warm', remaining_s, ttl_s: 3600 } }));
  const a = at(2972.6);
  const b = at(2967.6);
  assert.notStrictEqual(a.reason, b.reason);              // full reasons differ...
  assert.strictEqual(a.reasonClass, 'warmth-headroom');   // ...class is stable
  assert.strictEqual(a.reasonClass, b.reasonClass);
  // Parenthesis-free reasons pass through unchanged; fire path included.
  assert.strictEqual(autoCompactDecision(acArgs({ enabled: false })).reasonClass, 'disabled');
  assert.strictEqual(autoCompactDecision(acArgs()).reasonClass, 'fire');
  assert.match(autoCompactDecision(acArgs({}, { context: { inputTokens: 50_000 } })).reasonClass, /^below-min-tokens$/);
});

test('autoCompactDecision: missing ttl_s falls back to the flat 60s floor', () => {
  // remaining 50 <= 60 floor → fires even with no ttl_s (guarded, not NaN)
  assert.strictEqual(autoCompactDecision(acArgs({}, { warmth: { state: 'warm', remaining_s: 50 } })).fire, true);
  // remaining 70 > 60 floor → suppressed
  const supp = autoCompactDecision(acArgs({}, { warmth: { state: 'warm', remaining_s: 70 } }));
  assert.strictEqual(supp.fire, false);
  assert.strictEqual(supp.band, 60);
});

// --- peer visibility: [agent:who] labels + dm hold gate ------------------------
// A dm injection into a long-idle, not-warm peer re-bills that peer's whole
// context; the gate bounces those unless the sender says urgent. Warmth must be
// VERIFIABLE to count as cheap (unknown != warm), and remaining_s ages by
// payload.ts before being trusted.
const { peerStatusLabel, shouldHoldDm, DM_HOLD_IDLE_MS } = require('../proxy-util');

const PV_NOW = 50_000_000;
const warmPayload = (remaining, tsAgo = 0) => ({
  linked: true, ts: PV_NOW - tsAgo,
  warmth: { state: 'warm', remaining_s: remaining, ttl_s: 3600 },
});

test('peerStatusLabel: working / idle / warmth suffixes', () => {
  assert.strictEqual(peerStatusLabel({ state: 'thinking', idleMs: 0, payload: null, now: PV_NOW }), 'working');
  assert.strictEqual(peerStatusLabel({ state: 'idle', idleMs: 3 * 60_000, payload: null, now: PV_NOW }), 'idle 3m');
  assert.strictEqual(peerStatusLabel({ state: 'idle', idleMs: 12 * 60_000, payload: warmPayload(600), now: PV_NOW }), 'idle 12m, warm');
  assert.strictEqual(
    peerStatusLabel({ state: 'idle', idleMs: 5 * 3600_000, payload: { linked: true, ts: PV_NOW, warmth: { state: 'cold', remaining_s: null, ttl_s: null } }, now: PV_NOW }),
    'idle 5h, cache cold');
  assert.strictEqual(peerStatusLabel({ state: 'idle', idleMs: 30_000, payload: null, now: PV_NOW }), 'idle <1m');
  assert.strictEqual(peerStatusLabel({ state: 'idle', idleMs: (26 * 60 + 90) * 60_000, payload: null, now: PV_NOW }), 'idle 27h30m');
});

test('peerStatusLabel: stale-poll warm that has since expired reads cold', () => {
  // Poll said warm/40s left, 60s ago — it's cold NOW.
  assert.strictEqual(
    peerStatusLabel({ state: 'idle', idleMs: 3600_000, payload: warmPayload(40, 60_000), now: PV_NOW }),
    'idle 1h, cache cold');
});

test('shouldHoldDm: urgent, working, and recently-active peers always deliver', () => {
  const base = { state: 'idle', idleMs: 5 * 3600_000, payload: null, now: PV_NOW };
  assert.strictEqual(shouldHoldDm({ ...base, urgent: true }).hold, false);
  assert.strictEqual(shouldHoldDm({ ...base, urgent: false, state: 'thinking' }).hold, false);
  assert.strictEqual(shouldHoldDm({ urgent: false, state: 'idle', idleMs: DM_HOLD_IDLE_MS - 1, payload: null, now: PV_NOW }).hold, false);
});

test('shouldHoldDm: kept-warm peer is cheap no matter how long idle', () => {
  assert.strictEqual(shouldHoldDm({ urgent: false, state: 'idle', idleMs: 9 * 3600_000, payload: warmPayload(1800), now: PV_NOW }).hold, false);
});

test('shouldHoldDm: long-idle + cold or UNKNOWN warmth holds, with reason', () => {
  const cold = shouldHoldDm({
    urgent: false, state: 'idle', idleMs: 5 * 3600_000,
    payload: { linked: true, ts: PV_NOW, warmth: { state: 'cold', remaining_s: null, ttl_s: null } }, now: PV_NOW,
  });
  assert.strictEqual(cold.hold, true);
  assert.match(cold.reason, /idle 5h with a cold cache/);
  // unknown warmth (no proxy link / codex): long idle still holds — 5h idle is
  // cold in every realistic TTL regime, and urgent is a one-line retry.
  const unknown = shouldHoldDm({ urgent: false, state: 'idle', idleMs: 5 * 3600_000, payload: null, now: PV_NOW });
  assert.strictEqual(unknown.hold, true);
  assert.doesNotMatch(unknown.reason, /cold cache/); // don't claim what we can't see
});

test('shouldHoldDm: permission dialog holds EVERYTHING, urgent included', () => {
  // The hazard is the injection itself (Enter answers the dialog), so there is
  // no urgent override — noUrgent tells the bounce not to advertise one.
  const v = shouldHoldDm({
    urgent: true, state: 'idle', idleMs: 0,
    payload: warmPayload(3000), attention: 'permission', now: PV_NOW,
  });
  assert.strictEqual(v.hold, true);
  assert.strictEqual(v.noUrgent, true);
  assert.match(v.reason, /permission dialog/);
  // 'other' notifications do NOT gate delivery — no evidence a dialog is up.
  assert.strictEqual(
    shouldHoldDm({ urgent: false, state: 'idle', idleMs: 0, payload: warmPayload(3000), attention: 'other', now: PV_NOW }).hold,
    false);
});

test('peerStatusLabel: permission dialog outranks working and idle', () => {
  assert.strictEqual(
    peerStatusLabel({ state: 'thinking', idleMs: 0, payload: null, attention: 'permission', now: PV_NOW }),
    'blocked on a permission dialog');
  // 'other' notifications don't relabel — the peer is still reachable.
  assert.strictEqual(
    peerStatusLabel({ state: 'idle', idleMs: 3 * 60_000, payload: null, attention: 'other', now: PV_NOW }),
    'idle 3m');
});

// --- versionSeverity + releaseAgeInfo: peer identity surfacing ---------------
const { versionSeverity, updateApplies, releaseAgeInfo } = require('../proxy-util');

test('versionSeverity: equal versions are current (v-prefix + missing parts tolerated)', () => {
  assert.strictEqual(versionSeverity('2.10.1', '2.10.1'), 'current');
  assert.strictEqual(versionSeverity('v2.10.1', '2.10.1'), 'current');
  assert.strictEqual(versionSeverity('2', '2.0.0'), 'current');
  // A pre-release tail on the peer is ignored for the triple compare.
  assert.strictEqual(versionSeverity('2.10.1', '2.10.1-beta'), 'current');
});

test('versionSeverity: peer behind us classifies by the highest differing component', () => {
  assert.strictEqual(versionSeverity('2.10.1', '2.10.0'), 'patch');
  assert.strictEqual(versionSeverity('2.10.1', '2.9.5'), 'minor');
  assert.strictEqual(versionSeverity('2.10.1', '1.99.99'), 'major');
});

test('versionSeverity: peer ahead of us reads newer (we are the stale one)', () => {
  assert.strictEqual(versionSeverity('2.10.1', '2.10.2'), 'newer');
  assert.strictEqual(versionSeverity('2.10.1', '3.0.0'), 'newer');
});

test('versionSeverity: unparseable on either side is unknown', () => {
  assert.strictEqual(versionSeverity('2.10.1', 'garbage'), 'unknown');
  assert.strictEqual(versionSeverity('2.10.1', '2.x.1'), 'unknown');
  assert.strictEqual(versionSeverity('', '2.10.1'), 'unknown');
  assert.strictEqual(versionSeverity('2.10.1', null), 'unknown');
});

test('updateApplies: offer Update only for a behind or unknown peer', () => {
  // Behind us — the deploy is worth offering.
  assert.strictEqual(updateApplies('patch'), true);
  assert.strictEqual(updateApplies('minor'), true);
  assert.strictEqual(updateApplies('major'), true);
  // Can't rule an update out (dev / unparseable version) — keep the escape hatch.
  assert.strictEqual(updateApplies('unknown'), true);
  // Nothing to gain — same version, or a box ahead of us (script pulls master).
  assert.strictEqual(updateApplies('current'), false);
  assert.strictEqual(updateApplies('newer'), false);
  // A renderer that never sent sev (undefined) defaults to showing it.
  assert.strictEqual(updateApplies(undefined), true);
});

test('releaseAgeInfo: found ⇒ index is releases-behind, age in whole days', () => {
  const NOW = Date.parse('2026-01-20T00:00:00Z');
  const releases = [
    { tag: 'v2.10.3', published_at: '2026-01-18T00:00:00Z' }, // newest
    { tag: 'v2.10.2', published_at: '2026-01-15T00:00:00Z' },
    { tag: 'v2.10.1', published_at: '2026-01-10T00:00:00Z' }, // peer is here
    { tag: 'v2.10.0', published_at: '2026-01-01T00:00:00Z' },
  ];
  assert.deepStrictEqual(releaseAgeInfo('2.10.1', releases, NOW), { behind: 2, ageDays: 10 });
  // v-prefix on the query and the latest release (behind 0) both resolve.
  assert.deepStrictEqual(releaseAgeInfo('v2.10.3', releases, NOW), { behind: 0, ageDays: 2 });
});

test('releaseAgeInfo: not in the list (dev build) ⇒ null; empty/absent list ⇒ null', () => {
  const releases = [{ tag: 'v2.10.1', published_at: '2026-01-10T00:00:00Z' }];
  assert.strictEqual(releaseAgeInfo('9.9.9', releases, Date.now()), null);
  assert.strictEqual(releaseAgeInfo('2.10.1', [], Date.now()), null);
  assert.strictEqual(releaseAgeInfo('2.10.1', null, Date.now()), null);
  assert.strictEqual(releaseAgeInfo('', releases, Date.now()), null);
});

test('releaseAgeInfo: a missing/unparseable date keeps the behind count, age null', () => {
  const releases = [
    { tag: 'v2.10.2', published_at: '2026-01-15T00:00:00Z' },
    { tag: 'v2.10.1' }, // no published_at
  ];
  assert.deepStrictEqual(releaseAgeInfo('2.10.1', releases, Date.now()), { behind: 1, ageDays: null });
});

// --- pasteModeSignal: PTY-output paste-mode tracking -------------------------
// The CLI enables/disables bracketed paste by writing \x1b[?2004h / \x1b[?2004l
// to its terminal; the tracker reads that live state off the output stream to
// gate the inject path's multi-line paste-wrap.
const { pasteModeSignal } = require('../proxy-util');

test('pasteModeSignal: enable turns it on, disable turns it off', () => {
  assert.strictEqual(pasteModeSignal('boot noise \x1b[?2004h more', false), true);
  assert.strictEqual(pasteModeSignal('teardown \x1b[?2004l bye', true), false);
});

test('pasteModeSignal: chunk with neither sequence keeps the previous state', () => {
  assert.strictEqual(pasteModeSignal('plain output', true), true);
  assert.strictEqual(pasteModeSignal('plain output', false), false);
  assert.strictEqual(pasteModeSignal('', true), true);
  assert.strictEqual(pasteModeSignal(null, true), true);
  // prev defaults to false, and coerces truthy/absent cleanly
  assert.strictEqual(pasteModeSignal('x'), false);
});

test('pasteModeSignal: both in one chunk — the LAST one wins', () => {
  assert.strictEqual(pasteModeSignal('\x1b[?2004h mid \x1b[?2004l', true), false);
  assert.strictEqual(pasteModeSignal('\x1b[?2004l mid \x1b[?2004h', false), true);
});
