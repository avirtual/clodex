# t142 — clear-continuation (hand journal)

Write-ahead. Spec: `tasks/clear-continuation/spec.md`.

## Recon — the three context paths as they stand

| Path | Body | Landed-signal | Guard | Valve | Dedupe |
|---|---|---|---|---|---|
| compact | optional, defaults to `DEFAULT_COMPACT_CONTINUATION` | `onCompactSummary` from the watcher (`_fireCompactContinuation`, sm:1858) | `_armCompactGuard` | `_armCompactValve` (`COMPACT_INFLIGHT_TIMEOUT`) | `isInjectInFlight` on pending/guard/continuation (sm:3655) |
| reload | **mandatory**, rejected before the kill | transcript symlink present (`_injectReloadHandoff`, sm:3726) | none (fresh process) | 30s timeout arg | `session._reloadInFlight` (sm:3592) |
| clear | **none** — `this._injectText(session, cmd, {bypassHold:true})` (sm:3681) | — | — | — | — |

Key sites for this ticket:
- `_handleContextIntent` non-compact arm — sm:3677-3685. The whole current clear.
- `onSessionId` in `create()` — sm:1100-1117. Already has the changed-id edge and
  two consumers hanging off it (`arm.onContextReset`, `memLoad.noteSession`).
- `_fireCompactContinuation` — sm:1858. The shape to mirror for injection:
  delay, `_dead` check, `bypassHold: true`.
- The id itself comes from `JsonlWatcher._poll` (jsonl-watcher.js:88):
  `path.basename(realpath(transcript.jsonl), '.jsonl')`. So "sessionId changed"
  literally means "the symlink now points at a different transcript file".

## The codex question (spec §5) — determined, not assumed

The sessionId edge is NOT a CLI-agnostic signal. It is manufactured entirely by
our own hooks:

- **claude** (`cli-hooks.js` ~:303-321): SessionStart is registered with THREE
  matchers, and the script reads `source` from the hook payload. The CLI re-fires
  SessionStart on a context reset, which is what repoints the symlink.
- **codex** (`setupCodexHook`, cli-hooks.js:355-412): SessionStart registered with
  a SINGLE `matcher: ''` entry, and the script reads only `transcript_path` —
  there is no `source` handling at all. So whether a codex `/clear` repoints the
  link depends on whether codex re-fires SessionStart on `/clear`, which is a
  property of the codex binary, not of our config.

**Binary evidence (codex-cli 0.145.0, aarch64 vendor binary).** The hook input
struct carries `session_id`, `transcript_path`, `hook_event_name`, `source`, and
the `source` enum for SessionStart is literally `startup|resume|clear|compact`
(alongside `sessionStartSource`). So codex DOES re-fire SessionStart on `/clear`,
and our single-`matcher:''` registration will receive it.

That is NOT yet the answer. Our detector is not "SessionStart fired" — it is
"the symlink's realpath CHANGED" (jsonl-watcher.js:75, `target !== _currentTarget`).
If codex's clear re-fires SessionStart with the SAME `transcript_path`, the
symlink repoints to the same file, the watcher sees no change, and `onSessionId`
never fires.

**Empirical answer: the edge DOES fire for codex.** Probe: a real
`codex` (0.145.0) TUI under the real shared `codex-session-hook.sh`, driven by
`WB_WRAP_NAME`, one turn before `/clear` and one after, watching both the
symlink and rollout-file births in `~/.codex/sessions/`:

```
[turn 1] bornFileWithZulu=rollout-...-019fbf15-44e3-...jsonl  link=019fbf15-44e3-...
[clear ] link=019fbf15-44e3-...  (unchanged — the new rollout is minted LAZILY)
[turn 2] bornFileWithYankee=rollout-...-019fbf15-a73e-...jsonl  link=019fbf15-a73e-...
  born: rollout-...-44e3-... zulu=true  yankee=false
  born: rollout-...-a73e-... zulu=false yankee=true
VERDICT: TWO rollouts and the link FOLLOWED -> edge FIRES for codex
```

Two files, cleanly split by the clear, and the symlink followed. So the
continuation is NOT claude-scoped: both CLIs get it, and no `session.type` gate
is needed.

**One timing fact that falls out of the probe and that the design must respect:**
the new rollout is minted LAZILY. Right after `/clear` the link still points at
the OLD file; it only repoints when the next turn actually starts. Combined with
the watcher's 250ms poll, the edge can arrive well after the clear — which is an
argument for a generous valve, not a tight one, and confirms the spec's "do not
use a timer" instruction.

### Probe hazards (three instrument bugs, all mine, all silent)

Recording these because each produced a CONFIDENT WRONG ANSWER, not an error:

1. **`realpathSync` on a dangling symlink THROWS** — the hook links before codex
   creates the rollout, so v1-v3 reported `null` ("no link") for "link exists,
   target not yet created", and I nearly concluded codex never fires the hook.
   `readlinkSync` is the correct probe. This is the same trap
   `_injectReloadHandoff`'s comment already records for `session.sessionId`.
2. **Searching the whole `~/.codex/sessions/` tree false-matched** rollouts from
   February containing "alpha"/"bravo", so v5 "found" both turns in unrelated
   files and printed a verdict built on them. Only files born after probe start
   may be considered.
3. **`p.write('text\r')` does not submit in the codex TUI** — the text piles up
   in the composer (`›replywithonlythewordzulu/clear` on screen). Production
   already knows this: inject-queue.js:143-146 writes the text, settles, THEN
   writes `\r` as its own write. Copying that discipline is what made the probe
   work.

An untrusted `.codex/hooks.json` is also silently ignored: codex gates hooks on a
`trusted_hash` in `~/.codex/config.toml`, so a temp-dir hook never runs and looks
exactly like "codex does not support this hook". Drive the already-trusted shared
hook via `WB_WRAP_NAME` instead of writing a new one.

### Is the edge available WITHOUT a further turn? (the load-bearing question)

Both watchers gate `onSessionId` on `realpathSync` succeeding
(jsonl-watcher.js:74, wire-intents.js:219), which THROWS on a dangling symlink.
So if the new transcript file only materialised on the first user turn, an
edge-fired continuation would never arrive for a SELF-cleared agent — there is no
user turn coming. That would have sunk the spec's mechanism, so I chased it.

Claude probes in a temp dir consistently showed `fileExists=false` even for turns
that visibly completed, and the `~/.claude/projects/<slug>/` dir never appeared —
an artifact of the sandboxed temp cwd, not the mechanism. **Production data
settles it instead**, and is better evidence than any probe:

- Live agents: all 13 `run/*/transcript.jsonl` links resolve to REAL files.
- `sessions.json` carries multi-entry `sessionIds[]` histories
  (`claude-code`: 9, `t2`: 4, `degen`: 3) — the edge demonstrably fires in
  real use, repeatedly.
- Decisive: transcript `e97dfd06` has **5 lines and ZERO user turns** —
  `mode`, `permission-mode`, two `system/local_command`, `last-prompt`. Claude
  writes non-user entries into a fresh conversation immediately.

So the file exists before any user turn, `realpathSync` succeeds, and the edge is
available on a self-fired clear. **The spec's mechanism works as written.**

What DOES hold from the codex probe is the ordering: the hook repoints the link
promptly (`SRC=clear` logged ~2s after the keystroke), but the id only becomes
visible to us on the watcher's next 250ms poll. Late by a beat, not turn-gated.

## Implementation decisions (made before writing, recorded here)

- **Names.** State `session._postClearContinuation`, timer
  `session._postClearValveTimer`, methods `_firePostClearContinuation` /
  `_armPostClearValve` / `_clearPostClearValve`. NOT `_clearValve`:
  `_clearCompactValve` already exists and reads as "clear the compact valve", so
  a `_clearValve` sibling would mean the opposite of what it says.
- **Valve timeout: reuse `COMPACT_INFLIGHT_TIMEOUT` (5 min).** Spec says match
  compact unless justified. Generous is the right direction here (codex mints
  the new rollout lazily, so the edge can be far from the keystroke), and a
  second constant threaded through engine.js + the deps object buys nothing.
- **Continuation injection uses the DEFAULT `_injectText` path, not
  `bypassHold: true`.** The `bypassHold` on the `/clear` command itself exists
  because a bare slash command must not '\n'-join into a flush batch. The
  continuation is prose, and reload's handoff — the same shape, turn-one prose
  into a blank conversation — goes through the normal gates. Keeping the quiet
  gate means it cannot splice into a human's half-typed draft.
- **Delay `COMPACT_CONTINUATION_DELAY` (1500ms), not `RELOAD_CONTINUATION_DELAY`
  (2500ms).** Reload's longer wait pays for a fresh PROCESS booting its input
  loop; here the process never died, only the conversation. Compact is the exact
  analogue.
- **Dedupe drops the second clear whatever its body**, mirroring compact
  exactly. A bare clear arriving while a continuation is in flight is dropped
  too — it cannot happen in today's behaviour (nothing is ever in flight), so
  "bare clear unchanged" still holds, and letting it through would fire the
  first body into the second clear's conversation.
- **Continuation is gated on `sub === 'clear'`,** not on "not compact/reload".
  A future third sub-command routed through this arm must opt in deliberately.
- `bodyMode` for `context clear` moves `none` -> `greedy` in intent-registry.js,
  or a multi-line body would be truncated at the intent line. Two assertions in
  `test/intent-registry.test.js` pin the old value and are updated.

## Progress

- [x] Read spec, docs/sessions.md, docs/messaging.md
- [x] Recon of the three paths
- [x] Codex sessionId-edge determination (empirical) — **it fires; no type gate**
- [x] Implementation DONE. Files touched:
      - `session-manager.js`: `_firePostClearContinuation` / `_armPostClearValve`
        / `_clearPostClearValve` (beside the compact valve pair); clear arm of
        `_handleContextIntent` stores the body + arms the valve + drops a second
        clear while one is armed; fire call added to `onSessionId`'s changed-id
        branch; `_cleanup` clears the timer and the state.
      - `intent-registry.js`: `context clear` bodyMode `none` -> `greedy`.
      - `ipc-prompt.js`: BOTH clear grammar lines (they are the same literal, so
        one `replace_all` edit covered 42 and 118).
      - `docs/messaging.md`: a Clear-continuation paragraph beside the compact
        latch (NOT asked for by the spec — flag as a deviation).
      - `test/intent-registry.test.js`: two pins updated (the bodyMode assertion
        and the legacy allow-set reproduction, which now carries an explicit
        `deliberatelyWidened` term rather than a loosened comparison).
      Spot-run: ipc-prompt + intent-registry + session-manager + intent-scanner
      = 471/471 green.
- [ ] SUPERSEDED plan text kept for reference — session-manager.js:
      `_postClearContinuation` + `_armPostClearValve`; store the body in
      `_handleContextIntent`'s clear arm (sm:3677-3685) with in-flight dedupe
      mirroring compact's `isInjectInFlight` shape + `ipc-message` broadcast +
      `log.warn`; FIRE from `create()`'s `onSessionId` changed-id edge
      (sm:1108, beside `arm.onContextReset`); clear the state in `_cleanup`.
      NO `session.type` gate — the edge fires for both CLIs (determined above).
      Naming: `_postClearContinuation` / `_armPostClearValve` deliberately, NOT
      `_clearValve` — `_clearCompactValve` already exists and means "clear the
      compact valve", so a `_clearValve` would read as its sibling and mean
      something entirely different (spec's naming hazard).
- [x] Tests: NEW FILE `test/clear-continuation.test.js`, 5 tests, all driven
      through a REAL `create()` so the `onSessionId` closure under test is the
      production one (calling `_firePostClearContinuation` directly would stay
      green with the wiring deleted). Mutants run, all RED:
      | # | mutation | result |
      |---|---|---|
      | M1 | delete the fire call in `onSessionId` | 2 fail |
      | M2 | never arm the valve | 2 fail |
      | M3 | remove the in-flight dedupe guard | 1 fail |
      | M4 | bodyMode `clear` back to `none` | 1 fail |
      | M5 | fire without nulling the state (replay) | 1 fail |
      | M6 | continuation injected WITH `bypassHold` | 2 fail |
      | M7 | drop the `.trim()` (whitespace body arms) | 1 fail |
- [x] ipc-prompt.js grammar — both occurrences are the SAME literal, so one
      `replace_all` edit covered 42 and 118. `test/ipc-prompt.test.js` needed no
      change: its pins are `buildIpcPrompt(...) === IPC_PROMPT` self-consistency
      pins, not a copy of the text, so they re-derived and stayed green. Nothing
      weakened; nothing else in the repo carries the old line (grepped).
- [x] Full suite via clodex-test-green: **3385/3385 green** (3380 + the 5 new).
