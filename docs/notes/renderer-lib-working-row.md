# renderer/lib/working-row.js

## SHAPES
Claude Code: `✻ Bloviating… (2s · ↓ 253 tokens · thinking)` — a rotating glyph (✻ ✽ ✳ …), a capitalised verb ending in `…`, then a parenthesised `·` list holding the elapsed; the tool-running form drops `thinking`, and a `⎿ Tip:` row can sit between it and the input rule (fixtures in test/fixtures/split-states, 2.x).
Claude's API retry line `✻ Connection refused … · Retrying in 1s · attempt 2/10` has no ellipsis-and-parenthesis, so it is not a spinner.
Codex: `• Working (4s • esc to interrupt)`, optionally followed by `· 1 background terminal running · /ps to view · /stop to close`; the row is absent while prose streams, and at boot it reads `• Starting MCP servers (3/5): … (1s • esc to interrupt)` (Codex 0.157, 100x30).
Muse: `◈ Thinking (8s · esc to interrupt)`, the glyph alternating ◈/◆, with the model's one-line thinking summary drawn BETWEEN it and the `── Voice input` rule (Muse Code 1.4.0, 100x30).

## SCAN_ROWS
Muse and Claude both draw a line under the spinner (thinking summary, `⎿ Tip:`), so the reader takes the first match among the four non-blank rows above the anchor rather than only the nearest one.
