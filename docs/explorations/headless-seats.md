# Design: stream seats — `claude -p` over stdio as the transport behind the transcript pane

Ticket t1145 · base master c04c1037 · 2026-09-24 · design only, no code.

Read `pane-app-view.md` first. That document designs the viewport. This one
designs what feeds it once the CLI no longer draws to a terminal.

**Naming.** The brief says "headless seat". This document says **stream
seat**, and the module names below use `stream-`. "Headless" already names
something in this repo: `headless-main.js` is the Electron-free host of the
engine, and `headless-restart.js` is its relaunch path. A `HeadlessSeat` class
beside `createHeadlessRestart` would make every grep ambiguous, and the two are
unrelated.

## Verdict (section 0, the gate Bogdan set)

**Possible, with five traps, and with one gate that only a measurement can
clear.**

- **The context model does not change.** A `claude -p` process persists an
  ordinary transcript at `<config>/projects/<slug>/<session_id>.jsonl`. It has
  the same record shapes the pane parser already reads, and the same `uuid`s
  the stream carries. Restart can therefore stay what it is today: the CLI owns
  the context on disk, and Clodex respawns with `--resume`. This is verified
  from the probe's own leftover files (§0.1).
- **The gate is that nobody has run `claude -p --resume` in stream-json mode.**
  The probe never crossed a process boundary. If `-p --resume <id>` does not
  continue the conversation, that is a hard blocker. It is expected to work,
  because it is the Agent SDK's resume path, but it is not verified. Measurement
  M1 settles it.
- **The traps are all Clodex-side and all fixable:**
  1. A process on a pipe gets no SIGHUP when Clodex crashes, so an orphan can
     keep writing the transcript that the relaunched Clodex resumes.
  2. The session id exists only in `system/init`, and init arrives only after
     the first input.
  3. `/clear`'s `new_conversation_id` is not the new session id.
  4. `-p` transcripts contain no `turn_duration` records.
  5. The respawn triggers that are about the process must stay respawns.

  The quit and restore paths need a pid record and a reap-before-resume step.
  Nothing in the CLI blocks them.

**MEASURE list: 20 probes** (§0.5), handed to wirescope as H0.

---

## 0. Restart semantics

### 0.1 What is settled already, from evidence

These facts come from the probe README and from the transcripts its runs left
in `~/.claude/projects/`. I read those transcripts for this design. Every
probe run used a temp cwd matching `-private-var-folders-…-T-sc-*`.

| # | fact | evidence |
|---|---|---|
| S1 | `-p` persists a normal transcript. The file for run A is `…-T-sc-3uabcoxt/baf5b800-c92f-445b-a6b9-fe16df4bdcb2.jsonl`, matching the `session_id` in that run's init. Its records carry `entrypoint: "sdk-cli"`, and prompts carry `promptSource: "sdk"`. | `find ~/.claude/projects -name 'baf5b800*'`; the 27 `sdk-cli` files under the probe's `-T-sc-*` dirs |
| S2 | **Stream `uuid`s are transcript `uuid`s.** In run B2 (`B-compact-after-turn-and-model-switch.jsonl`), all 4 `assistant` uuids and both `user` uuids on stdout are present in `7a630e03….jsonl`. `result` uuids and most `system` uuids are not. | This design's cross-check of that run against that file |
| S3 | `/compact` keeps the session id. In B2, `7a630e03` holds before, across and after the compact. A fresh `system/init` is emitted just before `compact_boundary`. | runs/B-compact-after-turn-and-model-switch.jsonl, t=14.924 |
| S4 | **`/clear` changes the session id, and `new_conversation_id` is not the new id.** In B-clear the pre-clear id is `e11490b6`. `conversation_reset.new_conversation_id` is `f4e5ec04`. The next `init.session_id` is `07a324bc`. Only `07a324bc` exists on disk: there is no `e11490b6` file (that session was empty) and no `f4e5ec04` file. | runs/B-clear.jsonl; `find` for each id. One run, and its pre-clear session was empty. M6 repeats it with a non-empty one. |
| S5 | **There is no session id before the first input.** In run A the first user message went in at t=0.002 and the first init came out at t=0.648. Init is re-emitted before every turn (README, case A). | runs/A-baseline.jsonl; README row "A baseline" |
| S6 | **`-p` transcripts have no `system/turn_duration`.** The 27 `sdk-cli` files hold 0 of them, while this repo's TTY transcripts hold 7,003. Turns end with an `assistant` record whose `stop_reason` is `end_turn` (71 of them) or `tool_use` (37). | `grep -o '"subtype":"…"'` across both sets |
| S7 | A stream `user` tool result carries `tool_use_result` (snake case), the same side-car the transcript calls `toolUseResult`, **including `originalFile`**. | runs/D-permission-stdio-write.jsonl, `user` keys |
| S8 | `result` carries `duration_ms`, `num_turns`, `total_cost_usd` (cumulative per process), `usage`, `modelUsage`, `permission_denials`, `queued_turn_count`, `terminal_reason` and `stop_reason`. | runs/D-permission-stdio-write.jsonl, `result` keys |
| S9 | When stdin closes on an idle process, it exits with 0 about 1 s later. No run hung. | README, "No run hung…" |
| S10 | Input is accepted before init. The first message was written 2 ms after spawn and was answered. | runs/A-baseline.jsonl |
| S11 | Workspace trust does not block `-p`. Every run started in a fresh, never-trusted temp dir. | README header, "fresh empty temp cwd" |

### 0.2 (a) Clodex relaunch: `[agent:reboot]`, upgrade, crash

What today relies on, by path:

- **Quit.** `killAll()` in session-manager.js stamps `_shuttingDown`, reaps
  each pty's descendants from a `ps` snapshot (`reapFromSnapshot`) and calls
  `s.pty.kill()`.
- **Crash.** The kernel closes the pty master, and the CLI gets SIGHUP.
- **Boot.** `app:restore-sessions` calls `create()` with `--resume
  <sessionId>` from sessions.json, and the CLI reloads its own transcript.

| question | answer for a stream seat | status |
|---|---|---|
| Does `-p --resume <id>` in stream-json mode continue a session that an earlier `-p` process created? | Expected yes: it is the SDK's resume path, and S1 shows the file it would read is an ordinary transcript. | **MEASURE M1**. This is the gate. |
| Does resume keep `<id>`, or mint a new id and copy the history? | Unknown. Some SDK builds have minted a new id on resume. **The design does not depend on the answer**: the persisted `sessionId` is always taken from the latest `init.session_id` (§0.4). | **MEASURE M1** |
| Is the id `init.session_id`, and is it stable? | Yes. It is stable across turns and across `/compact` (S3), and it changes on `/clear` (S4). | settled |
| Does a resumed process re-emit history on stdout? | Unknown. **The pane does not care**: on boot it renders from the transcript parser (`transcript-records.js` `recordsOf`), exactly as it does today. Stream events are only a live overlay (§4). If history is re-emitted, the stream decoder must drop events that come before the first `init` following our first send. | **MEASURE M3** |
| What does the pane render from on boot? | The transcript parser. It stays the restore path and the source of truth (§4). | design choice |
| Does `--fork-session` work with `-p`? | Unknown. Fork is used by `create(…, fork=true)`. | **MEASURE M4** |
| What happens to a tool call that is mid-flight when the process dies? | A PTY seat that is killed mid-tool also leaves a `tool_use` with no `tool_result`. `docs/notes/scratch-mark.md` records that on resume the CLI re-parents such an orphan and fabricates a reply (for cut spans, 2.1.278). Whether `-p` resume does the same, or re-runs the tool, is unknown. | **MEASURE M7, M8** |
| What happens to a permission request that is pending at death? | It is the same case as the one above: the `tool_use` is in the transcript, and the answer lived only in the dead process. Clodex holds pending permission rows in memory only. On restore it posts one `notice` row: "a permission request for Write(x) was lost when the seat restarted; the call did not run". It never re-asks on its own. | design choice; M10 checks the transcript shape |
| Is a resumed `-p` process at a clean turn boundary? | It waits for stdin (S5 implies that no turn starts without input). Unlike a PTY seat, there is no prompt to "come back at": the process simply waits. | settled for fresh processes; **M3** for resumed ones |

**Trap R1: orphans and two writers.** This is the one that matters.

- A pty child dies with Clodex because the kernel sends it SIGHUP. **A pipe
  child gets no signal.** When Clodex crashes, the child sees EOF on stdin, and
  later EPIPE when it writes to stdout.
- S9 shows an idle process exits about 1 s after EOF. It does not show what a
  process does **mid-turn**: it may finish the turn first, running tools for
  minutes and appending to the transcript while nobody reads its stdout.
- Meanwhile the relaunched Clodex runs `--resume <same id>`. Two processes then
  append to one transcript, and each holds a different in-memory conversation.
- The existing reaper cannot help. `reapFromSnapshot` refuses any process whose
  parent is not this Clodex (`ptyOwnership` returns `'foreign'`). An orphan's
  parent is launchd (pid 1), so it would be refused by design.

**Fix, which is design and needs no measurement:**

1. Record the child's identity in `run/<name>/agent.json`, beside the existing
   pid, as `cli: { pid, startedAt, sessionId }`. `startedAt` is the process
   start time from `ps -o lstart`.
2. Before any `create()` that resumes, check the recorded pid. It is ours if it
   is alive, its start time matches, and its argv contains the session id we are
   about to resume. If so, SIGTERM it, wait up to 5 s, then SIGKILL, and only
   then spawn.
3. A pid whose start time does not match has been recycled. Leave it alone and
   log that. This is the same stale-registration problem that the
   `isStaleRegistration` comment in `create()` already describes for
   `agent.json`.

M9 measures how long an orphan actually survives. The fix is needed whatever it
finds, because even 1 s overlaps a fast restore.

The graceful paths (quit, archive, reboot) do not hit R1:

- `killAll()` signals every child directly.
- For stream seats it closes stdin first (S9: a clean exit about 1 s later when
  idle), then sends SIGTERM, then SIGKILL after 5 s. That is the same fallback
  `kill()` uses today.
- M8 measures what SIGTERM mid-turn does to the transcript tail.

### 0.3 (b) Seat restarts: which remain respawns

Today there are six kill-and-respawn paths for one seat (docs/sessions.md §3,
§3a, §4). Under stream-json, `/compact` and `/clear` run inside the process
(S3, S4, README rows B2 `/compact` and B `/clear`).

| trigger | today | stream seat | why |
|---|---|---|---|
| `[agent:context compact]` (and its continuation) | latch on the wire terminal stop, type `/compact`, then inject the continuation at the compact edge | **in-process.** Send the user text `/compact` when the seat is idle (§2). `compact_boundary` followed by `result` is the edge. The continuation is the next user message. | S3. `_compactRegen` stays a respawn (row below). |
| `_compactRegen`, `_promptDeltaPending` at clear (prompt regenerated) | `_coldRespawn` | **stays a respawn** unless M17 proves otherwise | `--append-system-prompt-file` is read at spawn. The bundle's `set_model` accepts an optional `system_prompt` (README, "Request shapes"). If M17 shows it replaces the append channel in-process, both regen arms become a control request. Nothing is designed on that until it is measured. |
| `[agent:context clear]` (plain arm) | type `/clear`; the continuation fires on the sessionId-change edge from the symlink repoint | **in-process.** Send `/clear`. The edge is the next `init` whose `session_id` differs from the current one, not `conversation_reset` (S4: that event names a different id). The continuation is the next user message. | S4 |
| `[agent:context reload]` | `_coldRespawn` without `--resume` | **respawn**, fresh `--session-id` | a new process is the point |
| Move Session… (cwd) | `_moving`, kill, `_waitForExit`, `create()` with `--resume` | **respawn**, the same shape | The bundle has a `set_cwd` control (README, "Request shapes"), but the transcript slug is derived from the cwd, and the move-to-peer notes show a resumed conversation keeps writing under its original slug. An in-process cwd change would make the transcript path ambiguous. Not worth it. |
| Move to peer | quiesce, ship, far `create()` with `mint=false` | **respawn on the far box**, the same shape | necessarily |
| scratch cut / rewind | `_moving`, kill, wait, rewrite the transcript, `create()` on the same id | **respawn**, the same shape | The process holds the conversation in memory. A file rewritten under a live process changes nothing it remembers, and the process would keep appending past the cut. The existing "wait for exit" is the guard, and it must wait for the child's `close` event, not `exit` (§1.4). |
| account move, args edit plus restart, `restartSession` | kill plus `create()` | **respawn** | unchanged |

**What the handoff injection becomes.** It becomes a user message written to
stdin right after spawn. S10 shows the CLI accepts input before init, so these
all go away for stream seats:

- the boot-ready gate (`_bootReadySeen`, the mode-2004 edge);
- `BOOT_DRAIN_SETTLE_MS`;
- the boot nudge (`_armBootNudge`, a lone `\r`);
- `RELOAD_CONTINUATION_DELAY`.

`_handoffText` and `_resumeSnapshot` are unchanged. They produce text, and the
text is simply sent. One property is still owed: the message must be written
**after** the process exists and **before** anything else in the outbox. The
outbox (§2) is created in `create()`, and the handoff is enqueued first.

### 0.4 The other traps the gate asked about

| trap | answer | status |
|---|---|---|
| **Session-id freshness** if the id only appears in init | It is better than today. Every turn re-emits init (S5), so `onSessionId` runs on every init whose id differs. There are two consequences. (1) A fresh seat has no id until its first turn (S5). Pass `--session-id <uuid>`, minted by Clodex and persisted before spawn, so sessions.json never holds `null` for a live seat. (2) After `/clear` the change arrives with the next turn's init, not at `conversation_reset` (S4). The post-clear continuation fires when that init arrives. The continuation is itself the input that produces the init, so it is sent on `conversation_reset` and **confirmed** by the init. | S4, S5; **MEASURE M2** (`--session-id` with stream-json input) |
| **The transcript symlink** when there is no PTY | Today the SessionStart hook writes `run/<name>/transcript.jsonl` (cli-hooks.js, `hook.sh`). If SessionStart fires under `-p`, with source `startup`, `resume` and `clear`, keep it as the **sole** writer and change nothing, including the byte-pinned hook bodies. If it does not fire, Clodex becomes the sole writer on every init id change: it resolves `<config>/projects/*/<id>.jsonl` by glob (ids are uuids) and repoints the link atomically. **There must never be two writers.** A hook and Clodex racing one symlink is the failure this rule exists to prevent. | **MEASURE M12** |
| **A `-p` process writing the transcript while Clodex rewrites it** (scratch) | This happens only if the cut runs before the process is dead. The existing order (`_moving`, kill, wait, cut, `create`) already prevents it. The one new trap is that the wait must be for the pipe child's `close` event (§1.4), and trap R1 must be closed before the `create`. | design |
| **Two processes on one session id** because a restore races a still-exiting process | This is trap R1 in its local form: `restartSession` or a Move whose old child has not exited. `_waitForExit` already gates the local paths. The boot path gets the pid-record reap in §0.2. | design; **M11** measures what actually happens with two writers, so the risk is known and not assumed |
| **wirescope (`--base-url` / `ANTHROPIC_BASE_URL`) must still ride** | It rides the `--settings` `env` block in `hook.json`, which is independent of the TTY. The probe stripped every `ANTHROPIC*` variable, so this path was never exercised under `-p`. For a stream seat the wire tee is **no longer the intent source** (§1.3). It stays for ctx, warmth and cost telemetry. | **MEASURE M18** |
| **Anything relying on the PTY exit code or on `_cleanup` ordering** | `exitDisposition` reads flags (`_userKilled`, `_shuttingDown`, `_archived`, `_moving`), not exit codes, so it ports unchanged. The fixed exit order (mark `_dead`, `_sendToSession('session-exit')`, remote notify, persistence, `_cleanup`) must run from the child's `close` event. `exit` can fire while stdout still holds the final `result`, and processing that result after `_cleanup` would touch a session that is no longer in the map. | design |
| **A `-p` transcript has no `turn_duration`** (S6) | Two consumers read it (`grep turn_duration *.js`). `scratch-mark.js` `boundaryAt` already accepts an `end_turn` assistant record with no `tool_use` as a boundary, so scratch works. `transcript-records.js` builds the `turn-end` kind from it, so a stream seat's turn footer comes from Clodex's own record of `result` events instead (§4.3). | S6; code |
| **`promptSource: "sdk"`** | `transcript-records.js` maps anything that is not `queued` to `typed`, so an `sdk` prompt renders as typed. That is correct. `scratch-mark.js` `classifyUserRecord` keys on `origin.kind` and `promptSource === 'system'`, so `sdk` classifies as an arrival. That is also correct. | code |

### 0.5 MEASURE list for wirescope (H0)

Every run uses the stock `claude` binary (record the version) with the same
argv as the README, plus the extras listed. The same neutral cwd and env rules
apply. `S` means stdin, `O` means stdout, and `J` means the transcript file.
**Report init ids, the files that exist, and J's tail for every row.**

| id | case | send / do | observe |
|---|---|---|---|
| M1 | resume across processes | P1: `--session-id <U>`, send "Remember the word MAGENTA. Reply OK.", close S, wait for exit. P2: `--resume <U>`, send "What word did I ask you to remember?" | P2 answers MAGENTA. P2's `init.session_id` is `U` or new. J is appended, or a new file is created with the history copied. |
| M2 | `--session-id` with stream-json input | spawn with `--session-id <U>` (a fresh uuid), send one turn | `init.session_id === U`; J is named `U.jsonl` |
| M3 | output of a resumed process before input | P2 from M1, but send nothing for 10 s, then one turn | any O lines before the first send (init? replayed history?); O lines between the send and the first new `assistant` |
| M4 | fork | `--resume <U> --fork-session`, one turn | new id in init; new file; history present in the new file; U's file untouched |
| M5 | resume after compact | one turn, `/compact`, close; then `--resume <id>`, ask about the first turn | the id is unchanged across the compact and the resume; the answer comes from the summary |
| M6 | clear with a non-empty session | two turns, `/clear`, one turn, close | the pre-clear id, `new_conversation_id`, the next init id; which of the three exist as files; then `--resume <post-clear id>` works |
| M7 | SIGKILL mid-tool, then resume | a prompt that runs Bash `sleep 20; echo X`; SIGKILL the CLI at t=5; `--resume`, send "continue" | J's tail after the kill (orphan `tool_use`?); on resume, whether the CLI synthesises a result, re-runs the tool, or fabricates a reply |
| M8 | SIGTERM mid-tool | as M7 with SIGTERM | exit code, time to exit, J's tail, whether the `sleep` child is left running |
| M9 | stdin EOF mid-tool (parent crash) | as M7, but at t=5 close S and **keep** reading O; variant M9b: close S **and** O | does it finish the turn? time to exit; on M9b, does it die on EPIPE, when, and in what state is J |
| M10 | death with `can_use_tool` pending | `--permission-prompt-tool stdio`, a Write prompt, never answer, SIGKILL at t=5, resume | J's tail; resume behaviour. Variant M10b: never answer and wait 10 min; does the request time out on its own? |
| M11 | two writers | A: `--resume U`, idle. B: `--resume U`, one turn. Then A: one turn | J's interleaving; any lock or refusal; what A's model believes |
| M12 | hooks under `-p` | `--settings` naming SessionStart, UserPromptSubmit (emit `additionalContext` "NONCE-7"), PreToolUse (deny Bash `false`), PostToolUse, Notification and `statusLine` commands, each appending its stdin JSON to a marker file; turns: one plain, one asking "what is NONCE?", `/clear`, `/compact` | which hooks fire; SessionStart `source` values (startup / resume / clear / compact); whether the model sees NONCE-7; whether the deny holds; whether `statusLine` ever runs |
| M13 | `@path` in a stream-json user message | write `/tmp/x/secret.txt` holding "PLUM"; send "@/tmp/x/secret.txt what is the word?" | answered with **no** Read tool call (the file was attached, as in the TTY) or not; J shows an attachment record |
| M14 | caller-supplied uuid | send `{type:"user", uuid:"<V>", message:…}` with `--replay-user-messages` | whether the replay `uuid === V` and J's user `uuid === V` |
| M15 | slash command mid-turn | during an E3-style tool turn, send `/compact` | executed after the turn, folded in as text, or dropped |
| M16 | fold repeatability and `queued_turn_count` | E3 three times with different prompts; then E3 with `interrupt {cancel_queued:true}` after msg 2 | whether msg 2 ever gets its own `result`; `queued_turn_count` in each `result`; what `cancel_queued` does to msg 2 |
| M17 | `set_model` with `system_prompt` | `set_model {model:<current>, system_prompt:"Always end replies with NONCE-9."}` between turns, captured through wirescope | whether the next request's system prompt carries it; whether it **replaced** the whole system prompt, the append part, or was appended |
| M18 | through the proxy | run A with `--settings` `{"env":{"ANTHROPIC_BASE_URL":"<wirescope>"}}` | requests are seen; the wire turn events Clodex's tee keys on; the user-agent and entrypoint headers wirescope parses |
| M19 | permission flag set | `--permission-prompt-tool stdio` **without** `--permission-prompts host`; then an allow that carries `updatedPermissions: [<the suggestion>]` | whether `can_use_tool` arrives; whether a second Write is prompted again |
| M20 | permission inside a subagent | an Agent-tool subagent that calls Write | whether `can_use_tool` arrives; its `tool_use_id`, and any parent or agent id field |

The following are not on the list, because they are settled or not needed:

- exit on EOF when idle (S9);
- input before init (S10);
- the compact id (S3);
- trust (S11);
- TTY-to-`-p` transcript compatibility, which only matters for migrating
  existing seats. It is listed under H8 as M21 when that ticket comes.

---

## 1. Transport shape

**Recommendation: a transport, not a session type.** A claude seat keeps
`type: 'claude'` and gains a persisted `transport: 'pty' | 'stream'`. A new
`stream-seat.js` owns the child process and sits where `ptyProc` sits today.

Why it is not a new type:

- Every per-type decision stays correct for a stream seat. That covers the
  adapter lookup (`adapterFor(type)`), accounts (`CLAUDE_CONFIG_DIR`), skill
  delivery (`skill-delivery.js`'s claude adapter), argv merging
  (`mergeClaudeSystemPrompt`), team resolution, `capsFor`, the templates, and
  the 20+ `type === 'claude'` / `agentType === 'claude'` checks in
  session-manager.js.
- A new type would fork all of them. A transport forks only the few places
  that actually touch bytes.

### 1.1 `stream-seat.js` (new, root, electron-free)

```
createStreamSeat({ spawn, cmd, args, cwd, env, codec, log, now })
  → { pid, send(userMsg), control(req) → Promise<resp>,
      onEvent(fn), onClose(fn), closeInput(), kill(signal) }
```

What it does:

- Spawns with `child_process.spawn` and `stdio: ['pipe','pipe','pipe']`, with
  its own process group.
- Splits stdout into lines with **no length cap**. S7 means a single line can
  carry a whole file in `originalFile`.
- Decodes each line through the codec (§7) into normalised events.
- Correlates `control_response` to `control_request` by `request_id`.
- Attaches `'error'` handlers to `stdin`. **This is required:** an EPIPE on a
  write to a dead child is otherwise an uncaught exception in the main process.
- Emits `close` once both the exit and the stdio close have happened (§1.4).

It is pure over an injected `spawn`, so the whole of it can be tested with a
fake child. It goes into `SCANNED_MODULES`.

### 1.2 What happens to each piece of today's seat

| piece (file, function) | stream seat |
|---|---|
| `create()` argv (session-manager.js `_createReserved`, the `case 'claude'` arm) | **Kept.** It adds `-p --input-format stream-json --output-format stream-json --verbose --replay-user-messages --include-partial-messages`, plus either `--session-id <uuid>` (fresh; M2) or `--resume <id>` (restore). H3 adds `--permission-prompt-tool stdio` (**hidden flag, measured on 2.1.281**; README row D) and `--permission-prompts host` if M19 says it is still required. `--settings`, `--append-system-prompt-file`, `--system-prompt-file`, both `--plugin-dir`s, `--add-dir`, `--model` and `--dangerously-skip-permissions` are unchanged. `TERM` and `FORCE_HYPERLINK` become irrelevant but are harmless. |
| `pty.spawn` and the `session.pty` handle | Replaced by `session.io`, a small interface that both the pty and the stream seat satisfy: `{ pid, kill(sig), transport }`. The 28 `.pty` sites in session-manager.js fall into three groups. (1) **kill** (8 sites) goes through `io.kill`. (2) **write** has 3 sites: `SessionManager.write` (renderer keystrokes), the boot nudge `\r`, and the InjectQueue `write` at `_injectQueueFor`. For stream seats the operator's input arrives through the composer IPC instead of keystrokes, and the other two are not constructed. (3) **resize** (1 site) is a no-op. `remote-wiring.js` and `team-tickets.js` hold one `.pty` reference each, and those are re-pointed the same way. |
| `preseedClaudeOnboarding` | Harmless. Probably unnecessary under `-p` (S11), but keep it: the same seat can be switched back to `pty`. |
| hook script and settings (cli-hooks.js `setupClaudeHook`) | **Kept unchanged, byte-pinned bodies included, if M12 shows the hooks fire.** `statusLine` is TUI-only (M12 confirms), so for stream seats the context numbers come from `result.usage` and `modelUsage` (S8), or from the wire. `attn.sh` (the Notification hook) stops being how permission attention is learned (§3). |
| transcript symlink | Kept. The writer is decided by M12 (§0.4). |
| `jsonl-watcher.js` / `TranscriptSentinel` | **Not started for stream seats.** Its jobs each move. Intent text moves to the stream (§1.3). Session-id tracking moves to init. The compact rendezvous moves to `compact_boundary`. Activity moves to the turn state. Tee-failure recovery replay has no counterpart, because nothing is being tee'd. |
| `wire-intents.js` / `_ensureWire` | The wire stays registered for telemetry. **It must not dispatch intents for a stream seat** (§1.3). |
| `inject-queue.js` (Ctrl-U split write, settle, bracketed paste, quiet gate, ready gate) | **Not used by stream seats.** A JSON line on a pipe has no line editor to clear, no paste mode and no draft to splice into. The *turn batching* layer above it (`_injectText` with `_injectHoldReason` and `_maybeFlushInjectQueue`) is kept and becomes the outbox's hold rule (§2). |
| `isDraftOpen`, `_voiceDraftOpen`, `_parkDivertFor` (the draft-splice protection) | Their reason for existing is gone: the operator's draft lives in Clodex's composer and cannot be spliced into. They are not consulted for stream seats (§2.4). |
| `transcript-records.js` | **Kept as the canonical record builder** (§4). It gains the `result` side-car for `turn-end`. |
| `live-split-view.js`, `lib/live-split.js`, xterm | **Not created for stream seats.** The whole split/strip/FULL machinery exists to share one terminal between the pane and the CLI's composer, and a stream seat has no terminal. |
| `pendingOutput` (2 MB detached buffer) | Not needed. A detached window re-pulls the transcript on reattach, and live deltas that arrived while detached are dropped. |

### 1.3 Intents from the stream

A new `intentSource: 'stream'`, decided in `create()` for stream seats. It is
exclusive, like the other three sources (messaging.md §1).

- Assistant text is buffered by `message.id`. S2 and the B2 run show one API
  message arriving as several `assistant` events, one per content block.
- The buffer is flushed on a new id, on a non-assistant event, or on `result`,
  into `_extractIntents` and then `_handleIntent`.
- This is the JsonlWatcher's flush rule (new requestId / non-assistant / 1 s
  silence), minus the timer. `result` is a definite end, so the timer is not
  needed. Extract the buffer into a pure helper shared by both, rather than
  copying it.
- **The wire must not also dispatch.** The deduper is source-shaped
  (`IntentDeduper.claim`) and allows wire-after-wire. A stream seat whose wire
  also dispatched would fire every intent twice through two sources the deduper
  treats as a cross-path overlap. That is caught today only by accident, and it
  logs a warning every turn.
- `_extractIntents` still sees one trimmed line at a time. Column-1 anchoring
  (messaging.md, "Invariants") holds, because the text blocks are complete
  strings and not deltas. **Intents are never scanned from `stream_event`
  deltas.**

### 1.4 Exit ordering

Node's child `'exit'` event can fire before stdout has drained. The stream
seat's `onClose` fires only after both `'exit'` and `'close'`. Every step of
today's `ptyProc.onExit` order runs from `onClose`: `_dead`, `session-exit`,
remote notify, persistence, `_cleanup`. So does every `_waitForExit` waiter
(Move, scratch cut, reload). A `result` that is still in the pipe is processed
before `_dead` is set, so a final intent is never lost at exit.

---

## 2. Input model

### 2.0 The main gain: the operator no longer contends for the input line

This is Bogdan's framing, and it is the reason the input model below is
simpler than today's rather than more complex.

**Today the PTY input line is one shared cursor.** Four parties arbitrate who
owns it:

- the operator's keystrokes;
- the inject queue's Ctrl-U split write (`inject-queue.js` `_drain`);
- the quiet gate that waits out his typing (`shouldDeferInject`);
- the CLI's own redraw of its composer.

Ordering between his text and a dm is decided by **who presses Enter first**,
which makes it a timing accident. Most of `inject-queue.js`, and all of the
draft predicates, exist to stop one party destroying another's half-written
line.

**Under stream-json each user message is a discrete stdin record.** The
composer becomes an editor that nothing can overwrite: it is a DOM textarea
owned by Clodex, and no delivery path touches it. Ordering between operator
text and queued dms, ticket replies, reminders and exec results becomes a
**policy Clodex chooses**.

**Recommended policy: operator first, pending injections visible.**

- Held Clodex-originated input (§2.2) is shown in the pane directly above the
  composer as dimmed `queued` rows, one per item. Each row shows the sender and
  the first line. That is the pane-app-view.md `queued` kind, now fed by the
  outbox rather than by `queue-operation` records. So the operator always sees
  what will reach the seat next and in what order.
- When the operator sends while items are held, **his message goes first, on
  its own**. The held items follow as one joined message after the `result`
  his message produces.
  - He is at the keyboard, so his intent is the most current.
  - A dm that arrived a few seconds earlier is rarely what he is answering.
  - If it is, he can see it in the `queued` rows and click **Send now** on
    the row. That promotes it ahead of his next send.
- Each queued row also has **Drop**, which is operator-only.
  - A dropped dm is re-parked through `_parkHeldDelivery`, so its sender gets
    the ordinary resend id. It is never silently discarded.
  - This rule is what keeps "parked mail survives everything except explicit
    user-kill" true.
- The alternative, strict arrival order, is simpler. But it re-creates today's
  accident in a new form: his reply lands after a dm he has not read.

**What is deleted because the contention is gone** (for stream seats; PTY
seats keep all of it):

- in `inject-queue.js`: the Ctrl-U key event and `CTRLU_SETTLE_MS`, the
  `\n`→`\r` rewrite, the bracketed-paste wrap, the settle before Enter, the
  quiet gate (`shouldDeferInject`: typing window, hint hold, speaking), the
  boot ready gate (`shouldWaitForReady`), and the cap-fire splice warning. None
  of `InjectQueue` is constructed for a stream seat. What survives of the file
  is `canFireCompact` and `isInjectInFlight`, which are turn-state rules and
  not byte rules.
- in session-manager.js, for stream seats:
  - the typed-draft predicate (`isDraftOpen` via `isHumanPtyInput`) and the
    dictated-draft stamp (`_voiceDraftOpen`);
  - the park-at-fire divert (`_parkDivertFor`) and the busy/draft park's
    *draft* arm (its *busy* arm becomes the outbox hold);
  - the draft guard in `_anyDraftOpen` on the idle drain;
  - the boot nudge (`_armBootNudge`) and `_bootReadySeen`.

**What is not deleted: the tool-turn fold.** This is the one place Clodex
still has to *hold* input rather than send it. A message sent during a turn
that is calling tools is consumed at the next tool boundary and never gets a
turn of its own (README E, E3). So Clodex-originated input waits for `idle`
(§2.2), and the outbox, not the timing of a keystroke, decides when it goes.


Everything becomes one `user` line on stdin: the composer, dms, ticket
dispatches and replies, reminders, exec results, monitor ticks, handoffs and
slash commands. For each seat, one **outbox** decides *when*.

### 2.1 The turn state the gate observes

This replaces "PTY output recency" and the jsonl-derived activity:

| state | entered on | left on |
|---|---|---|
| `idle` | spawn; `result` | our send; an `init` |
| `busy` | our send; an `init` (the CLI started a turn, for example a background-task notification) | `result` |
| `blocked` | a `control_request can_use_tool` | our `control_response` |
| `compacting` | `system/status` with `status: "compacting"` | `status: null` with `compact_result` |

`busy` and `idle` drive `_emitActivity` (`thinking` and `idle`). That keeps
every current consumer unchanged: the tray, `[agent:who]`, `shouldHoldDm`, the
restart waiter's `classifyRestart`, and the stall nudge. `result` is a definite
turn end, which the jsonl path only infers after 1 s of silence.

### 2.2 The rule

- **Clodex-originated input** (dms, tickets, reminders, exec results,
  continuations, monitor ticks) is **held while the seat is not `idle`**.
  - Everything held is joined with a blank line and sent as **one** message at
    the next `result`. That is exactly today's turn batching
    (`_injectHoldReason` returning `'busy'`, then `_maybeFlushInjectQueue` joins
    the queue).
  - This is not new policy: today Clodex already never injects into a busy
    seat. The fold measured in E and E3 therefore **never happens to
    Clodex-originated input under this rule**.
  - The 5-minute force-flush valve (`INJECT_HOLD_TIMEOUT`) is kept. A forced
    flush into a busy seat folds, and that is logged.
- **Urgent** dms are sent immediately, even while busy. They fold into the
  running turn at the next tool boundary (E3), and the model sees them in that
  turn. That is what "urgent" asks for.
- **The operator's composer** sends immediately by default.
  - While the seat is busy, that folds at the next tool boundary. **That is
    the TTY CLI's current behaviour**: a prompt typed while the seat is busy is
    written to the transcript as a `queue-operation` enqueue and then consumed
    inside the running turn (pane-app-view.md §1.2, the `queued` kind).
  - The composer has a second action, **Send after turn** (Alt+Enter). It puts
    the text in the outbox under the Clodex hold rule.
- **Never interrupt automatically.** `interrupt` is sent only by the
  operator's Stop button or Esc in the composer. README C shows it answers in
  1 ms and leaves the seat usable.

### 2.3 Delivery confirmation and fold detection

`--replay-user-messages` echoes each consumed stdin message as a `user` event
with `isReplay: true`, at the moment the CLI **consumes** it: at turn start, or
at the tool boundary it folds into (README F, E3).

That gives the outbox a receipt the PTY path never had. A PTY write only proves
the bytes left.

- **Correlation.** Correlate by uuid if M14 shows the CLI keeps a caller-given
  `uuid`. Otherwise correlate by exact content, first in first out.
- **Own turn.** The replay arrives while the seat is `idle` or right after a
  `result`, and is followed by an `init`.
- **Folded.** The replay arrives inside a turn that was already running when
  the message was sent. That is, no `result` has come since the send, and the
  turn started before the send. The pane marks the row `folded into this turn`.
  For a dm, the IPC log gets a `delivered (folded)` row.
- **Undelivered.** The process closes with the message sent but never
  replayed. The message is re-parked through the same `onUndelivered` path the
  inject queue uses today (`_quiesceInjects` re-parks with the seat's `born`).
  That keeps the invariant "parked mail survives everything except explicit
  user-kill" across a crash.
- **`result.queued_turn_count`** (S8) is logged beside every flush. M16 says
  whether it can replace the timing rule.

The spec-confirm latch (`_specUnconfirmed`, `_seatTranscriptHas`) keeps
working unchanged, because the transcript is still the authority. It can later
be simplified to "the dispatch was replayed", but that is not in scope.

### 2.4 What the quiet gate becomes

**Nothing.** The quiet gate, the Ctrl-U settle, the typed-draft predicate, the
dictated-draft predicate, the park-at-fire divert and the boot nudge all
protect the CLI's composer or its input loop. A stream seat has neither.

The operator's draft is a DOM textarea that Clodex owns. Deliveries never
touch it, and a delivery arriving while he types only makes the seat busy,
which the composer shows. The only gate left is turn state (§2.1).

**Parking** (pending-store.js) is unchanged in data and semantics: the
cost/dialog hold-park, the busy park, the passive park and resend. Its drains
change carrier:

- If M12 shows UserPromptSubmit fires with `additionalContext` honoured, keep
  `pending.sh`, `acks.sh`, `ctxwarn.sh` and `poll-guard.sh` exactly as they
  are. This is the zero-change path, and it keeps the notice-queue
  at-most-once / prompt-delta at-least-once split that CLAUDE.md forbids
  merging.
- If not, the outbox runs the same claims in-process at send time: the
  `pending/` rename-claim, the notice-queue claim-by-rename, and the prompt
  delta. It keeps **the two mechanisms separate**, prepending two separately
  claimed blocks, exactly as the hook does. That is H2's biggest branch, and M12
  decides it.

**Spills.** DM bodies over `MSG_SPILL_THRESHOLD` are delivered to Claude as
`@<path> `, relying on the TUI's auto-attach. **If M13 shows `@path` is not
expanded under stream-json**, stream seats take the Codex arm ("read it with
Read") in `_buildDeliveryText`, and the same goes for every `@` pointer
`_handoffText` writes. This is a real behaviour change, because the seat pays a
tool call for every spilled message. M13 is on the list for that reason.

---

## 3. Permissions

### 3.1 Flags

- `--permission-prompt-tool stdio` is **a hidden flag, measured on 2.1.281**
  (README, "Request shapes": it does not appear in `--help`).
- `--permission-prompts host` alone silently denies (README row D). M19 says
  whether the pair is needed.
- A seat launched with `--dangerously-skip-permissions` never sees
  `can_use_tool`, and `set_permission_mode` refuses `bypassPermissions` unless
  the seat was launched with that flag (README C, `bypass_not_launched`).

### 3.2 What still answers before Clodex is asked

These all run inside the CLI before it asks the host, so none of them move:

- `permissions.deny` in `hook.json` (`denyBuiltins ∪ disabledTools`), plus
  `skillOverrides`. These are settings.
- `bash-guard.sh` and `poll-guard.sh` PreToolUse denies. These are hooks, and
  depend on M12.
- The CLI's own safe-command allowance. README D saw Bash `echo` run without a
  prompt in default mode. The cause was not investigated.

Exec grants (`execCommands`) are Clodex-side intent permissions. They never
reach `can_use_tool` and are unaffected.

### 3.3 The dialog row

A new record kind, `permission`, is added to pane-app-view.md's §1.2 table:

| field | from |
|---|---|
| `id` | `request_id` |
| `toolUseId` | `tool_use_id`. It links the row to the `tool` record, which is `pending` meanwhile. |
| `name`, `arg` | `display_name`; `toolInputLine(input)` (the same argument line as the tool row) |
| `description`, `blockedPath`, `reason` | `description`, `blocked_path`, `decision_reason` (README, "Request shapes") |
| `suggestions` | `permission_suggestions`, for example `[{type:"setMode", mode:"acceptEdits", destination:"session"}]` (README D) |
| `state` | `pending` \| `allowed` \| `denied` \| `lost` |

Rendering:

- The row sits **directly under** its pending tool row, drawn as a card with a
  `--warn` bar.
- Buttons:
  - **Allow**: `{behavior:"allow", updatedInput: input}`. This shape was
    measured (README D).
  - **one button per suggestion**, each labelled from it ("Allow edits for
    this session"). It sends `allow` plus `updatedPermissions:[suggestion]`
    (**M19**; until it is measured, a suggestion button sends `set_permission_mode`
    for `setMode` suggestions, which was measured in README C, and then allow).
  - **Deny**, with an optional reason: `{behavior:"deny", message}`. This shape
    was measured (README D). The model receives the message text.
- The input detail (for example Write's content, or an Edit's patch) opens in
  the side pane, through T3's tool tab.
- A decided row collapses to one line, for example `allowed · edits for
  session`.
- A row still pending when the seat restarts becomes `lost`, with the notice
  from §0.2.

### 3.4 Attention and dm delivery

- `can_use_tool` calls `_setAttention(session, {kind:'permission', message:
  description})`, which is `_onAttention`'s path minus `classifyNotification`.
  That gives the OS notification, the tray and the `[agent:who]` label
  unchanged. The `control_response` clears it.
- **"A seat blocked on a permission dialog holds even urgent dms" becomes
  wrong for stream seats.**
  - That rule exists because a PTY injection would *type into the dialog*
    (`shouldHoldDm`: "injecting now would answer the dialog").
  - A stdin message cannot answer a `control_request`. It queues and folds, just
    as it does during a tool turn.
  - So for stream seats `blocked` behaves as `busy`: non-urgent input is held,
    and urgent input is sent and folds.
- `shouldHoldDm` gains a transport-aware input. The `noUrgent` arm applies only
  to `transport: 'pty'`.
- The dm-routing text in `ipc-prompt.js` that teaches seats about dialog holds
  is unchanged: it describes PTY targets, which still exist.

---

## 4. Rendering

### 4.1 The transcript stays the source of truth; the stream is an overlay

**Decision: the pane keeps reading the transcript through
`transcript-records.js` `recordsOf`.** That is the restore path, the
peer-and-reload path, and the steady-state path. Stream events add only what
the file cannot give yet.

This is sound because of S2. Stream `assistant` and `user` events carry the
same `uuid`s the transcript will hold. A record first built from the stream and
later rebuilt from the file has **the same id**, so pane-app-view.md §0.2's
keyed reconcile swaps it in place, with no duplicate and no flicker. Tool
records key on `tool_use` id, which is identical on both sides.

In main, `stream-overlay.js` (new, pure) keeps a small per-seat list of:

- **provisional records**: stream `assistant` and `user` events not yet seen
  in the file. These are normalised to the file's shape, which means renaming
  `tool_use_result` to `toolUseResult` and **stripping `originalFile` before
  anything else** (pane-app-view.md §0.1), then passing them through the same
  `recordsOf` builder;
- **live-only state**: the in-flight text of the current block, the pending
  permission rows, the current `system/status`, and the running turn's start
  time.

`transcript:pull` returns `recordsOf(file) ⊕ provisional ⊕ live`. A provisional
record is dropped as soon as the file yields its uuid. The existing 100 ms
change debounce and the 1 s pull throttle stay for the file. Live state is
pushed on a coalesced 50 ms `transcript:live` event for the active seat only.

### 4.1a Three channels, and the Clodex wire paints (Bogdan, 2026-09-24)

Bogdan's framing supersedes the stdout-centred reading above: under the PTY,
Clodex received a painting the CLI had already executed and tried to change a
colour here and there; on a stream seat, Clodex does the painting itself, and
the paint comes from the wire every agent seat already runs through. The path
is CLI → Clodex wire (`wire/proxy.js`, the in-process proxy that parses
intents, cuts spills and collects telemetry) → upstream, where upstream is
wirescope when it is on and Anthropic directly when it is not. Wirescope is
an observer behind the wire, not a party to it; nothing here depends on it.
So a stream seat has three channels, each carrying only what the others
cannot:

| channel | direction | carries |
|---|---|---|
| stdin | Clodex → CLI | user messages, slash commands, control requests (`interrupt`, `set_model`, `set_permission_mode`), permission replies |
| **Clodex wire** | API wire, observed in-process | the live painting: `content_block_delta` text and thinking deltas, `tool_use` blocks as they are emitted, `message_start`/`message_delta` usage, model, stop reason. This is the same feed the intent scanner, the telemetry and the spill cut already consume (`stream-start`/`stream-end`/`turn.*` events, `wire/sse.js` framer). |
| stdout | CLI → Clodex | only what never crosses the API wire: `init`, `result`, `conversation_reset`, `compact_boundary`, `system/status`, `can_use_tool` requests, the local replies to `/cost`, `/context` and friends |

The join key exists on both sides today: a transcript assistant record carries
`message.id` (the API `msg_…` id) and `requestId` next to its `uuid`, and the
wire's framer records `message_start`'s `msg.id` as `messageId`. So a live row
painted from wire deltas is keyed `messageId:blockIndex`, and when the file
yields the record with that `message.id` the keyed reconcile swaps it in
place, exactly as §4.1 describes for stream uuids. `--include-partial-messages`
is not needed: stdout is read for control only, and the wire's deltas are the
overlay. §4.2's stdout-delta rows are therefore dropped, not kept as a
fallback; there is no seat without the wire.

Consequences for H1: `stream-codec-claude.js` decodes control records only;
`stream-overlay.js` subscribes to the wire's per-agent stream events, which
already arrive keyed by agent because the seat's `ANTHROPIC_BASE_URL` routes
through `/agent/<name>/`; the file remains the source of truth and the
restore path.

### 4.2 Stream event to row

| stream event | row (pane-app-view.md §1.2 kind) |
|---|---|
| `user` with string content, `isReplay` | `prompt` or `inbound` (same classifier). If the outbox marked it folded, `folded: true`. |
| `assistant` `text` block | `assistant` (provisional until the file has the uuid) |
| `assistant` `tool_use` block | `tool`, `state: pending` |
| `user` `tool_result` (+ `tool_use_result`) | completes the paired `tool`, with `sum` from the renamed side-car |
| `assistant` `thinking` | `thinking` (`chars` only) |
| `stream_event` `content_block_delta` `text_delta` | live-only: the in-flight `assistant` row keyed `msgId:index`, replacing T4's `writing…` ghost. The provisional record replaces it when the full `assistant` event lands. |
| `control_request can_use_tool` | `permission` (§3.3) |
| `system/permission_denied` | the paired `tool` becomes `denied` |
| `system/compact_boundary` (+ the summary `user`) | `boundary: compact` with `preTokens`, `postTokens` and `trigger` |
| `conversation_reset` | `boundary: clear`. The file side is the realpath repoint the reader-hardening ticket already handles. |
| `system/status` (`requesting`, `compacting`) | live tail (§4.3) |
| `system/task_started`, `task_notification` | `notification` |
| `rate_limit_event` | live tail, and a `notice` if the status is not `allowed` |
| `result` | `turn-end` (`durationMs`, the turn's cost delta, `isError`) — see §4.3 |
| `system/init` | no row. It updates the seat's model, permission mode and slash-command list (§5). |

### 4.3 What T3–T5 change

- **Turn footer (T1's `turn-end`).** A `-p` transcript has no
  `turn_duration` (S6).
  - Clodex appends each `result` to `sessions/<seat>/turns.jsonl` as `{uuid of
    the turn's last assistant record, duration_ms, num_turns, cost delta,
    is_error, ts}`. The cost delta is the difference between consecutive
    `total_cost_usd` values, which is cumulative per process (README header).
    It resets to the new process's own value after a respawn.
  - `recordsOf` gains an optional side-car argument, and synthesises `turn-end`
    after the matching assistant record.
  - The side-car sits in the seat directory, so it survives restart and travels
    with a move to a peer. **Clodex never writes into the CLI's transcript.**
- **T3 (tool tabs).** Unchanged: `detailOf` reads the file index. Live Bash
  output keeps `bash-live.sh` (M12). Until the result lands in the file, a
  pending tool's detail comes from the provisional record.
- **T4 (live tail, folding, intent cards).**
  - **The tail changes source.** It can no longer mirror the CLI's status row,
    because there is no screen and nothing for `measureSplit` to read. It is
    built from stream state instead:
    - `requesting…` or `compacting…` from `system/status`;
    - the running tool's name and elapsed time from the pending `tool`;
    - output tokens from `message_delta` usage;
    - the rate-limit status.
  - This is *better*: it is typed data, and not a scraped row whose wording can
    change. It deletes T4's `measureSplit.status` fixture table.
  - Folding is unchanged. **Intent cards** are unchanged, and the shared
    greedy-body helper is still required.
  - The `writing…` ghost is replaced by real streaming text (the §4.2 delta
    row), which answers pane-app-view.md open question 4.
- **T5 (navigation).**
  - Search loses its `search raw terminal` fallback, and the **raw-terminal
    chord (Cmd+Shift+T) has nothing to flip to**. For stream seats the chord
    opens the seat's raw stream log in the side pane: the last N stdout lines,
    kept in memory by `stream-seat.js`. That keeps a "see what the CLI actually
    said" escape.
  - Sticky headers, jumping, the pill and the rail are unchanged.
  - Keys are no longer "owned by the PTY". The pane can take arrow keys when
    the composer is empty, but that is T5's call.

### 4.4 The composer (new; the strip is gone)

A stream seat's tab is: pane (flex 1), live tail, composer. The composer is a
textarea with these parts:

- Enter sends, Shift+Enter inserts a newline, Alt+Enter is "Send after turn"
  (§2.2), and Esc interrupts while the seat is busy.
- A slash menu fed by `init.slash_commands` (§5).
- `@` file completion from the seat's cwd, using the files popover's existing
  listing.
- Image paste as a base64 `image` content block. The stream-json `user`
  message takes content blocks. No measurement is needed here, because
  content blocks are the documented input shape, but H5 tests it first.
- Chips for model and permission mode, and a Stop button.

macOS dictation works natively in a textarea. **The CLI's own voice mode does
not exist without the TUI.** `voice-control.js` and
`voice-submit-watcher.js` drive the CLI's recorder and read its composer off
the screen. For stream seats, voice becomes the OS dictation into Clodex's
composer, and the trigger-phrase submit becomes a textarea check. That is a
loss of the CLI's hold-to-talk stream, and it is listed in §9.

---

## 5. Slash commands and menus

Everything in `init.slash_commands` passes through as user text, and Clodex
renders the reply. Local commands return a `<synthetic>` assistant message with
cost 0, and skills become billed turns (README B rows). What Clodex builds
itself:

| control | mechanism | evidence |
|---|---|---|
| **Model picker** (composer chip) | `control_request set_model {model}`. The list comes from `cli-adapters.js` `claude.model.aliases` plus the current `init.model`. A `catalog_unknown` error is shown inline. | README C set_model |
| **Permission-mode toggle** | `set_permission_mode {mode}` over `default`, `acceptEdits`, `plan`, `auto` and `dontAsk`. `bypassPermissions` is offered only when the seat was launched with the flag (`hasBypass(adapter, argv)`). The chip follows `system/status.permissionMode`. | README C set_permission_mode |
| **Stop** | `control_request interrupt` | README C interrupt |
| **Clear / Compact buttons** in the tail's `⋯` | They send `/clear` or `/compact` through the **outbox with the Clodex hold rule**, so they wait for `idle`. M15 says whether a mid-turn slash command would be dropped. The rule makes that moot. | README B, B2 |
| **/status** (unavailable in `-p`) | Clodex's own seat card: `init.model`, `permissionMode`, `cwd`, `claude_code_version`, tools and MCP servers from init, account, and session id | README B /status; A init |
| **/help** (unavailable in `-p`) | The slash menu itself, with each entry's description where init provides one | README B /help |
| **Context usage** | `/context` as text today. The `get_context_usage` control exists in the bundle but was not tried. It is the path to a live ctx chip that replaces the statusline feed. Measure it in H5, not in H0, since it is not a gate. | README, "Request shapes" |
| `/model`, `/config`, `/cost`, `/usage` typed by hand | Pass through. They print and return. | README B rows |
| `terminal_slash_commands` (`doctor`, `color`, `focus`, `reload-plugins`) | Hidden from the menu. `reload-plugins` has a `reload_plugins` control (untried). | README A init |

Login (`accounts.js`'s **Log in**) spawns a `bash` seat that runs
`claude /login`. It is unaffected, because bash stays PTY.

---

## 6. Lifecycle beyond restart

| event | stream seat |
|---|---|
| **Archive (✕ / Cmd+W)** | `closeInput()`. An idle seat then exits by itself in about 1 s (S9). A busy seat gets `interrupt` first. SIGTERM follows at 2 s, and SIGKILL at 5 s (the existing fallback). The persistence effects are unchanged (`archivedAt`). |
| **Delete / kill** | The same signal sequence. The record-dropping is exactly today's, per the list in CLAUDE.md, and no new `remove()` site is added. |
| **Natural exit** | This is rare: the process lives until stdin closes. A crash of the CLI (non-zero exit, or a signal) goes through the normal crash toast, and the record is kept. |
| **Seat directory** | Unchanged. `sessions/<seat>/` gains `turns.jsonl` (§4.3). `run/<seat>/agent.json` gains `cli: {pid, startedAt, sessionId}` (§0.2). Because `run/` is deleted on exit, the boot reap reads the record **before** `create()` re-mints `run/<seat>/`. |
| **Hooks with no PTY** | Subject to M12, they keep doing everything except the statusline: the SessionStart link and memory digest, the UserPromptSubmit drains, the PreToolUse observer and guards, the PostToolUse console spool and `bash-guard`. The Notification hook's permission kind is superseded by `can_use_tool`. |
| **Window closed** | The seat keeps running. There is no output buffering. Reattach re-pulls. |
| **Move to workspace** | Unchanged: it is a field rewrite, and the stream seat is untouched. |

---

## 7. Multi-CLI seam

`cli-adapters.js` gains a per-adapter `stream` block, which is null where
unsupported. The session manager consumes only **normalised events**, never a
CLI's wire format.

```
stream: {
  protocol: 'claude-stream-json',          // | 'codex-app-server' | 'muse-msp'
  argv({ resumeId, sessionId, fork, permissionsViaHost }) → string[],
  codec: 'stream-codec-claude',            // module id
  controls: { interrupt: true, setModel: true, setMode: true, permissionPrompt: 'host' },
  idSource: 'init',                        // where the conversation id is learned
}
```

The codec interface is `encodeUser({text, blocks, uuid}) → line`,
`encodeControl(req) → line`, and `decode(line) → Event[]`. The event set is the
seam:

`session-id(id)` · `turn-start` · `turn-end({durationMs, costDelta, isError,
queued})` · `record(fileShapedRecord)` · `text-delta({key, text})` ·
`tool-start` / `tool-end` · `permission-request({id, toolUseId, name, input,
suggestions, …})` · `status({phase})` · `reset({trigger})` ·
`compact({pre, post})` · `consumed({uuid|text})` · `control-response({id, ok,
body})`

What this implies for the other two CLIs:

- **Codex `app-server`** (JSON-RPC over stdio, threads and turns) and **`muse
  serve`** (MSP) each become one codec module plus one adapter block.
- Nothing in session-manager.js branches on `protocol`.
- `record` must produce the shape `transcript-records.js` reads. For a
  non-Claude CLI, that means either a per-CLI record builder (the builder
  already exists per CLI, in `transcript.js`) or a codec that maps into
  Claude's shape. That choice belongs to the ticket that adds the CLI.
- Codex's `caps.park: false` stays true: whether a CLI can be a park target
  depends on its hooks, not on its transport.

---

## 8. Coexistence and sequencing

**Coexistence.**

- Bash sessions stay PTY.
- Codex and Muse stay PTY until their codecs exist.
- A claude seat's transport is per seat, set in the New Session dialog as
  "Transport: terminal / stream (experimental)", and persisted on the record.
- Templates may name it.
- The default flips only after H6.

Every ticket follows pane-app-view.md §6's standing rules:

- `SCANNED_MODULES` for new modules;
- `docs/architecture.md`;
- zero comments in new files;
- a `CHANGELOG.md` line;
- **no `web-dist` change unless the ticket touches a web-served surface.**

**H0 — measurements (wirescope, not Clodex).** Run §0.5's M1–M20.

- M1 is a go/no-go gate for everything below.
- M2, M3, M9 and M12 shape H1 and H2.
- The results come back as a README in the probe's style under
  `proxy-lab/experiments/stream-resume/`.

**H1 — spike: one stream seat, talking and surviving a relaunch.**

*"Stream transport (experimental): a claude seat driven through `claude -p`
stream-json, rendered by the transcript pane with a plain composer; survives a
Clodex relaunch via --resume. No permissions, no dms."*

Parts:

- **New `stream-seat.js`** (§1.1) and **new `stream-codec-claude.js`**. The
  codec decodes only `system/init`, `assistant`, `user`, `result` and
  `conversation_reset`, and encodes only `user`.
- **session-manager.js:**
  - the `transport` parameter on `create()`;
  - the stream argv arm (`--session-id` when fresh, `--resume` when restoring,
    with no permission flags);
  - `session.io`, touching only the kill sites and the `onExit` order, run from
    `onClose`;
  - `onSessionId` from init;
  - `_emitActivity` from `init` / `result`;
  - `agent.json` `cli` identity, and the boot reap (§0.2) before a resuming
    `create()`.
  - Intents are **off** (no source), and the inject paths refuse a stream seat
    with a logged reason.
- **ipc-handlers.js / preload.js / api-contract.js:** `seat:send(name, text)`,
  local only and gated like `session:write`.
- **stores.js / persistence:** the `transport` field; restore passes it
  through.
- **renderer:**
  - For a stream seat, `renderer.js` mounts **no xterm**. It mounts
    `transcript-rows.js` full height over the existing `transcript:pull`,
    which works unchanged because the transcript symlink exists (hook or
    Clodex, per M12), plus a textarea composer.
  - There is a New Session checkbox.
  - The sidebar dot runs off the existing activity push.
- **Permissions:** the seat is created with the operator's posture. Without
  `--permission-prompt-tool`, default mode auto-denies writes (README D). H1
  renders `system/permission_denied` as a `notice` row that names
  "permissions arrive in H3", so a spike seat is honest about what it cannot
  do. To exercise writes in H1, launch it with bypass.
- **Tests:**
  - `stream-seat` against a fake child: line splitting across chunks, a
    500 KB line, EPIPE on write after exit, and `close` after `exit` with a
    trailing `result` delivered before `onClose`;
  - the codec table, one row per event with its literal expectation, cut
    from the probe's `runs/`;
  - the boot reap: live and matching kills; recycled pid (start-time mismatch)
    is left alone; dead does nothing;
  - restore round trip: a persisted `transport: 'stream'` restores with
    `--resume <id>`, and the id updates from a later init.
- **What Bogdan sees:** a seat with no terminal. He types in the composer, and
  prompts, tool rows and replies appear in the pane. He quits Clodex, reopens
  it, and the seat is there with its history, and it answers a question about
  the previous session.
- **Size:** about 450 source lines and 400 test lines.

**H2 — messaging.** Intents, dms, tickets, reminders and parking for stream
seats.

- `intentSource: 'stream'`, with the message-id buffer shared with
  `jsonl-watcher.js` (§1.3), and the wire is excluded from dispatch.
- **New `stream-outbox.js`** (pure): the §2.1 states, the hold and join rule,
  urgent bypass, replay confirmation, fold marking, and undelivered re-park
  through `onUndelivered`.
- `_injectText` routes stream seats to the outbox.
- Operator-first ordering and the visible `queued` rows with **Send now** and
  **Drop** (§2.0). Drop re-parks through `_parkHeldDelivery`.
- The compact latch fires on `result` with an empty outbox (`canFireCompact`,
  reused). The clear continuation fires on `conversation_reset` and is
  confirmed on the id change.
- `shouldHoldDm` becomes transport-aware.
- Drains stay in the hook, or move in-process, per M12. The spill pointer is
  per M13.
- **Tests:**
  - the outbox table: send idle; hold busy then flush joined at `result`;
    urgent while busy; replay own-turn vs folded vs never (re-park); force-flush
    valve;
  - `shouldHoldDm` × transport × `blocked`.
- **Size:** about 500 source lines and 450 test lines. This is **the riskiest
  ticket**, because it is the one that can lose a message.

**H3 — permissions.** Add `--permission-prompt-tool stdio` (hidden, 2.1.281)
to the argv.

- The `permission` record kind in `transcript-records.js`'s live merge.
- The card in `transcript-rows.js`.
- `seat:permission(name, id, decision)` IPC.
- Attention from `can_use_tool`.
- `lost` on restart.
- **Tests:** the reducer (pending → allowed/denied/lost), and the response
  shapes exactly as in README D.
- **Size:** about 350 source lines and 250 test lines.

**H4 — live overlay.** `stream-overlay.js` (§4.1):

- provisional records by uuid;
- the `originalFile` strip before anything else;
- coalesced `transcript:live`;
- the in-flight delta row;
- the tail from `system/status`;
- the `turns.jsonl` side-car and `recordsOf`'s `turn-end` from it.
- **Tests:** the overlay merge. A provisional record replaced by the file
  record with the same id keeps its node identity (on the fake document). The
  `originalFile` absence is asserted.
- **Size:** about 400 source lines and 350 test lines.

**H5 — controls and composer.**

- The model chip (`set_model`), the mode chip (`set_permission_mode`), Stop,
  and Clear/Compact through the outbox.
- The slash menu from init, and the `/status` card.
- Image paste.
- Dictation-trigger submit on the textarea.
- `get_context_usage` probed, then used for the ctx chip if it answers.
- **Size:** about 400 source lines and 250 test lines.

**H6 — the respawn paths under stream.**

- Reload, Move, scratch cut and rewind, move to peer, account move and
  `restartSession`, each re-verified with `_waitForExit` on `close`.
- The handoff as the first outbox entry.
- Archive and kill signal sequence (§6).
- The `killAll` stdin-close-first path.
- The restart waiter over stream turn state.
- **Tests:** one per trigger with a fake child. Each must assert the old child
  closed **before** the new one spawned (the two-writer guard). Scratch has a
  row where the old child's `close` arrives late.
- **Size:** about 350 source lines and 400 test lines.

**H7 — remote surfaces. Small: a gate lift, not a rebuild.**

- Discovery, `[agent:who]`, dms and the ticket board read Clodex's own
  registry and queue, and a stream seat registers like any other; none of
  them touch the PTY, so a stream seat is fully reachable from the phone, the
  browser and peers from H1 on.
- What the remote surfaces lack is the seat's *viewport*: the web host
  (`web-host.js`'s pty-data ring) and peers (`peer-client.js` `output`
  events) relay PTY bytes because that is what a terminal seat produces. A
  stream seat produces transcript records, and the pane that renders those
  already pulls them through `transcript:pull`, which the web host proxies
  like every other invoke. The pane is off in the web bundle only by the
  `window.__CLODEX_WEB__` gate in `renderer.js` (`createLiveSplitView` site),
  a choice from when the pane was new, not a limitation.
- H7 is therefore: lift that gate for stream seats, serve `seat:send` and
  `transcript-changed` over the web host, and the same two over the peer wire
  for peers. Likely one ticket; it does not need to precede the default flip.

**H8 — migration and the default flip.**

- A per-seat "Switch transport" action, which is a respawn on the same id.
- It depends on **M21**: a TTY-created session resumed by `-p`, and the
  reverse.
- Then the New Session default flips to stream. Terminal stays selectable.

## 9. Risks and things the implementer must not get wrong

- **The two-writer guard (§0.2).**
  - No `create()` that resumes a session id may spawn while a previous process
    on that id might be alive.
  - The boot reap proves identity by pid, start time and argv. It never uses
    `ptyOwnership`, whose parent-pid rule refuses orphans by design.
  - Every local respawn waits for `close`.
- **One symlink writer**, decided by M12. It is never the hook *and* Clodex.
- **One intent source per seat.** A stream seat's wire tee must not dispatch.
- **Never scan intents from deltas.** Scan only complete `assistant` text,
  flushed by message id and at `result`.
- **`originalFile` never leaves main** (S7). It is on the stream too, not only
  in the file. Strip it at decode time, not at render time.
- **Delivery is confirmed by the replay, not by the write.** A sent message
  that was never replayed is re-parked when the process closes. Parked mail
  survives everything except explicit user-kill.
- **The persisted session id comes from `init.session_id`.** It never comes
  from `conversation_reset.new_conversation_id` (S4).
- **Clodex never writes into the CLI's transcript.** The turn footer lives in
  `sessions/<seat>/turns.jsonl`.
- **The stdin `'error'` handler is mandatory.** Without it, an EPIPE after the
  child dies takes down the main process.
- **Losses the operator will notice**, which should be stated in the CHANGELOG
  line that ships each one:
  - the CLI's hold-to-talk voice mode;
  - the CLI's own `/help` and `/status` screens;
  - the statusline-fed ctx numbers, until `result.usage` or
    `get_context_usage` replaces them;
  - the raw terminal;
  - remote viewing, until H7.
- **Hidden flags.** `--permission-prompt-tool stdio` is hidden and was measured
  on 2.1.281. Each Clodex release that bumps the pinned or observed CLI version
  should re-run M19 and the README's row D. A CLI update that drops the flag
  turns every stream seat's permission prompt into a silent deny. That is
  detectable (`system/permission_denied` with no `can_use_tool` before it) and
  must raise a banner, not fail quietly.

## 10. Open questions for Bogdan

1. **Remote viewing (H7).** The phone and browser viewport is the same pane
   with its web-bundle gate lifted (see H7). Does that need to land before
   the default flips, or can stream stay desktop-only for a while?
2. **The operator sending while the seat is busy.** The default is "steer"
   (fold into the running turn, as the TTY does today), with Alt+Enter for
   "after this turn". Do you want it the other way round?
3. **Voice.** Is OS dictation into Clodex's composer an acceptable replacement
   for the CLI's hold-to-talk, or is voice a reason to keep some seats on the
   terminal?
4. **If M17 shows `set_model {system_prompt}` swaps the prompt in-process**,
   prompt regeneration at compact and clear stops needing a respawn. Is that
   worth a follow-up, given that the respawn path already works?
