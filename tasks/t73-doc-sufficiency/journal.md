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

### A3. `_pasteModeOn` width — the unprotected branch is WIDE. Verified.

`session-manager.js:1667-1668` is the ONLY writer:
`if (data.includes('\x1b[?2004')) session._pasteModeOn = pasteModeSignal(...)`.
It is inside the PTY data handler and fires for ANY session type, but it is
driven entirely by whether the CLI on the other end EMITS mode 2004.

- Claude announces 2004 (the boot-readiness latch at `:1674` depends on it).
- A plain **bash** session runs a shell, which does not announce 2004 unless
  something inside it does → `_pasteModeOn` stays falsy → **no paste wrap**.
- **Codex** is not verified either way by me. I did not find a source fact
  establishing whether its TUI emits 2004. NOT filling this in.

`:5940` `bracketedPaste: () => !!session._pasteModeOn` — undefined coerces to
false, so the DEFAULT for any session that never emitted 2004 is unwrapped.

**clodex's framing is the right one and I am adopting it verbatim: a plugin
author cannot observe which mode is live, so from their side the constraint is
UNCONDITIONAL even though the mechanism is not.** The doc must state both
branches and the condition that selects them, and must not present the
mitigation as protection the author can rely on.

### A4. Plugin-facing `inject` — NO cap, NO validation, fire-and-forget

`plugin-host-engine.js:202-206`:
```js
inject(text, opts = {}) {
  const cur = manager.sessions.get(name);
  if (!cur) return;
  manager._injectText(cur, String(text), { parkable: opts.parkable !== false });
}
```
- `String(text)` — a non-string is COERCED, not rejected. `inject(null)` writes
  the four characters `null` into the agent's prompt. No throw, no log.
- No length check at this seam.
- Returns `undefined`, always. **It is fire-and-forget: a plugin cannot learn
  whether the text was written, queued, parked, or dropped.** Not async, so
  there is nothing to await either.
- A dead session is a silent no-op (`if (!cur) return`, plus `_injectText`'s own
  `if (session._dead) return` at `:5857`).

`_injectText` (`session-manager.js:5856-5885`) adds a HOLD layer the doc never
mentions: `_injectHoldReason` (`:2650-2655`) queues the text instead of writing
when the session is compacting, dialog-blocked, or mid-turn, and the batch
flushes later as ONE concatenated turn joined with `\n` (`:2750`). So a
plugin's inject may arrive merged with other injects — and that concatenation
reintroduces newlines into text that had none.

### A5. Size caps on the path — ANSWERED: none that truncates

Traced end to end. No truncation of inject text at any seam:
- plugin wrapper: none (A4).
- `_injectText` / InjectQueue: none; `settleMsFor` uses length only to pick a
  delay (`:5932`).
- The 2MB `pendingOutput` cap is DETACHED-WINDOW OUTPUT buffering, not input.
- The >500-byte spill in `_deliverMessage` is the DM path, not `inject`.
So the trial's 7000-char payload is not cut. The hazard there was never size —
it was the newlines inside it.

### A6. Intent BODY FIELD NAME — it is `body`. Verified, and the real rule is
### stronger than "the name is body".

`session-manager.js:2905-2955` `_extractIntents` assigns `intent.body` in both
capture modes (`:2921` json, `:2953` greedy). `intent-registry.js:271-292` shows
every core row using `body`, and the plugin wrapper at `:365-372` does
`return { ...out, type }` — it spreads THE PLUGIN'S OWN parse output.

**So the host does not hand the plugin a body under a name the plugin must
guess. The host WRITES `body` onto the object the plugin's own `parse` returned.**
The trial probing four plausible names was solving the wrong problem: the field
is `body` because the host sets `.body`, and a plugin's parse must simply not
occupy that property with something else.

Two more registration facts a doc-only author cannot guess, both enforced by
throw at `intent-registry.js:340-362`:
- `bodyMode` MUST be a function of the parsed intent, never a string (`:358`)
  — a string throws with an explicit message.
- Returns other than `'greedy'`/`'json'` are coerced to `'none'` (`:377`), and a
  parse that THROWS is swallowed to `null` (`:369`) — a buggy parse silently
  never fires rather than erroring.

### PHASE A COMPLETE. Next: phase B sweep, then phase C doc patch.
