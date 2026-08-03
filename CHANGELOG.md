# Changelog

Notable changes per release, written for people running Clodex rather than
reading its diffs. Starts here — earlier releases are described only by their
GitHub release notes, which were generated from commit subjects.

Keep `Unreleased` current as work lands. `scripts/release.sh` publishes it
verbatim as the release notes, then stamps it with the version and date and
opens a fresh empty one — so anything missing from it is missing from the
release. Text after `## Unreleased —` becomes the release subtitle. An empty or
absent `Unreleased` falls back to auto-generated commit subjects, so this never
blocks a release.

## Unreleased

- **A hint no longer outlives the draft it was ranked against.** Arming happens
  at a typing pause, so a draft you keep editing could leave a hint registered
  against text that no longer exists. Continuing to type already replaced it;
  what didn't was editing your way down to *no* match — the previous winner
  stayed armed and rode the request. The hint slot is now cleared whenever the
  current draft earns nothing, including when it becomes unreadable (history
  recall, tab completion) or drops back below the length floor.
- A hint now says it is retrieved rather than verified: where one conflicts with
  what you just said, the agent is told you are right.

## 4.12.0 — 2026-08-03 — Memory an agent can actually use

The theme is retrieval: an agent now gets the right memory attached to the right
question, without anyone having to know the memory exists.

### Contextual hints

- **Hints arrive on the turn they were meant for.** A hint is attached to a
  single request, and arming it when you pressed Enter registered it ~200-300 ms
  after that request had already gone — so it rode the *next* turn and answered
  a question you had moved on from. Arming now happens on a brief typing pause,
  before Enter exists. If a message is delivered to the seat while a hint is
  waiting, it queues behind your draft instead of consuming the hint.
- **Short personal questions work.** "how old is my son", "where do i live" —
  these are one meaningful word after stopwords, and the lexical matcher scored
  every record in the store identically for them, so the "best" match was
  whichever id sorted first. These are now admitted on question shape and ranked
  by meaning. Questions about the *work* ("why is my test failing", "where is my
  config file") are deliberately excluded: measured 0 false hints across 14 of
  them.
- **Common memory.** A shared store every agent can match against, ranked as its
  own corpus, for facts that belong to you rather than to one agent.
- **A hint now says where it came from**, and no longer causes an agent to
  retract a correct answer. Previously an agent could answer from a hint, fail to
  find the source on the next turn (the hint is deliberately not repeated), and
  disown its own correct answer as something it had invented.
- Hints have a Preferences checkbox, and semantic ranking has its own.

### Semantic ranking (optional — needs Ollama)

Ranking by meaning rather than by shared words. **Ollama is not a dependency**:
without it every path reports "no opinion" and hint behaviour is exactly what it
was before — no errors, no hangs, no degraded mode. With it (`nomic-embed-text`),
hints get markedly better at paraphrase.

Note for anyone who enabled this during development: a caching bug caused each
agent's indexing pass to evict every other agent's vectors, so the feature could
never warm up. Fixed.

### Memory store

- `[agent:memory remember] tags=a,b` is parsed instead of being swallowed into
  the body — tags written this way previously vanished, taking any `pinned=true`
  after them with it.
- The operator owns pinning. An agent's own `pinned=true` is a recency nudge, not
  a guaranteed slot, and short recent units ride in full by default.
- Unknown frontmatter keys survive a rewrite instead of being dropped, and tags
  are searchable.
- The save instruction now asks for one usable claim rather than an essay —
  memories over ~600 bytes are never delivered in full, so a long memory is
  closer to no memory.
- A memory offered in truncated form can now actually be loaded. Recall searched
  only the agent's own store, so any offer naming a common-store id answered "no
  match" — an instruction the agent could not follow, failing silently.

### Teams and intents

- `[agent:context clear]` takes an optional continuation body, so a cleared
  session can brief its own next conversation instead of waking up amnesiac.
- `[agent:spawn]` honours a template's env through the reviewer allowlist.
- Exec definitions take a `${TEAM_ROOT}` placeholder, so one definition serves
  every team.

### Fixes

- Typing in a session no longer stalls for ~200 ms when hints are enabled; the
  ranking pass had been running on the keystroke path.
- The draft a hint ranks against now models a line editor, so Ctrl-W, Ctrl-K,
  cursor edits and history recall no longer rank text you had already deleted.
- Operator messages delivered to several sessions were journalled once per
  destination, inflating the index with duplicates; they are collapsed, keeping
  every origin.
- `REGISTRY_DIR` resolves to the app root rather than `CLODEX_HOME` for teams.
- Vendored wirescope v0.6.46.
