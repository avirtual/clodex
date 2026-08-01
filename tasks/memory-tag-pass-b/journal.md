# t128 — Pass B: nightly memory tagger

## The enumeration clodex asked me to double-check

### What READS `tags:` / `tags_v:`

Whole tree, vendor + docs + tasks excluded:

- `memory-store.js:97` — `list()` projects `tags` onto the unit.
- `memory-store.js:127` — `recall()` haystack.
- `scripts/memory-tag/build-corpus.js:38-39` — the `--unprocessed` filter.
- `test/memory-store.test.js` — t127's cases.

Nothing else assumes tags absent. Clodex's list was complete **for `tags`**.
It was not complete for `tags_v`, which is the finding below.

### FINDING 1 — `--unprocessed` is a no-op today, and t128 depends on it

`build-corpus.js:39` reads `u.tags_v`. `list()` (`memory-store.js:91-99`)
projects a FIXED set of fields — `id, scope, learned_at, source, pinned, tags,
body` — and `tags_v` is not among them. So `u.tags_v` is always `undefined`,
`Number(undefined || 0) < 1` is always true, and **every unit with tags is
re-selected as unprocessed.**

Measured on a 3-unit fixture, 2 units fully tagged at `tags_v: 1`:

    corpus: 3 of 3 units

Expected `1 of 3`. The version-bump-requeues-the-corpus mechanism the comment
at `:36-38` describes has never worked.

This matters for t128 specifically: `tag-nightly.sh` is specced to run
`build-corpus.js --unprocessed` and exit early when empty. Uncorrected, the
nightly re-tags the entire store every night — it never converges, and the
"nothing unprocessed" exit is unreachable.

`build-corpus.js` is INSIDE the ticket's fence (`scripts/memory-tag/`), so I am
fixing it. Flagged as a deviation because it is Pass A's file and the spec did
not name it.

### FINDING 2 — "byte-identical" is not achievable through the serializer

The spec requires body/pinned/unknown keys to "survive byte-identically".
Frontmatter keys and body CONTENT do survive. But a parse→serialize round trip
NORMALIZES trailing newlines: `parseMemoryUnit` trims the body,
`serializeMemoryUnit` emits exactly one trailing newline. Measured by clodex at
7498631: 189 of 191 live units re-serialize identically, 2 differ by one
trailing newline, and the same 2 differ at HEAD — it predates t127.

So `apply.js` rewriting one of those 2 units will normalize it. That is
inherited from the serializer the spec tells me to use, not something apply.js
can avoid while using it. My tests assert preservation of every frontmatter key,
`pinned`, its LAST position, and the body — not raw file bytes, which would be
asserting a property the mandated mechanism does not have.

## Decisions

- **Root convention:** `--root=` on BOTH scripts, falling back to
  `CLODEX_MEMORY_ROOT`, then the real store. Resolved by one shared function so
  the two cannot drift. The spec said pick one and make them consistent; this
  keeps the existing env-var entry point working rather than breaking a caller
  to prove a point.
- **Census lives in a shared module** (`unit-file.js`) with the raw-file
  read/write and the root resolution — `apply.js` and `tag-nightly.sh` both
  need it, and `build-corpus.js` needs the same `tags_v` read.
- **apply.js is the sole writer.** The model only ever writes the flat scratch
  file; nothing in the pipeline lets a model touch a unit file.

## Delivered

- `unit-file.js` (new) — root resolution, raw `tags_v` read, `writeTags`
  (spread-preserving), `isUnprocessed`, `census`.
- `census.js` (new) — `tag: count` desc; `--seed=` appends unapplied tags at
  count 0, LABELLED, and skips any already in the census. Missing seed file
  exits 1 rather than silently yielding an empty census.
- `apply.js` (new) — sole writer. Validates id/format/length/count/duplicates,
  rejects with a per-line reason, never repairs. `--dry-run`. Nonzero exit on
  any rejection.
- `tag-prompt.md` (new), `tag-nightly.sh` (new).
- `build-corpus.js` (edited — Finding 1).
- `test/memory-tag-apply.test.js` (new, 10 cases).

## Verification

Full suite **3221/3221, ESCAPES: 0** (3211 + 10).

End-to-end against temp fixtures with a stubbed `claude` (never the live store):
2 unprocessed → model writes 1 good + 1 bad line → `1 applied, 1 rejected`,
script exit 1. Corpus then 1 of 3, then 0 of 3 → `nothing unprocessed`, exit 0.
**The pipeline converges**, which it could not have before Finding 1.

All 18 of clodex's seed tags pass apply.js's own validator — the prompt's rules
and the applier's rules agree, checked rather than assumed.

| # | mutant | result |
|---|---|---|
| (a) | max-tag-count check removed | 1 fail — `"one,two,three,four" should not apply` |
| (b) | tag format check removed | 2 fail — `"Plugins" should not apply` |
| (c) | unknown-id check removed | 1 fail |
| (d) | `writeTags` drops unknown keys | 1 fail — `the rewrite dropped an unknown frontmatter key` |
| (e) | `tags_v` not written | 1 fail — `tags_v was not written` |
| (f) | `--dry-run` writes anyway | 1 fail — `dry-run wrote to disk` |
| (g) | duplicate-tag check removed | 1 fail — `"dup,dup" should not apply` |

Product restored byte-identical after each.

### Two assertions that failed bare, fixed

(d) and (e) first failed on messageless `strictEqual` — readable only from the
diff. Both now carry messages naming the property. Same axis as the t127
finding: a red that does not say what broke is a red a summary line hides.

### Shell details worth recording

- `shift 2` breaks when only an agent is passed (flags then land in `$MODEL`).
  Positionals and flags are now separated by SHAPE.
- `"${ARR[@]}"` on an empty array aborts under `set -u` in bash 3.2, which is
  `/bin/bash` on this machine and what a launchd nightly may get. Guarded with
  `${ARR[@]+"${ARR[@]}"}`; `/bin/bash -n` parse-checked.

### Cleanup note

My first e2e run truncated Pass A's `corpus.clodex.md` to 0 bytes (the script
regenerates it by design). Restored by re-running `build-corpus.js --all` —
194084 bytes, same as before. It is gitignored and derived, so no content was
at risk, but flagging it since it is Pass A's artifact.
