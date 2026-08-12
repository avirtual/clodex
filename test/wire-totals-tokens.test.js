// Run: node --test
// wire-telemetry's token totals — the fields the per-ticket rollup divides to
// get a cached fraction (DESIGN.md §7.1). They ride the same lifetime ledger as
// cost, so the cases that matter are the ones where cost is right and tokens
// are quietly not: a base loaded from disk, a seed that carries no tokens, and
// the standing rule that cumulative billed tokens are NOT context.inputTokens.
const { test } = require('node:test');
const assert = require('node:assert');
const { WireTelemetry } = require('../wire-telemetry');

function mainTurn(over = {}) {
  return {
    agent: 'alice', sessionId: 'sid-1', role: 'parent', sideCall: false,
    model: 'claude-sonnet-5', status: 200,
    billing: { tokens: { input_tokens: 100, cache_read_input_tokens: 40000, cache_write_5m_tokens: 500, cache_write_1h_tokens: null, cache_write_flat_tokens: null } },
    sessionTotals: {
      requests: 8, est_usd: 0.1234, turns: 2, refusals: 0,
      input_tokens: 300, output_tokens: 120, cache_read_tokens: 9000, cache_write_tokens: 700,
    },
    ...over,
  };
}

test('payload carries the cumulative token totals off the ledger', () => {
  const wt = new WireTelemetry({});
  wt.noteTurn(mainTurn());
  const p = wt.payload('alice');
  // Whole block: a field that silently stops being carried is the failure mode,
  // and it arrives as undefined — which arithmetic downstream turns into NaN.
  assert.deepStrictEqual(p.tokens, {
    input: 300, output: 120, cacheRead: 9000, cacheWrite: 700,
  });
});

test('cumulative tokens are a DIFFERENT scope from context.inputTokens', () => {
  // context.inputTokens is the last main-line turn's WINDOW size
  // (100 + 40000 + 500 = 40600); tokens.input is the lifetime billed sum (300).
  // Collapsing the two would make every cached fraction wrong in a way that
  // still looks like a plausible number.
  const wt = new WireTelemetry({});
  wt.noteTurn(mainTurn());
  const p = wt.payload('alice');
  assert.strictEqual(p.context.inputTokens, 40600);
  assert.strictEqual(p.tokens.input, 300);
  assert.notStrictEqual(p.context.inputTokens, p.tokens.input);
});

test('token totals persist and reload as a base across a restart', () => {
  const writes = [];
  const persist = { read: () => null, write: (o) => writes.push(o) };
  const wt = new WireTelemetry({ persist });
  wt.noteTurn(mainTurn());
  wt._save();
  const saved = writes.at(-1).sessions['sid-1'];
  // ENTER: the session under test survived into the persisted object. Every
  // assertion below reads through this key, so a save that dropped the row
  // would make them vacuous rather than failing.
  assert.ok(saved, 'sid-1 must be present in the persisted totals');
  assert.strictEqual(saved.inputTokens, 300);
  assert.strictEqual(saved.outputTokens, 120);
  assert.strictEqual(saved.cacheReadTokens, 9000);
  assert.strictEqual(saved.cacheWriteTokens, 700);

  // Restart: the saved lifetime becomes the base and the new launch adds to it.
  const wt2 = new WireTelemetry({ persist: { read: () => writes.at(-1), write: () => {} } });
  wt2.noteTurn(mainTurn({ sessionTotals: {
    requests: 1, est_usd: 0.01, turns: 1, refusals: 0,
    input_tokens: 7, output_tokens: 3, cache_read_tokens: 11, cache_write_tokens: 0,
  } }));
  assert.deepStrictEqual(wt2.payload('alice').tokens, {
    input: 307, output: 123, cacheRead: 9011, cacheWrite: 700,
  });
});

test('an old totals record without token fields reloads as 0, never NaN', () => {
  // wire-totals.json predates these fields, so every persisted session on a
  // real machine lacks them. `undefined + n` is NaN, and NaN serializes to
  // null in JSON — a rollup would report "no data" for a session that has it.
  const legacy = { version: 1, sessions: { 'sid-1': { cost: 5, requests: 50, turns: 9, refusals: 0, ts: 1 } } };
  const wt = new WireTelemetry({ persist: { read: () => legacy, write: () => {} } });
  wt.noteTurn(mainTurn());
  const p = wt.payload('alice');
  assert.strictEqual(p.cost.usd, 5.1234);          // cost still bases correctly
  assert.deepStrictEqual(p.tokens, {
    input: 300, output: 120, cacheRead: 9000, cacheWrite: 700,
  });
  for (const [k, v] of Object.entries(p.tokens)) {
    assert.ok(Number.isFinite(v), `tokens.${k} must be finite, got ${v}`);
  }
});

test('seedLifetime leaves tokens at the wire-observed sum — the poll carries none', () => {
  // The seed imports wirescope's persisted cost/requests/turns, which have no
  // token fields at all. Tokens must therefore stay the wire's own count rather
  // than becoming null or NaN: for a freshly minted ticket seat that IS the
  // whole spend, which is what makes the per-ticket number sound.
  const wt = new WireTelemetry({ persist: { read: () => null, write: () => {} } });
  wt.noteTurn(mainTurn());
  wt.seedLifetime('alice', { linked: true, sessionId: 'sid-1', cost: { usd: 113.98, requests: 392 }, turns: 50, refusals: 3 });
  const p = wt.payload('alice');
  assert.strictEqual(p.cost.usd, 113.98);
  assert.deepStrictEqual(p.tokens, {
    input: 300, output: 120, cacheRead: 9000, cacheWrite: 700,
  });
});

test('a receipt with no sessionTotals leaves the token block null, not zero', () => {
  // null means unobservable; 0 would be a claim that no tokens were billed.
  const wt = new WireTelemetry({});
  wt.noteTurn(mainTurn({ sessionTotals: null }));
  assert.deepStrictEqual(wt.payload('alice').tokens, {
    input: null, output: null, cacheRead: null, cacheWrite: null,
  });
});
