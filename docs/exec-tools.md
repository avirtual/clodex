# Clodex tools via the exec intent

A pattern (and its first instance, `clodex-monitor`) for giving agents
purpose-built capabilities through the `[agent:exec …]` intent instead of the
CLI's generic built-in tools. Companion to [messaging.md](messaging.md) (the
socket delivery path these tools reuse) and the exec dispatcher in
`session-manager.js` (`_handleExecIntent`).

## Why exec, not a built-in tool

An operator-registered exec command (`~/.clodex/library/exec/<cmd>.json`) is a
**one-shot, schema-validated, fire-and-forget control channel**: `argv` comes
wholly from the registry (the agent's JSON payload never reaches argv, so
injection is structurally impossible), the payload arrives on STDIN, stdout is
dropped, and the launcher is SIGKILLed at the entry's `timeoutMs`. Feedback to
the agent is one line via `replyStderr`.

That makes exec an excellent **control plane** and a useless **data plane** —
which is the exact split most "tools" want. The trick, for any tool that
produces ongoing output, is to run the real work in a **detached worker** and
have the worker deliver results back to the invoking agent as DMs over its
`run/<agent>/agent.sock` socket (`{from, body, type:'dm'}` — the same
"message from outside clodex to an agent inside" path wake scripts use). The
exec code comment names this explicitly as the intended growth path
("ephemeral DM channel, deliberately NOT built here"). This is that channel.

**The shape of a clodex tool, generalized:**

- The exec launcher is the control plane: `start` / `stop` / `list` verbs,
  validated by the entry's `schema`. Message discipline: **queries reply**
  (`list`, via `replyStderr`), **command success is silent** (empty stderr +
  exit 0 → the dispatcher injects nothing, so an ack never costs a turn),
  **failures are loud** (exit 1 → the dispatcher always injects the error),
  **tracked-item state changes wake, administrative events ride passively**.
- `start` daemonizes a worker (`detached` + own session + `unref`) so it
  outlives the launcher's SIGKILL, then exits 0 immediately — fire-and-forget
  stays fire-and-forget.

**Why the worker survives (load-bearing).** The dispatcher spawns the launcher
NON-detached and, on the timeout path, does `child.kill('SIGKILL')` on the
launcher PID — a single-PID signal, not a process-group kill (see the comment at
`_handleExecIntent`, which notes v1 commands were "simple atomic writes with no
grandchildren"). clodex-monitor is the **first** exec command that leaves a
surviving grandchild, so it leans on two facts: (1) the worker is spawned
`detached:true`, which `setsid`s it into its own session/process group, so a kill
of the launcher PID can't reach it; (2) the launcher exits 0 in milliseconds, so
`child.on('exit')` clears the timer and the SIGKILL never fires in practice.
Verified empirically: SIGKILL the launcher mid-stream and the worker keeps
delivering DMs, reparented to launchd (`ppid=1`). If a future change makes the
dispatcher group-kill the launcher, this guarantee must be re-checked.
- The worker streams events back as DMs. The agent needs no new mechanism: DMs
  arrive as `[agent:from <tool>] …` exactly like peer mail. The wire envelope is
  `{from, body, type:'dm'}` — byte-identical to `Transport.static send()`, and
  verified to decode through the real `Transport` receiver into the
  `_onIncoming(from/body/type)` read (agent-transport.js:111-121).
- Per-agent worker state lives under `~/.clodex/monitors/<agent>/` (a shared
  clodex-owned root, 0700), one `<id>.json` per running worker + an `<id>.log`
  for observability.

## clodex-monitor (first tool)

Replaces the CLI's built-in `Monitor` tool. The agent gets an exec grant
instead; the behavior is the same — run a command, and each line it emits
becomes a notification — but the notifications arrive as DMs and the whole
thing is observable in Clodex's IPC log.

Implementation: `scripts/clodex-monitor.js` (launcher + `--daemon` watcher in
one file). Registry: `~/.clodex/library/exec/clodex-monitor.json`.

**Payload (STDIN JSON):**

| field | for | notes |
|---|---|---|
| `action` | all | `start` \| `stop` \| `list` |
| `agent` | all | the invoking seat's own name (v1 — see below) |
| `command` | start | shell command; the COMMAND decides what a status change is (poll+diff, `until`, `grep --line-buffered`), the watcher only forwards its stdout |
| `ws` | start | `{url, protocols?}` — WebSocket source instead of `command`: each text frame is an event, binary frames become a placeholder, close ends the watch with the code surfaced. `protocols` is a comma-separated string (the exec validator has no array type); exactly one of `command`/`ws` |
| `wake` | start | `true` → every event wakes the agent (built-in Monitor behavior). Default: status events are passive |
| `description` | start | short label, shown in every event |
| `persistent` | start | run until the target exits or an explicit `stop` (no timeout) |
| `timeout_ms` | start | default 300000; ignored when `persistent` |
| `id` | stop | from the passive `monitoring started` DM, or `list` |

**Behavior — built-in Monitor parity, minus the turn cost:**

- Each event (stdout line / ws frame) → a DM to the agent, `from: monitor`,
  body `[<id> <description>] <text>`. A burst is coalesced (250ms idle /
  20-line cap, 4000-char slice) so a chatty target doesn't fire a delivery
  per line.
- **Status events are PASSIVE by default** (`delivery:'passive'` on the socket
  envelope): the core parks them to ride the agent's next organic turn (hook
  drains) instead of generating a turn each — this is where the token win over
  the built-in Monitor comes from. `wake:true` opts back into wake-per-event.
- **Administrative events are passive too**: `start` succeeds silently on the
  exec side, and the id + label arrive as a passive `monitoring started` DM;
  `stop` succeeds silently, and the watcher's `stopped` confirmation rides
  passively (the agent asked for it — confirmation, not news).
- Tracked-item STATE CHANGES wake (silence-is-not-success): target exit (with
  the last stderr line on nonzero), ws close (with code), timeout, and the
  firehose auto-stop each send a final waking DM — and that wake's hook drain
  sweeps any accumulated passive ticks along with it. If the agent is gone
  (6 straight delivery failures) the watcher kills the target and exits rather
  than orphaning itself.
- **Firehose auto-stop** (built-in parity): more than 30 notifications in a
  rolling minute kills the monitor with a waking "too noisy — restart with a
  tighter filter" event.
- `list` reaps dead state and returns the running set on one `replyStderr` line;
  `stop` SIGTERMs the worker (which kills the target's whole process group).

**Agent usage:**

```
[agent:exec clodex-monitor] {"action":"start","agent":"<myname>","description":"dev server","command":"until grep -q 'Ready' dev.log; do sleep 0.5; done; echo READY"}
[agent:exec clodex-monitor] {"action":"list","agent":"<myname>"}
[agent:exec clodex-monitor] {"action":"stop","agent":"<myname>","id":"mrp65082gao"}
```

## clodex-team (second tool)

Teams control plane (docs/teams-design.md). `scripts/clodex-team.js`,
registry `~/.clodex/library/exec/clodex-team.json`.

- `roster` (query → replies): resolves the team from the requester's
  registered cwd (registry entries now carry `cwd`; payload `cwd` is the
  old-core fallback) by scanning `~/.clodex/teams/*/team.json` for the one
  whose `root` contains that cwd (deepest wins), and answers one line: team
  name, roles (lead starred) + live agents joined by cwd-in-root. Manifests
  live entirely under `~/.clodex/teams/` — zero clodex droppings in project
  repos (Bogdan ruling 2026-07-19).
- `retire` (command → silent success): delivers a `team-retire` envelope to
  the TARGET's own socket. The core (`_handleTeamRetire`) authorizes —
  requester running, same team root, no self-retire — then archives
  (resumable), tells the owning window to keep an archived row, and confirms
  to the requester PASSIVELY. Refusals wake the requester as loud DMs.
- Spawn has no verb on purpose: `[agent:spawn name:X template:Y]` already
  exists; duplicating it here would be ceremony.

## Granting a seat this tool

Two spawn-time grants (both ride templates / persisted config):

1. add `"exec"` to the seat's `intents` (enables the exec grammar line);
2. add `"clodex-monitor"` to the seat's `execCommands` allowlist.

The coarse intent gate and the fine per-command `execCommands` gate must both
allow — a seat with `exec` but not the command id is refused, and vice versa.

## Known v1 limitations / growth path

- **Invoker identity is self-supplied.** The agent passes its own `agent` name;
  the exec runner doesn't tell the child who invoked it. A small runner change
  (pass the invoking session name via env to the exec child) would let the tool
  drop the `agent` field and remove the wrong-name footgun. This is the one
  change that would touch audited core code; deferred out of v1 on purpose.
- **Delivery is best-effort and ungated.** Waking DMs land via `_deliverMessage`
  directly (the socket path), so monitor events aren't subject to the cost/hold
  DM gate. Fine for status pings; revisit if a tool needs to respect quiet.
- **Passive needs the new core** (`delivery:'passive'` in `_onIncoming` +
  the passive park class in pending-store). An older core ignores the field and
  wakes per event — degraded to noisy, never to dropped.
