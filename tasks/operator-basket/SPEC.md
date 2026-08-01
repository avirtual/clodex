# t140 — operator basket: capture

Continuous capture of what the operator says, into a raw append-only tier
that never touches any agent's boot digest.

Companion ticket (retrieval, separate) reads what this writes. This ticket
ships capture only. If nothing ever reads the basket, this ticket is still
correct and still complete.

## Why provenance, not pattern matching

Measured on one real transcript, 2026-08-01: classifying operator messages by
"user entry that does not start with `[agent:]`" gives a **20% false-operator
rate** — 221 of 1,099. 197 are Claude Code's own shapes (compact summaries,
`/compact` echoes, `[Request interrupted by user]`, task-notifications,
post-compact boot prompts) that never crossed a Clodex seam at all; 24 DO
start with `[agent:]` but behind the leading `\x15` that `_injectText` writes
to clear the line, so a naive `startsWith` misses every one.

Those 197 shapes are invented by the vendor CLI, not by us, so the text rule
degrades silently every time the vendor adds one. **Capture at the seam
instead.** There are exactly two ways the operator speaks to an agent, both
already labelled:

- terminal typing -> `session-manager.js:1245` `write()`, gated by
  `isHumanPtyInput(data)`
- app panel -> `_injectText` carrying the `[agent:from user]` label

Everything else Clodex injects goes through `_injectText` WITHOUT that label.
Provenance answers the question with no regex, and the 197 never enter the
stream because they do not cross the seam.

Do not add a text-based operator classifier anywhere in this ticket.

## Setting (build this first, and honour it from the first byte)

One boolean in `uiSettings`, default **OFF**. Name it, and put the name in the
JOURNAL.

- OFF: nothing is written, no files are created, no directories are created.
  A user who never turns this on must not be able to tell the feature exists
  from their disk.
- Flipping ON starts capture from that moment. No backfill.
- Flipping OFF stops capture and leaves existing data alone. Deletion is a
  separate explicit action, not a side effect of a toggle.

`ui-settings.json` also holds peer tokens (`stores.js:1075`). Add a boolean
and nothing else. No captured content, no paths derived from content.

## Storage layout

Daily basket, then a promotion pass, as the operator specified:

```
~/.clodex/library/basket/raw/YYYY-MM-DD.jsonl     <- today, append-only
~/.clodex/library/basket/operator.jsonl           <- promoted, cumulative
```

Path grammar goes in `clodex-paths.js` alongside the existing kinds. The
basket is SHARED (like `messages/`, `agents/`, `skills/`), not per-agent —
it lives under the library root, not under `run/{name}/`.

Append-only, one JSON object per line, fsync not required. A partial trailing
line from a crash must be skipped by the reader, not repair-attempted.

### Record shape

```
{
  ts:        ISO8601,
  text:      string,          // what the operator wrote, verbatim
  via:       'pty' | 'panel',
  agent:     string,          // the session it was addressed to
  workspace: string,          // workspaceId
  cwd:       string,          // session cwd at capture time
  pasted:    boolean,         // arrived inside a bracketed-paste region
  reply:     string | null    // see "The answering half"
}
```

`agent` / `workspace` / `cwd` are recorded as FIELDS, never as directories.
The operator's decision was: one basket, destination is a scoring feature at
retrieval, not a partition at write time. Partitioning at write is
irreversible; a field can always be filtered later.

## Capture sources

### (a) Terminal typing

t139 (`tasks/hint-injector`) builds a draft accumulator in `write()` —
printable bytes, backspace, Ctrl-U/Ctrl-C clear, reset on Enter. That
accumulator IS the operator's message, assembled.

**Coordinate with t139, do not build a second accumulator.** If t139 has
landed, read its buffer at the Enter (`closes`) edge. If it has not, build
the accumulator to t139's spec and t139 consumes yours. Two independent
buffers on the same seam is the failure to avoid; say in the JOURNAL which
way it went.

Capture fires on `closes` only — an abandoned draft was never a message.

### (b) App panel

At the `_injectText` call carrying the `[agent:from user]` label. Capture the
body WITHOUT the label. Nothing else routed through `_injectText` is
operator-authored, so do not widen this.

### (c) Explicitly NOT captured

Peer dms, ticket delivery, nudges, exec output, reminder fires, notify-user
echoes. These are agent traffic; if they are ever worth storing it is under a
different `source`, and that is not this ticket.

## Paste

Paste is operator-authored but not operator-typed, and the operator pastes
logs and stack dumps constantly. Record `pasted: true` (bracketed-paste
markers make this free — `draftChunkSignal` already tracks the region) and
capture it in full. Do NOT apply t139's 4KB cap here: that cap is a
hint-quality guard, and truncating the raw tier destroys information the
nightly pass may want. Cap the raw tier at 256KB per record purely as a
runaway guard, and mark truncation explicitly with a `truncated: true` field
rather than silently cutting.

## The answering half

The extraction unit is the EXCHANGE, not the message: an operator directive
plus the reply that answered it. The reply is available from
`jsonl-watcher`'s flushed turn text (it already buffers assistant text by
requestId and flushes on requestId change / non-assistant / 1s silence).

Attach the FIRST flushed assistant turn following the capture, on the same
session, as `reply`. If none arrives within 10 minutes, leave `reply: null`
and move on — a null reply is a correct record, not a failed one.

Do not block the capture write waiting for the reply. Write the record with
`reply: null`, then patch it. Since the file is append-only, "patch" means
appending a second record `{ ts, patches: <id>, reply }` and letting the
reader fold them; do not rewrite lines in place.

That requires a stable per-record `id`. Add one (`b-<epoch>-<rand>`).

## Nightly promotion

`raw/YYYY-MM-DD.jsonl` -> `operator.jsonl`, processing YESTERDAY's file only
(never today's — it is still being appended to).

This cut does the mechanical part ONLY:
- fold patch records into their targets
- drop empty / whitespace-only captures
- drop exact-duplicate text within the same session inside 60s (double-Enter)
- append the survivors to `operator.jsonl`
- leave the raw daily file in place; do not delete it

**No classification, no tagging, no promotion into any agent's curated memory
store in this ticket.** `scripts/memory-tag/` already exists and is where
that work goes, in a later ticket. The reason for the split: consolidation's
first live run inverted the one case where I knew the right answer, so
anything that MOVES data on a judgement gets built and reviewed separately
from anything that merely collects it.

Reuse `scripts/memory-tag/tag-nightly.sh`'s scheduling approach rather than
inventing a second scheduler. Note in the JOURNAL what you found there.

## Confinement

A source must be able to declare which sessions may read it. Not needed for
retrieval in this ticket, but the basket records `cwd` and `workspace` so the
retrieval ticket can enforce it. Make sure both fields are always populated
(empty string, never undefined) so the later filter cannot silently pass a
record with a missing field.

## Non-negotiable

- Capture must NEVER affect whether a keystroke reaches the PTY. Wrap every
  capture call so a throw cannot propagate into `write()`. Test this with a
  capture that throws.
- Capture must never touch any boot digest. The basket is a separate tier;
  `memory-store.list()` must return exactly what it returns today. There is a
  test to that effect — do not modify it.
- No secret values in argv, logs, markers or errors. The basket holds
  verbatim operator text by design; that is data at rest under `~/.clodex`
  (0700). It must never be echoed into a log line, an error message, or a
  process argument.
- No emojis.

## Tests

- Setting OFF: no file, no directory created, after both capture paths fire.
- Setting ON -> OFF: capture stops, existing file untouched.
- pty path: multi-keystroke draft captured once, at Enter, with the full text.
- Abandoned draft (Ctrl-C) captures nothing.
- Injected/non-human writes capture nothing.
- Panel path: captured without the `[agent:from user]` label.
- Peer dm, ticket delivery, nudge: capture nothing.
- Paste: `pasted: true`, full body, no 4KB truncation.
- 256KB runaway: `truncated: true` present.
- reply attaches from the next flushed assistant turn; times out to null.
- Nightly: patch folding, dup-drop, yesterday-only, raw file survives.
- Reader skips a partial trailing line.
- A capture that throws does not break `write()`.

Suite green: `[agent:exec clodex-run-tests]`, baseline 3279.
New modules go in `test/free-identifier-leaks.test.js` SCANNED_MODULES.

## Journal

`tasks/operator-basket/JOURNAL.md`, as you go. At minimum: the setting name,
how the t139 accumulator coordination resolved, what you found in
`tag-nightly.sh`, and anything at the seam that did not match this spec.

## Standing constraints

Do not commit, tag or push. Leave the tree dirty for review. Comments earn
their place by naming a wrong change they prevent (`.claude/CLAUDE.md`).
Flag every deviation and assumption in your report.
