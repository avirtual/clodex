# The boiling pot — file-heat instrumentation + token-efficiency treatments

Status: SPEC. Owner: clodex. Implementers: clodex-hand (app side),
wirescope agent (enrichment side). Research grounding: two peer surveys
(landscape + failure-evidence, 07-15, reports in ~/.clodex/messages/clodex/
msg-91055-16/18) plus wirescope's measured ceiling — CORRECTED 07-15
(grok_ceiling_CORRECTION.md): the original 35.7% redundant-re-read figure
was a measurement bug (glob double-parsing + counting post-compact
re-reads); honest share is ~2% per-window (~6% absolute bound). The
correction was surfaced BY building the pot — the standing measurement
auditing the one-off study is the thesis working as designed.

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

1. **grok skill, two lanes, grammar-routed** (PRIMARY treatment since
   the 07-15 correction: the heat is real but it's first-read carriage —
   e.g. session-manager.js read 95× at 95 DISTINCT ranges, the model
   walking a big file slice by slice — which is exactly what pointer
   answers shrink). Structured lookups (def/sig/exports/line-range) →
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
2. **read-once hook — DEMOTED, not built (07-15 correction).** Its
   pre-registered kill-criterion fired before implementation: honest
   redundant-re-read headroom on disciplined agents is ~2% per-window,
   which doesn't pay for compact-detection machinery. Kept here as
   pot-resurrectable: if the tier-2 columns show a DEPLOYMENT with real
   redundancy (less-disciplined agents may differ), revive the design —
   PreToolUse refusal naming the prior delivery, compact-boundary
   tracker reset via cli-hooks.js machinery (generated bytes are
   test-pinned), edited files always pass (mtime). Kill-criterion if
   ever built: tier-2 redundantTokens share drops ≥1/3, no correctness
   incident from a stale denial.
3. **Plan B, pre-registered** (only if the skill fails its criteria): a
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
2. Commission tier 2 to wirescope agent (its repo) in parallel. DONE
   07-15: contract frozen (pot_contract.md), built + tested, tag pending.
3. grok skill (hand or clodex, after the pot surface exists to point at).
4. read-once hook: NOT scheduled (demoted, see treatment 2).
