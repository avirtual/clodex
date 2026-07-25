# Boiling pot — archaeology (t23)

Read-only investigation for clodex, on Bogdan's question: what is the pot FOR.
No code changed, nothing retired. Answers below are from artifacts + observed
on-disk data; where the record does not say, that is stated rather than filled.

## A. What is collected

Per-agent JSON at `~/.clodex/run/<name>/file-heat.json` (kind `fileHeat`,
`clodex-paths.js:28-30`). Shape, `{version, days: {'YYYY-MM-DD': {<abs path>:
{reads, edits, tokens, ranges[]}}}}` — `file-heat.js:79-89`.

- **Granularity**: UTC day bucket × absolute file path (`:40-46`).
- **Fields**: read count, edit count, accumulated carriage estimate, and the
  distinct read-range signatures (`:62-67`), capped 256/file/day (`:33`).
- **`tokens` is bytes/4**, line-slice adjusted from the Read tool's
  offset/limit (`:50-58`) — an explicit RANKING estimate, never billing.
- **Retention** 14 days rolling, pruned on load/flush/snapshot (`:31`, `:93-99`).
- **PATHS ONLY, never content.** The producer receives `{tool, path, offset,
  limit}` from the wire collector (`wire/sse.js:213-228`); the only file access
  is `fs.stat` for a byte size (`file-heat.js:186-188`).
- **Size, measured today**: 8 agent files, **44K total**, largest 14K
  (clodex-hand), 173 file-day entries. Not a growth concern.
- **Egress: none.** No route on the wire (`docs/ipcmain-vs-wire-gap.md:187`
  records the pot as a Gap), nothing in remote.js/peer-client.js touches it.
  The one network call is INBOUND — `potSeries` GETs wirescope's `/_pot`
  (`wirescope-proxy.js:203-213`). So it is ambient telemetry about which files
  Bogdan's agents touch, held locally, sent nowhere.

**Cost**: collection rides every non-side-call turn completion
(`session-manager.js:482-487`) for every wire-routed session, and `WIRE_SHADOW`
defaults ON (`engine.js:265`, `!== '0'`). One `fs.stat` per Read, fire-and-forget
(`session-manager.js:2262`); writes debounced ≥30s (`file-heat.js:32`); the file
is created only once a turn actually touches files (`:2243-2248`). It runs
**whether or not the drawer is ever opened**.

## B. Consumers — two, both read-only, neither automatic

1. **The drawer** — `renderer/pot-drawer.js:38` → `window.api.potSnapshot`
   → `ipc-handlers.js:853` → `session-manager.js:2278`. A human looking.
2. **`pot-cli.js`, read by an AGENT** — the grok skill runs
   `node "$HOME/.clodex/bin/pot-cli.js" --top 15` (`~/.clodex/skills/grok.md:15`)
   to decide which files are worth a pointer-answer instead of a re-read. This
   is the one that is easy to miss, and it is not a display: it steers agent
   behaviour, via the agent's own judgment.

**Nothing in the engine changes behaviour based on heat.** No cache, no
prefetch, no eviction, no routing. Searched every `file-heat` /
`aggregateStates` / `potSnapshot` reference: producers, the two readers above,
and tests. That absence is DELIBERATE, not an omission — `docs/boiling-pot-plan.md:164-165`
lists "No automatic APPLICATION of treatments; the pot suggests, the operator
and agents decide" as a stated non-goal.

## C. The stated plan — it exists, and it is quotable

`docs/boiling-pot-plan.md:13-22`, "Thesis (operator-set)":

> Don't ship a fixed optimization aimed at today's hot files. Ship the
> MEASUREMENT as the product: automatically detect files that are read or
> modified very often, rank where the token waste is, and let optimizations
> subscribe to that ranking — a "boiling pot" that suggests treatments and
> then judges them by whether the numbers it tracks actually move.

Bogdan's remembered hunch ("statistics… to optimise how we handle accessing
commonly-accessed files") is close but inverted in an important way: the plan
explicitly REFUSES to ship the optimisation, and ships the measuring stick that
judges optimisations instead. Four treatments are enumerated (`:82-158`), each
"independently deletable" with a pre-registered kill-criterion.

Treatment 1, the grok skill, is the only one built (`:104-115`). Its
kill-criterion is fully pre-registered at `:117-129`: baseline the top-5 hot
rows verbatim to `~/.clodex/pot-baselines/grok-<date>.json`, recheck ~5 days
after enablement, KEEP only if carriage drops ≥25% OR segments drop ≥1/3.

## The thing that was actually lost

`~/.clodex/pot-baselines/` holds three files:
- `grok-2026-07-18.json` — the BEFORE side of the carriage criterion.
- `hand-sendmessage-2026-07-18.json` — BEFORE, wirescope's half of the A/B.
- `hand-sendmessage-2026-07-23.json` — AFTER, wirescope's half.

**There is no `grok-<date>` AFTER file.** The wirescope half of the measurement
was completed on schedule; the pot-carriage half — the one the kill-criterion
turns on — was never captured. So the pot is not a feature nobody understood:
it is a feature whose purpose is documented in detail and whose ONE pending
decision (keep or delete the grok skill) has an unfinished measurement. That
matches the two-week-lost reminder exactly.

Not asserted: why it lapsed, and whether the data still supports a late
recheck. Observed only — most agent heat files currently hold 1–2 day buckets
(clodex-hand: `2026-07-25` alone), so a recheck against the 07-18 baseline may
no longer have a comparable window. I did not determine why the buckets are
that thin and am not guessing.
