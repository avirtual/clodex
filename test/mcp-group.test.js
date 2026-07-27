'use strict';
// mcp-group.test.js — the per-MCP-server fold of a wirescope tool roster (t46).
//
// The fixtures below are REAL SHAPES, not invented ones: they come from a live
// /_context read against wirescope v0.6.40 during t46 step 0, plus real tool
// names observed in this box's own usage history (mcp__LunarCrush__*,
// mcp__sqlite__*). That matters — the whole feature rests on the
// `mcp__<server>__<tool>` grammar holding on real bytes, and it was confirmed
// there rather than taken from documentation.

const { test } = require('node:test');
const assert = require('node:assert');

const { mcpServerOf, groupMcpTools, mcpTotalTokens } = require('../renderer/lib/mcp-group');

// Verbatim from the step-0 roster (main line, 31 tools), MCP entries only.
const REAL_MCP = [
  { name: 'mcp__scratchprobe__ping', schema_chars: 147, est_tokens: 52, used: 0 },
  { name: 'mcp__two_words__ping', schema_chars: 143, est_tokens: 51, used: 0 },
  { name: 'mcp__scratchprobe__pong', schema_chars: 124, est_tokens: 44, used: 0 },
  { name: 'mcp__two_words__pong', schema_chars: 120, est_tokens: 42, used: 0 },
];
// Built-ins from the same roster.
const REAL_BUILTINS = [
  { name: 'Bash', est_tokens: 1200, used: 3 },
  { name: 'Read', est_tokens: 900, used: 7 },
  { name: 'DesignSync', est_tokens: 400, used: 0 },
];

// ── THE LOAD-BEARING NEGATIVE ────────────────────────────────────────────────
//
// WINDOW: a session with no MCP servers must produce NO group, so the popover
// renders NOTHING — not an empty section, not a zero row, not a heading with a
// dash. This is the requirement stated as "surface them when they are there",
// and it is the assertion most worth defending: a feature that draws an empty
// MCP panel for the majority of users who have no MCP servers is a regression
// for them, and it is exactly the kind of thing that reads as harmless in a
// diff. The renderer's contract is `if (!groups.length) return ''`, so the
// empty ARRAY is what that guarantee reduces to.
test('no MCP tools in the roster → no groups at all', () => {
  assert.deepStrictEqual(groupMcpTools(REAL_BUILTINS), []);
  assert.deepStrictEqual(groupMcpTools([]), []);
  assert.strictEqual(mcpTotalTokens(groupMcpTools(REAL_BUILTINS)), 0);
  // A name that merely mentions mcp must not be swept in — the grammar is a
  // prefix with a delimiter, not a substring search. DesignSync is a real
  // connector tool that is NOT prefixed, and it must stay a built-in.
  assert.deepStrictEqual(groupMcpTools([
    { name: 'ListMcpResourcesTool', est_tokens: 100 },
    { name: 'ReadMcpResourceTool', est_tokens: 100 },
    { name: 'WaitForMcpServers', est_tokens: 100 },
    { name: 'DesignSync', est_tokens: 400 },
    { name: 'mcp_notdoubled__x', est_tokens: 50 },
  ]), []);
});

// WINDOW: the prefix is ANCHORED at the start of the name. Split out of the
// test above after a revert proof caught it: an unanchored /mcp__(.+?)__/ still
// passed every fixture there, because none of them contained `mcp__` anywhere
// but the start. A guard that cannot fail for the reason it exists is not a
// guard, so the case that distinguishes the two readings is pinned explicitly.
// An unanchored match would invent a server from any name that merely CONTAINS
// the delimiter — and would then group a built-in under it.
test('the mcp__ prefix must be anchored, not merely contained', () => {
  assert.strictEqual(mcpServerOf('Xmcp__foo__bar'), null);
  assert.strictEqual(mcpServerOf('wrap_mcp__foo__bar'), null);
  assert.deepStrictEqual(groupMcpTools([{ name: 'Xmcp__foo__bar', est_tokens: 10 }]), []);
  // Case matters too: the grammar is lowercase `mcp__`.
  assert.strictEqual(mcpServerOf('MCP__foo__bar'), null);
});

// WINDOW: absent/garbage input cannot throw. The roster is absent on a
// Codex/openai line and on a cold session (wirescope returns agents:[] or a
// line with tools:null), and the renderer calls this unconditionally.
test('a missing or malformed roster yields no groups rather than throwing', () => {
  for (const bad of [null, undefined, {}, 'tools', 42]) {
    assert.deepStrictEqual(groupMcpTools(bad), []);
  }
  assert.deepStrictEqual(groupMcpTools([null, undefined, 'x', 7, {}]), []);
  assert.strictEqual(mcpTotalTokens(null), 0);
  assert.strictEqual(mcpServerOf(null), null);
  assert.strictEqual(mcpServerOf(undefined), null);
});

// ── grouping proper ──────────────────────────────────────────────────────────
//
// WINDOW: a MIXED roster — the normal case. Built-ins are untouched (their
// existing presentation must not change), MCP tools fold into one group per
// server, and groups come back biggest-carriage-first.
test('a mixed roster folds into one group per server, biggest carriage first', () => {
  const groups = groupMcpTools([...REAL_BUILTINS, ...REAL_MCP]);
  assert.strictEqual(groups.length, 2);
  // scratchprobe 52+44=96, two_words 51+42=93 → scratchprobe leads.
  assert.deepStrictEqual(groups.map((g) => g.server), ['scratchprobe', 'two_words']);
  assert.deepStrictEqual(groups.map((g) => g.estTokens), [96, 93]);
  assert.deepStrictEqual(groups.map((g) => g.toolCount), [2, 2]);
  assert.strictEqual(mcpTotalTokens(groups), 189);
  // Each group carries its own members, in the order wirescope sent them
  // (deadweight-first), so a caller never has to re-sort.
  assert.deepStrictEqual(groups[0].tools.map((t) => t.name),
    ['mcp__scratchprobe__ping', 'mcp__scratchprobe__pong']);
  // No built-in leaked into a group.
  for (const g of groups) {
    for (const t of g.tools) assert.ok(t.name.startsWith('mcp__'), `${t.name} is not an MCP tool`);
  }
});

// WINDOW: a server whose tools went ENTIRELY unused — the case the whole
// feature is for. This is what lets the popover say "unused" and name the
// command, so the counts it rests on are pinned here.
test('a wholly unused server reports every tool unused and zero uses', () => {
  const groups = groupMcpTools(REAL_MCP);
  for (const g of groups) {
    assert.strictEqual(g.usedTotal, 0, `${g.server}: expected no uses`);
    assert.strictEqual(g.unusedCount, g.toolCount, `${g.server}: every tool should be unused`);
  }
  // And the mixed case: one server pulling its weight, one not.
  const mixed = groupMcpTools([
    { name: 'mcp__sqlite__read_query', est_tokens: 200, used: 47 },
    { name: 'mcp__sqlite__write_query', est_tokens: 150, used: 2 },
    { name: 'mcp__LunarCrush__Topic_Time_Series', est_tokens: 300, used: 0 },
    { name: 'mcp__LunarCrush__Creator', est_tokens: 120, used: 0 },
  ]);
  const [lunar, sqlite] = mixed;   // LunarCrush 420 > sqlite 350
  assert.strictEqual(lunar.server, 'LunarCrush');
  assert.strictEqual(lunar.usedTotal, 0);
  assert.strictEqual(lunar.unusedCount, 2);
  assert.strictEqual(sqlite.server, 'sqlite');
  assert.strictEqual(sqlite.usedTotal, 49);
  assert.strictEqual(sqlite.unusedCount, 0);
});

// WINDOW: utilization absent. `used` only arrives when the caller fetched with
// utilization=1; without it every tool must read as unused (0), matching
// renderUtilBlock's own `(x.used || 0)`. The popover gates its "unused" verdict
// on evaluable_turns, so a 0 here is not itself a claim of deadweight.
test('a roster without used counts treats every tool as zero-use', () => {
  const [g] = groupMcpTools([
    { name: 'mcp__sqlite__read_query', est_tokens: 200 },
    { name: 'mcp__sqlite__write_query', est_tokens: 150 },
  ]);
  assert.strictEqual(g.usedTotal, 0);
  assert.strictEqual(g.unusedCount, 2);
  assert.strictEqual(g.estTokens, 350);
  // Missing est_tokens must not produce NaN — it poisons the sort AND renders
  // as "~NaN" in the popover.
  const [h] = groupMcpTools([{ name: 'mcp__x__a' }, { name: 'mcp__x__b', est_tokens: 5 }]);
  assert.strictEqual(h.estTokens, 5);
});

// ── the known limitation, pinned as a LIMITATION ─────────────────────────────
//
// WINDOW: a server name containing a DOUBLE underscore. The grammar is not
// invertible here — `mcp__has__dunder__ping` parses equally well as server
// `has` or server `has__dunder`, and the string alone cannot say which.
// VERIFIED on real bytes in step 0: a server actually named `has__dunder`
// produced exactly this.
//
// This test pins the CURRENT, DELIBERATE reading (lazy → `has`) so the
// behaviour is a decision on record rather than an accident of regex greed. It
// is NOT asserting the desirable answer — the desirable answer is unobtainable.
// If someone later switches to a greedy parse, this test fails and sends them
// to the note in mcp-group.js explaining why neither reading is correct in
// general, which is the conversation worth forcing.
//
// The bounded harm: two servers sharing a `foo__` prefix merge into one group.
// A tool is never attributed to an unrelated server, and non-MCP tools are
// never touched — both pinned below.
test('KNOWN LIMITATION: a server name with __ is not recoverable; we take the lazy reading', () => {
  assert.strictEqual(mcpServerOf('mcp__has__dunder__ping'), 'has');
  const [g] = groupMcpTools([
    { name: 'mcp__has__dunder__ping', est_tokens: 52 },
    { name: 'mcp__has__dunder__pong', est_tokens: 44 },
  ]);
  // Both tools still land in ONE group — the grouping stays coherent even
  // though the label is the wrong half of the name.
  assert.strictEqual(g.server, 'has');
  assert.strictEqual(g.toolCount, 2);
  assert.strictEqual(g.estTokens, 96);

  // Single underscores are NOT ambiguous and must round-trip exactly.
  assert.strictEqual(mcpServerOf('mcp__two_words__ping'), 'two_words');
  assert.strictEqual(mcpServerOf('mcp__claude_design__create'), 'claude_design');
  assert.strictEqual(mcpServerOf('mcp__LunarCrush__Topic_Time_Series'), 'LunarCrush');
  // A tool name containing __ after a clean server name is unaffected.
  assert.strictEqual(mcpServerOf('mcp__sqlite__read__query'), 'sqlite');
});
