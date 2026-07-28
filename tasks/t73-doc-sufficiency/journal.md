# t79 — make docs/plugin-api.md sufficient to build a working plugin cold

Branch: `t79-doc-sufficiency` off master `ac6c05e`.
Deliverable is **docs/plugin-api.md**, not a plugin. Do not build or improve a
plugin.

## Ticket in one line

A clean-room trial (docs only, no repo context) produced a valid 979-line plugin
with two INTEGRATION defects — both host-boundary contracts the doc never
states. Two known defects are the SAMPLE; the job is to find the SET.

## Method (clodex's order, not mine to reorder)

- **A. Trace both at source first.** Document what the code DOES, not what it
  should do. clodex's expectation for inject-with-newlines is early submit /
  fragmentation, but they marked it INFERRED AND UNVERIFIED — if the code says
  otherwise, the code wins and I say so.
- **B. Sweep** for every host-enforced runtime contract a doc-only author can
  violate silently: value shapes, size/length caps, sync-vs-async, ordering /
  lifecycle, anything the host rejects, truncates or mangles without a clear
  error.
- **C. Patch** docs/plugin-api.md. Each contract: name it, state the exact rule,
  state the CONSEQUENCE of violating it. A rule with no consequence gets ignored
  by a reader under time pressure.

## Report must contain

Contract inventory, each entry VERIFIED-AT-SOURCE with file:line; anything I
could NOT verify said plainly rather than filled in; and separately flagged —
any place the doc is already WRONG, not merely incomplete.

## Log

### Phase A — tracing (in progress)

#### A1. inject() + newlines — clodex's expectation is PARTLY WRONG. Code wins.

clodex inferred "early submit / message fragmentation". That WAS the behaviour
and it is now **conditionally mitigated**. Verified at source:

- `inject-queue.js:255` — `let out = text.replace(/\n/g, '\r')`. Every `\n`
  becomes `\r`, i.e. an ENTER key event. This is the hazard clodex described.
- `inject-queue.js:256-260` — **but** if `text.includes('\n')` AND
  `bracketedPaste()` is live-true, the payload is wrapped in
  `PASTE_START`/`PASTE_END` (mode 2004 `200~`/`201~`). Inside a paste region an
  interior `\r` is literal content regardless of how node-pty splits the write,
  "exactly like a real terminal paste". The deferred Enter at `:264` still
  submits.
- The comment at `:244-247` records the original live observation: "a dm body +
  reply trailer arrived as two user turns in a box session".
- `session-manager.js:5905` — `bracketedPaste: () => !!session._pasteModeOn`,
  read LIVE at each write (comment `:5902-5904`: the CLI toggles 2004 around
  dialogs and teardown).
- `session-manager.js:1667-1668` — `_pasteModeOn` is sniffed from the CLI's own
  output via `pasteModeSignal` on `\x1b[?2004`.

So the honest contract is conditional, and the residual-risk branch is the one
a plugin author must be told about: **when mode 2004 is OFF, multi-line text
still fragments** (`:253-254` — mode off ⇒ old bare bytes, because a wrap the
CLI doesn't understand would land the markers literally). Sessions that never
emit 2004 (bash, a CLI build that doesn't announce it) therefore keep the old
behaviour.

STILL TO VERIFY before I write this into the doc: whether bash/codex seats
ever set `_pasteModeOn`, i.e. how wide the unprotected branch actually is.
Do not document the mitigation as unconditional.

#### A2. Length — a THRESHOLD, not a cap (no truncation found yet)

`session-manager.js:5897` — `settleMsFor: (t) => (t.length > LONG_TEXT_THRESHOLD
? LONG_TEXT_DELAY : SHORT_TEXT_DELAY)`. Length only selects the settle delay
before Enter. No truncation at this seam. The trial's 7000-char payload is not
cut here — but I have NOT yet checked for a cap further up (the plugin-facing
`inject` wrapper) or further down (pty write). Not yet answered.

### NEXT (phase A continued)

1. `_pasteModeOn` for bash/codex — how wide is the unprotected branch.
2. The plugin-facing `inject` wrapper: find where the SessionHandle's inject is
   built, check for length caps / validation / sync-vs-async.
3. A2's open question: any size cap anywhere on the path.
4. Then the intent BODY FIELD NAME (defect 2), still untraced.
