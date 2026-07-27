# t46 — surface MCP servers where the waste is

Branch `mcp-surface` off master `9cbb1ba` (the t45 merge). Baseline 2759 / ESCAPES 0.
Tier (b) from the t44 decision doc. Read-only; never-write-a-user-file is an
affirmed standing rule here, not a constraint being worked around.

## STEP 0 — the gate. **PASSED on real bytes.**

t44 §4 rested on MCP tools being prefix-keyed `mcp__<server>__*`, taken from
`transforms.py:1185`'s stated contract and never observed. Now observed.

### Method (and what it did NOT touch)

Scratch dir outside the repo, its own `.mcp.json` / `--mcp-config` naming a
trivial stdio JSON-RPC server (~30 lines of node, two tools: `ping`, `pong`).
Sessions run headless with `ANTHROPIC_BASE_URL` pointed at the live wirescope
(**v0.6.40**, `context_view` + `context_composition` + `context_utilization` all
advertised), then `/_context` read back.

- **No `claude mcp add` was run.** No write to `~/.claude.json` or
  `~/.codex/config.toml`.
- The approval run was **hash-guarded**: `shasum ~/.claude.json` before and
  after, `USER CONFIG UNCHANGED`.
- Scratch dir **deleted**. Confirmed afterwards that `~/.claude.json` has **no
  project entry for the scratch path at all** and `mcpServers` at top level is
  still `null`.
- A later hash of `~/.claude.json` differs from the guarded pair — that is
  unrelated churn from other live Claude sessions on this box (the file carries
  `cachedGrowthBookFeatures`, `toolUsage`, etc. and is rewritten constantly).
  The guarded before/after around **my** write-risk window is the relevant
  measurement, and it was clean. Saying this explicitly rather than quoting a
  hash comparison that would look alarming out of context.

### Finding 1 — the prefix holds, exactly as contracted

Live roster, main line, 31 tools:

```
mcp__scratchprobe__ping   est 52   used 0
mcp__two_words__ping      est 51   used 0
mcp__scratchprobe__pong   est 44   used 0
mcp__two_words__pong      est 42   used 0
```

`per_tool` entries carry `{name, schema_chars, est_tokens}` and, under
`utilization=1`, **`used`** — identical shape to built-ins. So the grouping is a
client-side fold over a payload the renderer already receives, as t44 claimed.
No new IPC, no new wire field.

Corroborated independently on **real** servers: `~/.claude.json`'s `toolUsage`
map (read-only, incidental to the audit above) contains
`mcp__LunarCrush__Topic_Time_Series`, `mcp__sqlite__read_query`,
`mcp__sqlite__describe_table`. Same shape, from actual past use.

### Finding 2 — THE SUBTLETY: the mapping is NOT invertible

I planted a server named `has__dunder`. The roster:

```
mcp__has__dunder__ping
mcp__has__dunder__pong
```

**From a tool name alone you cannot recover the server name.** `mcp__has__dunder__ping`
parses equally well as server `has` / tool `dunder__ping` or server `has__dunder` /
tool `ping`. A lazy regex gives the first (wrong here); a greedy one gives the
second (wrong for `mcp__LunarCrush__Topic_Time_Series`, whose tool name contains
no `__` but whose *tool* segment would be over-eaten if the server name did).

This is not a flaw in the contract — it is a direction problem. `transforms.py`
builds the prefix **from a known server name** and matches forward; we only have
the finished string and must invert it. Inversion is ambiguous precisely when a
**server** name contains `__`.

**This does not fail the gate**, and I am not treating it as one:

- The prefix itself is confirmed, which is what the gate asked.
- A server name containing `__` is legal but unusual — I had to construct one.
- The lazy (first-segment) reading is correct for every server name without
  `__`, which covers every real example available: `LunarCrush`, `sqlite`,
  `claude_design`, and the `two_words` case (single underscores are fine — only
  DOUBLE underscores are ambiguous).

So: **lazy first-segment grouping, and the limitation stated in the code.** The
failure mode is bounded and benign — two servers sharing a `foo__` prefix would
merge into one group. It cannot mis-attribute a tool to a *wrong-and-unrelated*
server, and it never affects non-MCP tools.

**Consequence for the per-server stripping clodex flagged as the likely next
step:** a strip keyed on our derived group name would be keyed on a name that is
sometimes not the real server name. The wire must keep keying on the
**configured** server name (as it does today) and must not consume a name we
derived from tool strings. Flagging, not building.

### Finding 3 — approval did NOT gate loading, in this configuration

t44 §1.2 quoted `claude mcp list`: *"Unapproved `.mcp.json` servers are shown as
⏸ Pending approval and not connected to."* I expected a project-scoped
`.mcp.json` to contribute nothing until approved.

**It contributed its tools immediately.** A plain `claude -p` in the scratch dir
with only a project `.mcp.json` present (no approval step, no config entry
written, `hasTrustDialogAccepted` never set for that path) produced all four MCP
tools in the roster.

Honest scoping of this result: it was a **headless `-p`** run. I have not
established whether interactive sessions gate differently, and I am not going to
claim they don't. What it does establish is the fact that matters for this
feature — **a server can be loaded and carried on the wire without any approval
record existing**, so the roster can show servers a config-reading feature would
have called "pending". One more reason the roster is the right source.

The inverse (a configured server that is invisible to us for a legitimate
reason) remains possible and is exactly why the UI must never claim to be a
complete inventory of configured servers. It shows **what this session is
carrying**, and should say so.

## Progress

- [x] step 0: prefix confirmed on real bytes, v0.6.40 wire
- [x] step 0: `used` counts confirmed present on MCP entries
- [x] step 0: non-invertibility found, bounded, and its consequence for stripping
- [x] step 0: approval finding
- [x] scratch dir deleted; user config verified untouched
- [x] the grouping helper (pure leaf, `renderer/lib/mcp-group.js`)
- [x] popover rendering in the existing idiom
- [x] the `claude mcp remove` guidance (amendment 2)
- [x] tests incl. the load-bearing empty case
- [x] suite green at 2767, ESCAPES 0, build:web

## The feature

`renderer/lib/mcp-group.js` — pure leaf, added to RENDERER_SCANNED_MODULES.
`groupMcpTools(perTool)` folds the roster into
`{server, tools, toolCount, estTokens, usedTotal, unusedCount}` per server,
biggest-carriage-first; `[]` when there are no MCP tools. `mcpServerOf` is
exported so a caller can filter the non-MCP remainder without re-deriving the
grammar.

`renderMcpServers(a)` in `context-popover.js` leads the right-hand column and
returns `''` when the group list is empty — so on a session without MCP the
column is **byte-identical** to before this feature. It follows the existing
idiom rather than inventing one: same `ctx-util` / `ctx-util-head` /
`ctx-row` / `ctx-dead` classes, the same `~` estimate marker with the same
tooltip, and the same `UTIL_MIN_TURNS` floor and `idle`/`unused` vocabulary the
tool and skill blocks already use. Non-MCP tools keep their presentation
exactly.

### Amendment 2 — the remove guidance

Shown only once a server is **conclusively** unused (`evaluable_turns >=
UTIL_MIN_TURNS`); telling someone to remove a server they merely have not
called yet is worse than saying nothing.

`claude mcp remove --help` **[CLI]**: *"if not specified, removes from
whichever scope it exists in"* — so **the generic form is CORRECT, not a
hedge**, and the hint says so ("removes from whichever scope defines the
server") rather than claiming a scope we cannot know from the roster. This is
better than the amendment anticipated: the CLI resolves the scope itself, so we
never need to. `claude mcp reset-project-choices` **[CLI]** is named for
project `.mcp.json` approvals — verified: *"Reset all approved and rejected
project-scoped (.mcp.json) servers within this project"*.

No button, nothing that runs a command, no config write. The text says plainly
that Clodex never edits your MCP config.

### Not foreclosed, not built

Per-server stripping would key on a **configured** server name. Our group key
is DERIVED and, for a `__`-containing server name, is not that name (Finding 2).
So a future strip must keep keying on the configured name as wirescope does
today and must never consume our derived key. Recorded in `mcp-group.js`'s
header so it is where an implementer will look.

No wire field was added. Nothing in this ticket reads or writes config.

## Tests — `test/mcp-group.test.js`, 7 tests

Fixtures are the **real** step-0 roster entries plus real names from this box's
own `toolUsage` history, not invented shapes.

Windows: the load-bearing empty case; malformed/absent roster; mixed roster;
wholly-unused server; utilization absent; the anchor; the `__` limitation.

### A hole the revert proof caught

My first anchor claim was folded into the empty-case test — and an unanchored
`/mcp__(.+?)__/i` **passed every fixture**, because none of them contained the
delimiter anywhere but at the start. **A guard that cannot fail for the reason
it exists is not a guard.** Split into its own test with `Xmcp__foo__bar`,
`wrap_mcp__foo__bar` and `MCP__foo__bar`; the revert now fails it.

Found by running the revert rather than by reading the test, which is the whole
argument for doing reverts on tests that look obviously correct.

### Revert proof — three, all by message

| revert | fails |
|---|---|
| unanchored `/mcp__(.+?)__/i` | the anchor test |
| greedy `/^mcp__(.+)__/` | the limitation test, `actual: 'has__dunder', expected: 'has'` |
| drop the non-MCP `continue` guard | 4 tests, incl. the empty case |

## Verification

`TOTALS: 2767 pass, 0 fail` / `ESCAPES: 0`. Baseline 2759 + 7 new = 2766, and
the **+1 is accounted for**: `free-identifier-leaks` emits one test per scanned
module and went 80 → 81 when `mcp-group.js` joined the list. Verified by
stashing rather than assumed. No existing test edited.

`npm run build:web` run — bundled renderer source changed.
