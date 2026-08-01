# t138 — automatic contextual hint arming

Rewritten 2026-08-01. The previous spec assumed semantic matching cost 3-9s
and sized a debounce around that. Measured on this machine the same day:
lexical in-process **0.14ms/query** (6ms index build over 178 units), local
Ollama embed **16ms warm**. That inverts the trigger design — see "Why arm
while typing".

## What already exists (do not rebuild)

- `scripts/hint-probe.js` — the loop proven end to end today: rank memory
  units against a draft, compose a hint, POST it to wirescope, watch it pop
  exactly once. Its `unitsAsRecords` / `haystack` / `score` / `rank` /
  `compose` are the reference implementation. **Lift the ranking and
  composition; leave the CLI and the `--semantic` LLM pass behind.**
- `memory-load.js` (t137, landed) — `stateOf(agent, id)` returns
  `FULL | TITLE | ABSENT`. This is the "already in context" answer.
- `proxy-util.js:171` `draftChunkSignal(chunk, inPaste)` → `{closes, inPaste}`.
- `session-manager.js:1245` `write(name, data)` — already calls
  `isHumanPtyInput(data)` and `draftChunkSignal`, already tracks
  `s.lastUserSubmitTs`. It does **not** accumulate draft text. That is the
  one missing piece at the seam.

## Deliverable

`hint-arm.js` — a new pure-leaf module (electron-free, deps injected),
plus its wiring into `session-manager.js` `write()`, plus tests.

### 1. Draft accumulation (in `write()`)

Maintain `s._draft` alongside the existing paste-state tracking:

- Append printable bytes from human input.
- Handle backspace (`\x7f`, `\b`) by truncating.
- `\x03` (Ctrl-C) or `\x15` (Ctrl-U) clears the draft **and** disarms
  (see 5).
- On `closes` (Enter): the draft is final — do one last arm pass, then reset
  `s._draft` to empty.
- Cap the accumulator (4KB). A pasted wall of text is not a question; past
  the cap, stop accumulating and do not arm.

Only human input feeds this. Injected text (`_deliverMessage`, ticket
delivery, nudges) must never reach the accumulator — reuse the existing
`isHumanPtyInput` gate, do not invent a second one.

### 2. Why arm while typing, not on Enter

The naive trigger is Enter. It has a race: the CLI builds and sends the
request within tens of milliseconds of the keystroke, and a hint that lands
after the request has left is a hint for the *next* turn — armed off the
wrong question, and it will pop there.

At 0.14ms/query the race is avoidable rather than manageable. Arm
**continuously as the draft grows**, so by the time Enter is pressed the hint
is already registered. Enter's pass is a correction, not the first attempt.

Debounce: **120ms of typing idle**, plus a hard floor of 3 non-stop-word
terms in the draft. Re-arm only when the ranked result set *changes* — a
draft that grows without changing the winner must not re-POST.

The 120ms figure exists to bound POST volume, not compute. If the embed tier
lands later (16ms warm), it fits inside this same debounce unchanged; that is
why the number is where it is.

### 3. Retriever interface (the part that must not be memory-specific)

```
retrieve(draft, { agent, limit }) -> [{ id, text, tags, scope, source, confidence, evidence }]
```

Ship exactly one retriever in this ticket: `memory` (lexical, lifted from
hint-probe). Project facts, docs and a local-embed tier are separate tickets
and must slot in behind this interface without touching `hint-arm.js`.

Scores from different retrievers are **not comparable** (lexical IDF gave
8.90 on the real corpus; cosine gives 0.82). `confidence` must be normalised
into a documented 0-1 band by each retriever. Until a second retriever
exists, do not build a merge — rank within the single source.

`MIN_SCORE` in hint-probe is 2, tuned against a 4-doc corpus. IDF weights are
corpus-size dependent (`log(1+N/df)`: df=1 gives 1.61 at N=4 and 5.19 at
N=178), so **re-derive the floor against the real store** and record the
number you picked and why in the JOURNAL. Do not copy the 2 across.

### 4. Suppression — two independent ledgers

These are different questions and must not share state.

**(a) Already in context** — `memory-load.js` `stateOf()`:
- `FULL` → suppress. The body is already there.
- `TITLE` → **do not suppress**. The model knows the unit exists and cannot
  read it; this is the single best hint case.
- `ABSENT` → offer.

Failure is asymmetric and the defaults must lean one way: a false ABSENT
costs a few hundred redundant tail tokens; a false FULL silently withholds
something the model needed and nothing in any log shows it happened. When
the state is unknown or the lookup throws, **treat it as ABSENT**.

**(b) Already offered** — a new in-memory ledger, per (agent, unit id):
- Record on successful POST, not on rank.
- Cooldown: do not re-offer the same id to the same agent within 10 minutes
  **or** until the agent's context is cleared/compacted, whichever comes
  first. t137's compact/clear signals already exist; reuse them.
- t137 deliberately does not record ephemeral hints as *loaded*. Keep that —
  an offer is not a load, and conflating them makes (a) start lying.

### 5. Disarm

If the draft is cleared without submitting (Ctrl-C / Ctrl-U), DELETE the
registered hint rather than letting it ride to TTL. An armed hint from an
abandoned draft pops on whatever the user types next.

### 6. Arming call

`mode: merge`, fixed hint id `memory-context` so a re-arm overwrites rather
than accumulates. `ttl_s: 180`, `turn_start_only: true`, and:

> `once` is the one-shot field. The server accepts unknown keys, drops them
> silently and returns 200 — posting `pop: true` registers a **standing**
> hint whose logs are indistinguishable from a pop. Cost me a false green
> today.

Any test that asserts one-shot behaviour must read the stored record back and
assert `once === true`. A 200 plus a registry echo is not evidence.

Route: `clodex-<agent>-*` (the hash suffix is unknowable before the agent's
first request).

Wirescope must be **optional**: a POST failure or an unreachable proxy is
logged at debug and swallowed. Hint arming may never affect whether the
user's keystroke reaches the PTY. Do the arm off the write path (fire and
forget); `write()` must not await it.

### 7. Feature gate

Off by default this cut, behind a single flag. Name it and note where it
lives in the JOURNAL. Nobody but me should get armed hints until the live
loop has run for a day.

## Tests

- Draft accumulation: printable, backspace, paste-bracket, Ctrl-C, Ctrl-U,
  4KB cap, Enter reset.
- Injected (non-human) writes never reach the accumulator.
- Debounce: N keystrokes inside the window produce one POST; a draft whose
  winner does not change produces no second POST.
- Suppression matrix: FULL suppresses, TITLE does not, ABSENT does not,
  lookup-throws does not.
- Cooldown: second offer inside 10min suppressed; after a compact signal, not
  suppressed.
- Disarm on Ctrl-C issues a delete.
- Proxy down → no throw, keystroke still delivered.
- One-shot: read back `once === true` from the stored record.

Suite must be green: `[agent:exec clodex-run-tests]`. Baseline 3279.

## Journal

Write to `tasks/hint-injector/JOURNAL.md` **as you go**, not at the end.
Record at minimum: the MIN_SCORE you derived and the corpus you derived it
against, the flag name and location, and anything in the seam that did not
match this spec.

## Standing constraints

- Do not commit, tag or push. Leave the tree dirty for me to review.
- No secret values in argv, logs, markers or errors. No emojis.
- New extractions go in `test/free-identifier-leaks.test.js` SCANNED_MODULES.
- Comments earn their place by naming a wrong change they prevent
  (`.claude/CLAUDE.md` "Comments").
- Flag deviations and assumptions in your report — I read those first.
