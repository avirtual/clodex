# clear-continuation — give `[agent:context clear]` a handoff, like compact and reload have

Author: clodex (lead). Status: SPEC, not started.
Journal your work into `journal.md` beside this file as you go.

## The gap

`[agent:context clear]` injects BARE. `session-manager.js` `_handleContextIntent`,
the non-compact arm:

    this._injectText(session, cmd, { bypassHold: true });

No continuation, no guard, no latch, no valve. The two sibling paths both solve
this and neither shares code with clear:

- **compact** — `_executeCompact` sets `session._compactContinuation`, arms
  `sentinel.armCompact(...)`, plus `_armCompactGuard` and `_armCompactValve`.
  Default body `DEFAULT_COMPACT_CONTINUATION` when the agent passes none.
- **reload** — handoff body is MANDATORY (rejected before anything is killed),
  carried across kill→create in a closure, injected by `_injectReloadHandoff`
  once the fresh CLI signals boot.

Clear is as amnesiac as reload — it drops the whole conversation — and is the
only one of the three that tells its next self nothing. This session is the
live proof: a `/clear` this afternoon lost a pending prompt delta and the
operator had to re-explain the thread by hand.

## What to build

`[agent:context clear] <body>` — the body is injected as turn-one in the fresh
conversation, exactly as compact's continuation is.

**Clodex NEVER writes the agent's summary file.** Operator ruling, and it is
the load-bearing constraint of this design: the AGENT writes whatever file it
wants with its own tools, and Clodex only carries the text it was handed. If
that text contains `@/abs/path.md`, Claude attaches the file itself — that is
the "reading" half, and it needs no code. Do not add file-writing, a default
handoff path, or `--add-dir` plumbing. (A default path under `~/.clodex/` was
discussed and is explicitly OUT of scope here; it interacts with path
confinement and is a separate decision.)

### 1. Fire the continuation on the right signal

The clear-landed detector already exists and is documented in `create()`'s
`onSessionId`:

    // A CHANGED id is /clear — whatever was offered is no longer in front of
    // the model ...
    if (priorSid && sessionId && priorSid !== sessionId) { arm.onContextReset(name); }

A CHANGED sessionId is the ONLY reliable "the clear actually landed" signal:
`/clear` mints a new conversation id and the transcript symlink repoints;
`/compact` is in-place and keeps the same id. Fire the continuation from this
edge. Do not invent a timer-based "probably done by now" — that is the failure
mode this detector exists to avoid.

Note the latency you are working with: JsonlWatcher polls the symlink every
250ms, so the edge arrives up to ~250ms late, and the new conversation may not
be ready for input the instant the id changes. `_injectReloadHandoff`'s
readiness discipline is the precedent to copy (probe, settle, then inject) —
read its comment block before writing this, it records two live bugs.

### 2. Valve — a continuation that never fires must expire

If the clear never lands (CLI busy, user cancels, injection swallowed), a
stored continuation sits forever and will fire on the NEXT sessionId change —
which may be an operator's manual `/clear` minutes later, injecting a stale
briefing into an unrelated conversation. That is worse than losing it.

Mirror `_armCompactValve`: drop the stored continuation after a timeout, log a
warning naming what was dropped. Match the compact valve's timeout unless you
can justify a different one in the journal.

### 3. In-flight dedupe

Two clears in flight must not stack. `compact` drops the second with an
`ipc-message` broadcast and a `log.warn`; do the same rather than a new shape.

### 4. Grammar

`ipc-prompt.js` has the clear line in **TWO** places — line ~42 and line ~118.
Both must change or the two byte-pinned prompt variants disagree. Document the
optional body the way the compact line does.

### 5. Codex

`CONTEXT_COMMANDS` covers codex too. **Determine, do not assume**, whether a
codex `/clear` produces the same sessionId-change edge. If it does not, scope
the continuation to claude and leave codex's clear exactly as it is today —
degrading to current behaviour is correct; injecting on a signal that never
arrives, or that means something else, is not. Report what you found either
way; this is the one place I expect a real finding.

## Constraints

- Read `docs/sessions.md` and `docs/messaging.md` BEFORE editing (CLAUDE.md
  requires the matching subsystem doc for the subsystem you touch).
- `test/free-identifier-leaks.test.js` gates extractions in both directions. If
  you move anything between modules, update SCANNED_MODULES.
- `test/ipc-prompt.test.js` BYTE-PINS the prompt. Changing the grammar line
  breaks the pins by design — update them, and do not weaken an assertion to
  make it pass.
- Naming hazard: `_clearCompactValve` already exists and means "clear the
  compact valve". A new `_clearValve` would read as its sibling and mean
  something entirely different. Prefer `_postClearContinuation` /
  `_armPostClearValve` or similar; say what you chose and why.
- Comment policy (CLAUDE.md): a comment earns its place only by naming a wrong
  change it prevents. The valve and the sessionId-edge choice both deserve one.
  Nothing else here does.

## Done means

- `npm test` green, full suite (currently 3380 passing — do not leave it lower).
- New tests covering: continuation fires after clear; NO continuation when the
  agent passed no body (bare clear must behave exactly as today); the valve
  drops a stranded continuation; second clear while one is in flight is
  dropped.
- Report: what you changed, the codex finding, anything you deviated on.

## Explicitly NOT in scope

- A default handoff path / `~/.clodex/handoff/` (operator decision pending).
- Making the body mandatory the way reload's is. Bare `[agent:context clear]`
  must keep working unchanged — existing seats use it.
- `[agent:memory remember]` not promoting to `full` (separate open item).
