'use strict';
// lib/mcp-group.js — fold a wirescope tool roster into per-MCP-server groups.
//
// WHY THIS EXISTS. MCP servers are the single biggest per-turn context carriage
// most users ever add, and until now Clodex showed nothing about them: a user
// running three servers at 12k tok/turn opened the context popover and saw
// twenty individually-named rows with no indication they belonged together, let
// alone what each server cost. Clodex surfaces where the waste is happening;
// this is the fold that lets it do so for MCP.
//
// PURE LEAF. Takes the `per_tool` array the renderer ALREADY receives from
// wirescope's /_context (via proxy:context) and returns a grouped view. No IPC,
// no wire field, no config read — deliberately: the roster is post-resolution
// truth (what actually reached the model this turn), which a config file cannot
// tell you, and it carries no credentials, so the "never render env or headers"
// hazard cannot arise here by construction.
//
// ── THE NAME GRAMMAR, AND ITS ONE AMBIGUITY ─────────────────────────────────
//
// MCP tools arrive named `mcp__<server>__<tool>`. VERIFIED ON REAL BYTES (t46
// step 0, wirescope v0.6.40): a live roster carrying two scratch servers
// produced mcp__scratchprobe__ping / mcp__two_words__pong etc., and real past
// usage on this box shows mcp__LunarCrush__Topic_Time_Series,
// mcp__sqlite__read_query. Not taken from documentation.
//
// The mapping is NOT INVERTIBLE, and that is a property of the grammar rather
// than a bug here. A server whose own name contains `__` produces
// `mcp__has__dunder__ping`, which parses equally well as server `has` (tool
// `dunder__ping`) or server `has__dunder` (tool `ping`) — the string alone
// cannot say. wirescope's strip builds the prefix FORWARD from a known server
// name, so it never faces this; we only have the finished string.
//
// We take the LAZY (first-segment) reading. It is correct for every server name
// without a double underscore, which is every real example available —
// LunarCrush, sqlite, claude_design, two_words (SINGLE underscores are fine;
// only DOUBLE are ambiguous). The bounded failure mode is that two servers
// sharing a `foo__` prefix would merge into one group. It can never
// mis-attribute a tool to an unrelated server, and it cannot touch non-MCP
// tools at all.
//
// CONSEQUENCE FOR ANY FUTURE PER-SERVER STRIP: the group key below is DERIVED
// and is sometimes not the real configured server name. A strip must keep
// keying on the configured name (as wirescope does today) and must never
// consume a key we reconstructed from tool strings.

// Lazy: stop at the FIRST `__` after the prefix. See the ambiguity note above.
const MCP_TOOL_RE = /^mcp__(.+?)__/;

// The server a roster tool belongs to, or null for a built-in. Exported so a
// caller can filter the non-MCP remainder without re-deriving the grammar.
function mcpServerOf(toolName) {
  const m = MCP_TOOL_RE.exec(typeof toolName === 'string' ? toolName : '');
  return m ? m[1] : null;
}

// Group a per_tool array by server.
//
// Returns [] when there are no MCP tools — which is the common case and is
// load-bearing: a user with no MCP servers must see NO new UI at all, not an
// empty section and not a zero row. Callers render nothing on an empty array.
//
// Each group: { server, tools[], toolCount, estTokens, usedTotal, unusedCount }.
// `tools` keeps wirescope's incoming order (deadweight-first), so a caller can
// render a group's members without re-sorting. Groups themselves come back
// biggest-carriage-first — the "what is costing me most" order the rest of this
// popover already uses.
//
// `used` is only present when the caller fetched with utilization=1; absent is
// treated as 0 (unused), matching renderUtilBlock's own `(x.used || 0)` read.
function groupMcpTools(perTool) {
  if (!Array.isArray(perTool)) return [];
  const byServer = new Map();
  for (const t of perTool) {
    if (!t || typeof t !== 'object') continue;
    const server = mcpServerOf(t.name);
    if (!server) continue;
    let g = byServer.get(server);
    if (!g) {
      g = { server, tools: [], toolCount: 0, estTokens: 0, usedTotal: 0, unusedCount: 0 };
      byServer.set(server, g);
    }
    g.tools.push(t);
    g.toolCount += 1;
    g.estTokens += Number(t.est_tokens) || 0;
    const used = Number(t.used) || 0;
    g.usedTotal += used;
    if (used === 0) g.unusedCount += 1;
  }
  return [...byServer.values()].sort((a, b) => b.estTokens - a.estTokens);
}

// Total per-turn carriage across every MCP server — the headline number. 0 when
// there are none.
function mcpTotalTokens(groups) {
  if (!Array.isArray(groups)) return 0;
  return groups.reduce((n, g) => n + (g.estTokens || 0), 0);
}

module.exports = { mcpServerOf, groupMcpTools, mcpTotalTokens, MCP_TOOL_RE };
