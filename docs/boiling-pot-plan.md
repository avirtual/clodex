# The boiling pot — file-heat instrumentation + token-efficiency treatments

Status: SPEC. Owner: clodex. Implementers: clodex-hand (app side),
wirescope agent (enrichment side). Research grounding: two peer surveys
(landscape + failure-evidence, 07-15, reports in ~/.clodex/messages/clodex/
msg-91055-16/18) plus wirescope's measured ceiling (grok_ceiling.md:
35.7% of Read carriage is redundant re-reads; 424k/1.19M tok over 3 days).

## Thesis (operator-set)

Don't ship a fixed optimization aimed at today's hot files. Ship the
MEASUREMENT as the product: automatically detect files that are read or
modified very often, rank where the token waste is, and let optimizations
subscribe to that ranking — a "boiling pot" that suggests treatments and
then judges them by whether the numbers it tracks actually move. The field
is full of unmeasured token-saving machinery (survey verdict: every
headline claim is vendor-self-reported; nobody measures redundant re-read
share at all). Our differentiator is that we already measure.

## Architecture: two tiers, one record shape

The pot is data, not machinery: per-file rolling counters, ranked. Two
producers fill the same record; the expensive columns are nullable — the
sinceCompact pattern (absent === null, never partial).

    { file, window: {from, to},
      reads, edits, approxReadTokens,          // tier 1 — always available
      redundantReads, redundantTokens,         // tier 2 — wirescope-linked only
      lastSuggestion }

### Tier 1 — in-app, on our own wire (works with wirescope OFF)

Ground truth (verified in code, 07-15): the in-process wire tee
(wire/proxy.js) is the primary path for every agent session — intents
already ride it (W3); JsonlWatcher survives only as TranscriptSentinel.
wire/sse.js's FileToolCollector ALREADY extracts tool name + file path
from tool_use blocks for Edit/MultiEdit/Write/NotebookEdit, with the
hot-path discipline solved (parse deltas only while a tracked block's
path is unknown; 64k cap; fact-extraction only).

Work:
1. **Extend FileToolCollector to Read** (+ capture offset/limit when
   present — same path-regex approach, two more keys). Emit
   `{tool:'Read', path, offset, limit}` alongside the existing entries.
   Same over-report caveat as the header documents (a tool_use is the
   model's REQUEST; denial is rare and noise-level for heat ranking).
2. **Token weight without body parsing**: we are in-process on the same
   machine — `fs.stat` the path at collection time and estimate
   bytes/4, range-adjusted when offset/limit present. Cheap, sync-free
   (fs.promises, swallow errors → null weight), and honest enough for
   ranking. NO parsing of tool_result bodies out of subsequent requests
   (that's tier 2's job via wirescope, where the bodies already land).
3. **file-heat.js** (new leaf + small factory): rolling per-file
   counters, bucketed by day, kept N=14 days, persisted as ONE json
   under `~/.clodex/run/{name}/` — add a `file-heat.json` kind to
   clodex-paths.js (the path grammar is single-sourced there). Flush
   debounced (≥30s), load lazily, corrupt file → start empty. Aggregate
   across agents at read time, not write time (per-agent files, no
   shared-write contention; same layout philosophy as the rest of run/).
4. **Surface v1 — a pot section in the wirescope drawer** (or its own
   small popover off the statusbar): top-10 by approxReadTokens over the
   window, columns reads/edits/~tokens, plus the tier-2 columns when
   present. Renderer-only consumer of a `pot:snapshot` IPC endpoint
   (api-contract +1). No suggestions engine in v1 — the ranked table IS
   the suggestion surface; treatment hints (below) are a static legend.

### Tier 2 — wirescope enrichment (when linked)

The column tier 1 cannot compute: was the read REDUNDANT (content already
in the caller's context)? That requires request-body reconstruction
across turns — exactly what the ceiling script already does offline over
logs_main. Commission to wirescope (its tree, its release cycle):
promote the one-off classification into a standing rolling aggregation
exposed at `/_pot` (or folded into /_status), per file: {reads,
redundant_reads, redundant_tokens, window}. Client shapes it into the
tier-2 columns; capability-advertised in /_identity like since_compact.

## Treatments (consumers of the pot, each independently deletable)

Ranked by the surveys' evidence; each ships with kill-criteria measured
BY the pot itself (re-check after ~5 days; delete what doesn't move its
claimed column).

1. **read-once hook** (highest leverage; attacks the 35.7% directly).
   PreToolUse hook: a Read of a file already delivered UNCHANGED this
   context window is answered with a short refusal naming the prior
   delivery ("already in context since <turn>, unchanged; Read denied —
   re-read with force:true semantics = pass offset/limit"). Mechanical,
   no model cooperation needed, honest (a refusal message, not a forged
   result). Hardening over the field's n=1 prior art: reset the tracker
   at COMPACT boundaries (post-compact the content genuinely left
   context — the published version guesses with a 20-min TTL). Compact
   detection: the hook script can watch the transcript symlink repoint
   /size-drop via the existing SessionStart/PreCompact hook machinery in
   cli-hooks.js (generated bytes are test-pinned — edits there must
   update pins). Edited files always pass (mtime check). Kill-criterion:
   tier-2 redundantTokens share drops by ≥1/3 on hook-enabled agents, no
   correctness incident traced to a stale denial.
2. **grok skill, two lanes, grammar-routed** (shrinks first-read
   carriage too). Structured lookups (def/sig/exports/line-range) →
   deterministic grep over the LIVE tree; synthesis questions → fresh
   stateless Sonnet subagent. Contract rules from the failure evidence:
   answers are FILE:LINE POINTERS + minimal excerpt, never prose
   paraphrase of code (models re-verify paraphrase against source — pays
   twice); callers-of/dataflow stays in the model lane (factory/injected-
   seam code is where static tooling confidently lies); output stable
   and append-only (cache discipline). The skill text points at the POT
   for current hot files instead of hardcoding names — the pot is what
   keeps it from decaying into a stale map. Delivered as a skill, NOT an
   MCP server (per-turn schema tax).
3. **Plan B, pre-registered** (only if 1+2 fail their criteria): a
   lightweight structural index for multi-file work — the one controlled
   result where an index beat agentic grep on tokens/turns/cost
   (arXiv 2606.22417). Not vectors, not a map-in-every-prompt.

## Non-goals

- No pre-built index in v1 (staleness; scale-inversion: index savings
  are near-zero at our ~50-module size — survey-confirmed).
- No automatic APPLICATION of treatments; the pot suggests, the operator
  and agents decide. Automation earns trust as a report first.
- No MCP server delivery for any of it.
- Tier 1 does not attempt redundancy detection (that's a context-window
  question only the request bodies answer — tier 2 owns it).

## Order of work

1. Tier 1 (hand): FileToolCollector Read support → file-heat.js →
   pot surface. Each a review-sized chunk.
2. Commission tier 2 to wirescope agent (its repo) in parallel.
3. read-once hook (hand, after tier 1 — its kill-criterion needs the pot).
4. grok skill (hand or clodex, after the pot surface exists to point at).
