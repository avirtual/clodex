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
the agent is one line via `replyStderr` — the LAST stderr line, kept from its
start however long it runs and sliced to 200 chars, which suits a digest and
destroys a listing. A command whose answer is irreducibly multi-line (a ticket
board, one error per bad file) opts into a wider reply with `replyMaxBytes`:
whole lines from the TOP of stderr up to that budget, then a `(+N more lines
dropped …)` note when it overflows (`(+N or more lines dropped — output also
outran the collector)` when the collector cut it) and, when collection was
complete, the LAST stderr line kept as a footer. Opt-in per def, because the
default is what keeps a chatty command from billing its progress log into the
caller's prompt on every call.

That makes exec an excellent **control plane** and a useless **data plane** —
which is the exact split most "tools" want. The trick, for any tool that
produces ongoing output, is to run the real work in a **detached worker** and
have the worker deliver results back to the invoking agent as DMs over its
`run/<agent>/agent.sock` socket (`{from, body, type:'dm'}` — the same
"message from outside clodex to an agent inside" path wake scripts use). This
is that channel.

**The shape of a clodex tool, generalized:**

- The exec launcher is the control plane: `start` / `stop` / `list` verbs,
  validated by the entry's `schema`. The schema subset is `object` (with
  `required` / `properties` / `additionalProperties:false`), `string`
  (`minLength` / `maxLength` / `enum`), `number` / `integer` (`minimum` /
  `maximum`), `boolean`, `filename`, and `array` (`items` / `minItems` /
  `maxItems`). Message discipline: **queries reply**
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
`_handleExecIntent`: detached:true "would add no group kill while risking
orphaned grandchildren on timeout"). clodex-monitor is the **first** exec command that leaves a
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
  `SessionManager._onIncoming` from/body/type read.
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
| `ws` | start | `{url, protocols?}` — WebSocket source instead of `command`: each text frame is an event, binary frames become a placeholder, close ends the watch with the code surfaced. `protocols` is a comma-separated string; exactly one of `command`/`ws` |
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
- A watch dies with the host when a restart kills its watcher. On restore,
  `deliverLostMonitors` (session-manager.js) sends the seat one `reboot` DM
  naming each killed watch (`[host] since your last turn: these runs of yours were
  killed and did not finish: <id> <description|command> (started <ISO>); …
  Nothing was re-run.`) and removes their state once the DM is written or parked,
  so `list` never reports them; a failed delivery keeps the state for the next restore.
  Long exec runs a restart kills get their own `lost to a host restart` line.

**Agent usage:**

```
[agent:exec clodex-monitor] {"action":"start","agent":"<myname>","description":"dev server","command":"until grep -q 'Ready' dev.log; do sleep 0.5; done; echo READY"}
[agent:exec clodex-monitor] {"action":"list","agent":"<myname>"}
[agent:exec clodex-monitor] {"action":"stop","agent":"<myname>","id":"mrp65082gao"}
```

## clodex-team (second tool)

Teams control plane. `scripts/clodex-team.js`, registry
`~/.clodex/library/exec/clodex-team.json`.

- `roster` (query → replies): resolves the team from the requester's
  registered cwd (registry entries now carry `cwd`; payload `cwd` is the
  old-core fallback) by scanning `~/.clodex/teams/*/team.json` for the one
  whose `root` contains that cwd (deepest wins), and answers one line: team
  name, roles (lead starred) + live agents joined by cwd-in-root. Manifests
  live entirely under `~/.clodex/teams/` — zero clodex droppings in project
  repos.
- `retire` (command → silent success): delivers a `team-retire` envelope to
  the TARGET's own socket. The core (`_handleTeamRetire`) authorizes —
  requester running, same team root, no self-retire — then disposes of the
  seat from two facts: a seat whose persistence record carries
  `ephemeral: true` (stamped at spawn by the path that knew — the ticket seat
  and the review reservation), **or whose name matches no manifest role at
  all**, is discarded (killed, record dropped, name immediately reusable); a
  seat filling a named role is archived (resumable, and the name stays taken).
  The record is the single source of ephemerality — the role schema carried a
  second copy that could disagree with it, and no longer does. A discard takes
  the seat's worktree with it, so it is gated on that tree being CLEAN: an
  uncommitted diff, an untracked file, or a tree git cannot read downgrades the
  discard to an archive and tells the requester which tree and why (commit, then
  retire again). The confirmation names what happened to the checkout; the
  flat "state lives in its task artifact" remains only for a discard with no
  worktree removed and no removal error. It
  tells the owning window either way and confirms to the requester PASSIVELY;
  refusals wake the requester as loud DMs.
- `tickets` (query → replies): the team's ticket board, `filter` one of
  `open` (default) / `done` / `cancelled` / `all`. This is the one command
  whose answer does not fit a line, so its def carries `replyMaxBytes`; a
  large enough board still comes back head-clamped with a dropped-lines note
  and its last line kept as a footer.
- `cost` (query → replies): what this team has spent, read back out of
  `~/.clodex/teams/<team>/cost.jsonl` (docs/teams.md). One line — the total,
  since the earliest row, split into tickets, review rounds and standing seats,
  with a count of the tickets whose spend could not be attributed to one seat.
  Those are EXCLUDED from the total rather than summed as zero, which is the
  same doctrine `COST.json` follows: a ticket nobody could price is unknown, not
  free. With `target:<ticketId>` it answers for one ticket instead — the hand
  figure, each review round, and their sum.
- Spawn has no verb on purpose: `[agent:spawn name:X template:Y]` already
  exists; duplicating it here would be ceremony.

## Granting a seat this tool

Two spawn-time grants (both ride templates / persisted config):

1. add `"exec"` to the seat's `intents` (enables the exec grammar line);
2. add `"clodex-monitor"` to the seat's `execCommands` allowlist.

The coarse intent gate and the fine per-command `execCommands` gate must both
allow — a seat with `exec` but not the command id is refused, and vice versa.

A subagent reaches the same grants through the seat's `clodex-send` shell verb, limited to
the seat's `execCommands` (docs/messaging.md §7b).

## clodexctl through exec

Three seeded entries run clodexctl verbs against a peer node's context. The
first two (read, seats) spawn nothing: `"inProcess": "ctl"` makes `_handleExecIntent` validate the
payload against the entry's schema and then call `_handleCtlIntent` with
`{ctx, line: verb + ' ' + args}`, so the run happens in ctl-service inside the
main process. `~/.clodex/cli/contexts.json` and its tokens never leave the main
process; the seat gets the rendered output back, scrubbed by ctl-service and
clamped to the entry's `replyMaxBytes` (12000). The run uses the same
ctl-service as the operator's drawer ctl tab: it takes over the tab's one warm
connection, and a slow run queues the tab's next command behind it.

| Entry | `verb` enum |
|---|---|
| `clodex-ctl-read` | help, get, describe, query, logs |
| `clodex-ctl-seats` | help plus the read verbs plus create, patch, restart, dm |
| `clodex-ctl-admin` | help, deploy, upgrade, restart (node) — argv launcher + detached worker; undeploy and delete (session) when the operator adds them to the enum |

`help` is the on-demand grammar: `{"verb": "help", "args": "<verb>"}` returns clodexctl's own usage text for that verb, rendered locally without dialing the node. An operator who already edited an entry (the seeder never overwrites an edited copy) adds `"help"` to its `verb` enum by hand.

Payload: `{"ctx": "<context>", "verb": "<verb>", "args": "<rest of the line, ≤400 chars>"}`.

**The operator fills the `ctx` enum.** Every entry ships with `"enum": []`, and
an empty enum refuses every payload (`payload.ctx: the enum is empty — …`). To make a context reachable, edit
`~/.clodex/library/exec/clodex-ctl-read.json` (or the team copy) and list the
names, e.g. `"enum": ["ios"]`. An entry names what it may touch. Your edit
survives app updates (the seeder never overwrites an edited file).

**The grant is the gate.** Add the entry id to the seat's `execCommands`. The
exec path does not need `ctl` in the seat's `intents`; the `[agent:ctl]` row is
a separate privileged intent for templates that opt in, with no verb tier of its
own.

### The admin tier (clodex-ctl-admin)

`clodex-ctl-admin` is an argv entry (`${CLODEX_BIN}/clodex-ctl-admin.js`), not
`inProcess`: the dispatcher checks the grant and the schema, then runs a short
launcher that validates the payload, takes a lock and starts a detached worker;
the worker runs clodexctl and reports by dm. The dispatcher hands the launcher
`CLODEX_SEAT` (the invoking seat), `CLODEX_NODE` (the app's interpreter) and
`CLODEX_CTL` (the CLI script); clodexctl runs as
`ELECTRON_RUN_AS_NODE=1 $CLODEX_NODE $CLODEX_CTL …`, so it works from the DMG's
`app.asar` as well as a checkout.

Pre-created contexts only. The seat names a context listed in the enum; the
locator comes from its record in `~/.clodex/cli/contexts.json` (`deploy.flavor`
and its fields when present, else inferred: `ssh` → ssh installer, `ssm.target`
→ ssm, `kubectl.target` → helm; `--docker` only when the record says
`deploy.flavor: docker`; url / tunnel / gcloud / az records are refused). The
fresh-box flow: the operator runs `clodexctl create node X --ssh user@host`,
lists `X` in the entry's enum and grants the seat; the seat runs `deploy`.
Hazard: a remote docker node saves the same `{ssh}` record as an ssh-installer
node, so a `deploy` on an unstamped record would install a second Clodex beside
the container — let one terminal deploy stamp `deploy.flavor` first, or do not
list that context. An ssm re-deploy rotates the wire token.

Every run is forced non-interactive: `deploy` gets `--force -o json` plus the
record's locator, `upgrade` `-o json`, `restart node` `--ctx <ctx> --force -o json`,
`undeploy` `--force --keep-ctx -o json`. Agent flags are a per-verb allowlist —
deploy: `--branch --tag --image --set --param --subnets --security-group
--assign-public-ip --persistent --use-bedrock --no-wirescope --force-conflicts
--dry-run`; upgrade: `--tag --image --branch --set --subnets --security-group
--assign-public-ip --persistent --force --dry-run --force-conflicts`; restart:
none; undeploy: `--keep-data --dry-run --wait`. Locator and credential flags
(`--ssh --ssm --host --url --token --ctx --tunnel --region --profile --target
--src --repo --env-file --import` …) are refused by name. `--image`, `--set` and
`--param` are the widest knob: a granted seat chooses the image. `--dry-run` is
the agent's own evidence step before a real run.

Runs live under `~/.clodex/ctl-runs/`: `<seq>.log` (redacted stream) and
`<seq>.json` (outcome `running|ok|failed|unknown`). One run per context at a
time; a second submit is refused naming the live seq. Progress dms from
`ctl-admin` are passive and at most one per 30 s; the result dm (exit, last
lines, log path) wakes the seat. A worker that dies without a result (machine
reboot, `kill -9`) is reported `outcome UNKNOWN` by the next sweep — on any
launcher call and once at app boot — and nothing is ever re-run. There is no
cancel in v1: `kill` the pid in `<ctx>.lock`. `[agent:exec status]` does not
list these runs; the launcher exits too fast to be tracked.

The worker runs outside every seat sandbox: the launcher is a child of the
Electron main process, not of the seat's CLI, so the worker reads
`contexts.json`, `~/.ssh`, `~/.aws`, `~/.kube` and the app's PATH while the seat
holds none of them. The seat CAN read `~/.clodex/ctl-runs/`, so every log line,
dm, recorded argv and reply is redacted: every context token of 8+ chars, any
48-hex string, `token=` / `"token":` / `CLODEX_REMOTE_TOKEN=` values and
`Authorization: Bearer` headers become `***`. `CLODEX_CLAUDE_TOKEN_FILE` in the
app's own environment is honoured by a fargate deploy.

The dial: the shipped verb enum is help, deploy, upgrade, restart. To allow
`undeploy` or `delete session <name>`, the operator adds `"undeploy"` / `"delete"`
to `verb.enum` in `~/.clodex/library/exec/clodex-ctl-admin.json` (or the team
copy); the launcher already knows both spellings, and the seeder never
overwrites the edited file.

**Refused, by tier:**

| what | in-process tiers (`clodex-ctl-read/seats`, `[agent:ctl]`) | admin tier |
|---|---|---|
| create / delete / use node | `ctl: <verb> is operator-only` | refused (`create`, `use` are not tier verbs; `delete node` is operator-only) |
| delete session, restart node | deferred by ctl-service, and are the admin tier's business | `restart` shipped, `delete session` by enum edit |
| attach, port-forward, web, exec, input | operator-only | not tier verbs |
| logs --follow | operator-only | `logs` is not a tier verb |
| `--import` | operator-only | operator-only on this tier |
| `--ctx --url --token --ssh --remote-port --tunnel` | refused: they would re-target the context | refused, with `--ssm --host --src --repo --claude-token-file --env-file --ssh-opt --profile --region --target --token-file` |
| deploy, undeploy, upgrade | operator-only | the tier's purpose |

The in-process node checks read the positionals the CLI's own parser yields, so
a flag in front of the resource word does not hide it.

## Terminal commands inside an open session

`[agent:term exec]` is the other capability an operator grants a seat, and since
t1008 it reaches INSIDE a session already open in the Terminal tab — an `ssh`, a
`sudo -i`, a `docker exec`, a nested shell. The agent types no connection of its
own: Clodex recognises the program holding the tab (`term-host.js`), types one
in-memory hook installer into the far shell, and from then on the far shell's own
marks frame the command exactly as the local ones do, so the agent gets a real
exit code and real output with the report naming the session it ran in. It is OFF
by default and switched on in Settings ▸ Terminal, separately from command
reporting: driving a session the operator authenticated to is its own consent,
and no upgrade grants it. A far editor or pager on the alternate screen, and any
program that is not a shell, still refuse by name with nothing typed.
A closed tab no longer refuses: the shell is opened on demand in the seat's cwd
and shows in the tab, with its output, when the operator opens it.

Sent through the seat socket (the `clodex-send` CLI, or any caller inside the reply
scope), the result is the socket reply in the same turn, the same text the DM
would carry; typed in a turn it is still the `[terminal]` DM. The reply waits 130 s
against the terminal's 120 s silence notice, so for a long command the notice is
the in-turn answer and the eventual output follows as a DM. A disconnect after the
result was accepted into the reply loses it: completion and output are unknown,
so look at the terminal and do not re-run it automatically.

The same command is the `term_exec` MCP tool (`{command}`), listed in the seat's
`tools/list` only while `term` is granted; its result is the same `[terminal]`
text. It is main agent only, proven per call by the PreToolUse stamp: a
subagent's or an unstamped call answers `unknown tool: "term_exec"`.

`[agent:term read] [tail N | grep <regex>]` reads the seat's own terminal tab's
scrollback (the captured buffer, ANSI and `\r` stripped) and answers in the same
turn, not as a `[terminal]` DM. Bare is `tail 50`; `tail N` clamps N to 1..400;
`grep <regex>` returns the last 50 matching lines, each prefixed `L<n>:` counting
from the end of the buffer (`L1:` = most recent). The pattern is capped at 200
characters and runs under a 1 s budget; a bad one is refused with the RegExp
error. The answer is capped at 16 KB, cut from the head, and says so. A tab never
opened, or whose shell has exited, is refused `no terminal: open your terminal tab first`, and a host with
no terminal tabs `no terminal on this host`. The `term_read` MCP tool
(`{tail?, grep?}`, not both) maps to the same verb, main agent only like
`term_exec`.

## Known v1 limitations / growth path

- **Invoker identity is self-supplied for monitor and team.** Those tools take
  the agent's own `agent` name, so the wrong-name footgun stays open there. The
  runner now passes the invoking seat as `CLODEX_SEAT` to every argv exec child;
  `clodex-ctl-admin` reads it and takes no `agent` field.
- **Delivery is best-effort and ungated.** Waking DMs land via `_deliverMessage`
  directly (the socket path), so monitor events aren't subject to the cost/hold
  DM gate. Fine for status pings; revisit if a tool needs to respect quiet.
- **Passive needs the new core** (`delivery:'passive'` in `_onIncoming` +
  the passive park class in pending-store). An older core ignores the field and
  wakes per event — degraded to noisy, never to dropped.
- **A long run is no longer silent.** A def whose `timeoutMs` is at least 60 000
  injects one start line naming the run number, the child pid and the ceiling,
  then a "still running" line with the elapsed time every `statusEveryMs`
  (optional def field, integer ≥ 30 000, default 3m), and stamps its result with
  the same `run #<seq>`. Shorter runs stay silent whatever the def says, so a
  10-second command pays no prompt tax to say it started.
  A `clodex-run-tests` run that finds the suite lock held queues behind the
  holder (up to 15 min) and its status pings say so; the agent never re-emits
  or schedules a reminder for it.
- **`[agent:exec status] {}` is a reserved name, not a registered command.** It
  answers from `session.execRuns` (last 3 runs, newest first, or one via
  `{"seq":N}`) without a grant and without spawning; a registry def named
  `status` is shadowed by it and unreachable. A run in flight at a host restart
  is reported to its seat as lost and must be re-emitted; the relaunch gate
  waits for in-flight runs up to 10 minutes.
