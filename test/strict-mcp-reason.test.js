'use strict';
// strict-mcp-reason.test.js — the `--strict-mcp-config` fallback must say WHY
// it fired, and must stay silent when it does not fire (t45).
//
// WHAT THIS IS ABOUT. `disableClaudeDesignMcp` sheds the auto-injected
// claude.ai `claude_design` connector. The surgical mechanism is a strip-capable
// wirescope; `--strict-mcp-config` is the fallback and is ALL-OR-NOTHING, so on
// the fallback path a user's real project/user MCP servers are disabled too.
// The preferences hint documents that for the UNROUTED case. What was invisible:
// a ROUTED session ALSO falls back when the wire is too old to advertise
// strip_mcp, or when the probe fails at the spawn instant. The user reads
// "routed = the proxy handles it" and in those two cases is wrong.
//
// t45 changes NOTHING about when the flag is pushed — only whether anyone can
// tell. So these tests are about legibility, and the assertion that matters most
// is the NEGATIVE one: the healthy path must produce no signal at all.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { strictMcpReason, STRICT_MCP_EXPLANATION } = require('../proxy-util');

// A probe result whose capabilities advertise a strip of the given servers.
const stripping = (servers) => ({
  product: 'wirescope', version: '0.6.13',
  capabilities: { strip_mcp: { available: true, servers } },
});

// ── the three reasons, each distinct ─────────────────────────────────────────
//
// WINDOW: each fallback path names ITSELF. The remedies differ — deploy a newer
// wire, restart the session, or nothing (unrouted is expected) — so a single
// undifferentiated "strict was pushed" line would repeat this ticket's own bug
// one level up: a true statement that leaves the user unable to act on it.

test('unrouted: no proxy at all is the documented, expected fallback', () => {
  assert.strictEqual(strictMcpReason(null, null), 'unrouted');
  assert.strictEqual(strictMcpReason('', null), 'unrouted');
  // Unrouted is decided by the absence of a base, never by the probe — a stale
  // probe value must not be able to talk an unrouted session out of the flag.
  assert.strictEqual(strictMcpReason(null, stripping(['claude_design'])), 'unrouted');
});

test('wire-no-strip: routed, but the wire will not strip claude_design', () => {
  const base = 'http://127.0.0.1:7800';
  // A wire too old to know about strip_mcp at all.
  assert.strictEqual(strictMcpReason(base, { product: 'wirescope', capabilities: {} }), 'wire-no-strip');
  // A strip-off / kill-switch port: the capability exists, the set is empty.
  assert.strictEqual(strictMcpReason(base, stripping([])), 'wire-no-strip');
  // Stripping SOMETHING, but not the connector this setting is about. Reading
  // the advertised FACT (rather than assuming routed => strips) is what keeps a
  // strip-off port from silently regressing to "we assumed it was handled".
  assert.strictEqual(strictMcpReason(base, stripping(['some_other_server'])), 'wire-no-strip');
  // Malformed / non-array servers must not throw and must not be read as a hit.
  assert.strictEqual(strictMcpReason(base, { capabilities: { strip_mcp: { servers: 'claude_design' } } }), 'wire-no-strip');
  assert.strictEqual(strictMcpReason(base, { capabilities: { strip_mcp: true } }), 'wire-no-strip');
});

test('probe-failed: routed, but the wire did not answer at the spawn instant', () => {
  // probe() resolves null when unreachable or unrecognized, and the call site
  // catches a throw into the same null — so both arrive here identically. This
  // is the FAIL-OPEN path: a proxy hiccup must never block a spawn, so the flag
  // is pushed and the session starts degraded rather than not at all.
  assert.strictEqual(strictMcpReason('http://127.0.0.1:7800', null), 'probe-failed');
  assert.strictEqual(strictMcpReason('http://127.0.0.1:7800', undefined), 'probe-failed');
});

test('the three reasons are distinct, and each carries its own remedy', () => {
  const reasons = ['unrouted', 'wire-no-strip', 'probe-failed'];
  // Every reason the function can return has an explanation — a new reason
  // added without one would render as `undefined` in the log line.
  for (const r of reasons) {
    assert.strictEqual(typeof STRICT_MCP_EXPLANATION[r], 'string', `${r}: no explanation`);
    assert.ok(STRICT_MCP_EXPLANATION[r].length > 0, `${r}: empty explanation`);
  }
  // And no explanation exists for a reason the function cannot return, which
  // would mean the two lists have drifted apart.
  assert.deepStrictEqual(Object.keys(STRICT_MCP_EXPLANATION).sort(), [...reasons].sort());
  // Distinct text, not three labels on one sentence.
  assert.strictEqual(new Set(reasons.map((r) => STRICT_MCP_EXPLANATION[r])).size, 3);
});

// ── the assertion that matters most ──────────────────────────────────────────
//
// WINDOW: the HEALTHY path — routed to a wire that advertises a claude_design
// strip. This is the configuration the preferences hint calls "handled by the
// proxy", and it must produce NO flag and NO log line. Stated separately from
// the revert proof because it is a different question: the revert proof asks
// "does this test fail when I break the line?", this asks "is the quiet path
// actually quiet?".
//
// A signal that fires on the healthy path is worse than no signal. It appears
// on every correctly-configured spawn, people learn to scroll past it, and then
// the three lines above — which are the ones that mean something — go unread
// along with it. The null return is the whole feature.
test('the healthy strip-capable wire produces NO reason, and therefore no signal', () => {
  const base = 'http://127.0.0.1:7800';
  assert.strictEqual(strictMcpReason(base, stripping(['claude_design'])), null);
  // Among other stripped servers, in any order — the check is set membership,
  // never position.
  assert.strictEqual(strictMcpReason(base, stripping(['other', 'claude_design'])), null);
  assert.strictEqual(strictMcpReason(base, stripping(['claude_design', 'other'])), null);
  // null is the ONLY falsy return: the call site branches on `if (reason)`, so a
  // reason that were ever '' or 0 would silently take the healthy path while
  // meaning the opposite.
  for (const probe of [null, undefined, {}, stripping([]), stripping(['x'])]) {
    const r = strictMcpReason(base, probe);
    assert.strictEqual(typeof r, 'string');
    assert.ok(r.length > 0);
  }
});

// ── the call site actually uses it this way ──────────────────────────────────
//
// WINDOW: the coupling between this function and the spawn path. Everything
// above tests a pure function; none of it proves session-manager.js broadcasts
// only on a non-null reason. The Claude argv path inside create() is not
// drivable in this suite (it spawns a real PTY — the existing create() tests
// only reach the early rejections and the bash path), so a behavioural test of
// the call site is not available at reasonable cost. This reads the source
// instead, which is a WEAKER statement and is worth being honest about: it pins
// the SHAPE of the call site, not its behaviour. It would catch the specific
// regression that matters (a broadcast moved outside the guard, or a second
// ungated one added) and would not catch a subtler logic change.
test('session-manager pushes the flag and logs ONLY inside the reason guard', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'session-manager.js'), 'utf8');
  const at = src.indexOf('const reason = strictMcpReason(');
  assert.ok(at > 0, 'the gate no longer calls strictMcpReason — this guard needs updating');

  // The block from the call to the end of its `if (reason) { … }`.
  const open = src.indexOf('if (reason) {', at);
  assert.ok(open > at, 'the reason is no longer used as the guard');
  const close = src.indexOf('\n          }', open);
  assert.ok(close > open, 'could not find the end of the reason guard');
  const guarded = src.slice(open, close);

  // Both effects live INSIDE the guard.
  assert.ok(guarded.includes("args.push('--strict-mcp-config')"), 'the flag is not pushed inside the guard');
  assert.ok(guarded.includes("this._broadcast('ipc-message'"), 'the log line is not broadcast inside the guard');
  assert.ok(guarded.includes('STRICT_MCP_EXPLANATION[reason]'), 'the log line does not carry the reason explanation');

  // And nothing between the call and the guard emits anything — i.e. there is
  // no second, ungated line that would fire on the healthy path.
  const between = src.slice(at, open);
  assert.ok(!between.includes('_broadcast'), 'a broadcast sits between the reason and its guard — it would fire on the healthy path');
  assert.ok(!between.includes("args.push('--strict-mcp-config')"), 'the flag is pushed before the guard');
});
