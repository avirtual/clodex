# What a Clodex plugin can do

This page is for deciding *whether* to build something. It describes the reach a
plugin has — what it can put on screen, what it can change, and what it can do
for the agents running inside Clodex — in plain terms, with the limits stated as
plainly as the powers.

It is not the contract. [`plugin-api.md`](plugin-api.md) is, and every section
below points into it. Nothing here is a promise the contract does not already
make.

Two shipped plugins are the working evidence, and both are readable in an
afternoon: **Git Branches** (a badge on every session row, a settings panel, an
`[agent:branch]` verb) and **Workbench** (Files, Source Control and Worktrees as
a full overlay off the sidebar).

---

## 1. What a plugin can show

Seven named places. A plugin uses as few or as many as it wants, and each is
drawn by the host from data the plugin returns — you supply text and state, not
HTML, so the app keeps looking like the app.

| Slot | What appears | Good for | §  |
|---|---|---|---|
| Status-bar action | A button beside core's session actions | Acting on the session you are looking at | 6.1 |
| Status-bar segment | A text readout in the same bar | A number or state worth watching continuously | 6.2 |
| Sidebar footer button | A button with a glyph, label and count chip | The front door to your plugin's main surface | 6.3 |
| Session row badge | A small chip on each session row | Per-session state you want visible without clicking | 6.4 |
| Session menu provider | Extra entries in a session's ⚙ menu | Per-session actions that don't deserve a button | 6.5 |
| Settings panel | A form on your row in Manage Plugins | Anything the user should be able to configure | 6.6 |
| Full overlay | A modal surface you own entirely | A real application inside Clodex | 6.7 |

The overlay is the one with no ceiling. Inside its container you build whatever
DOM you like — Workbench runs a file browser, a diff viewer and a worktree
manager in one. The other six are deliberately small, because they sit in
Clodex's own chrome and a plugin should not be able to make that chrome
unrecognisable by accident.

Two behaviours worth knowing before you design around a slot:

- **A visible status-bar segment keeps the bar alive.** Core hides the bar for
  sessions with nothing to show, so a segment is how you get a bar on a plain
  shell session that would otherwise have none.
- **Row badges are drawn synchronously, inside the sidebar's render loop.** You
  return what is in your cache right now and fill the cache in the background.
  The first paint of a badge is therefore blank by design (§6.4 has the pattern
  and the one line that makes it appear promptly).

A plugin also gets core's own toasts (`showToast`), core's diff renderer
(`lib.renderDiffHtml`), and "reveal this in Finder" (`openPath`) — so its errors
and its output look like the rest of the app rather than like a bolt-on.

---

## 2. What a plugin can alter

**The app's appearance, without limit.** A plugin's `style.css` is injected
verbatim into the window as one stylesheet. It is *not* scoped, prefixed or
rewritten, so its selectors match anywhere — including core's own DOM. A plugin
can restyle Clodex entirely. This is a stated property, not a leak (§14): with
the renderer's current isolation settings a determined plugin could do it from
JavaScript regardless, so scoping the CSS would buy tidiness rather than safety.
The practical advice is to keep your selectors under your own class names so two
plugins don't collide.

**Its own settings, and only its own.** Each plugin gets a namespace in the
user's settings file and a private JSON file of its own. It cannot read another
plugin's settings and cannot reach Clodex's real stores — `sessions.json`,
workspaces, peers, teams, the library are all off-limits by construction. A
buggy plugin cannot corrupt your sessions because it cannot find them.

**What a session receives as input.** A plugin can type into a running agent
(§1.3 below). That is the sharpest thing in the API.

**What it cannot alter:** it cannot spawn a session, change a session's command
line, touch another plugin, register its own IPC channel, add an item to the
macOS menu bar, or reach the peer/remote wire. Each of those is a decision with
a reason attached in §13.

---

## 3. What a plugin can do for agents

This is where a plugin stops being decoration.

### 3.1 Add an `[agent:…]` verb

A plugin's engine half can register a new intent verb. From then on, any agent
in Clodex can write `[agent:yourverb …]` in its output and the plugin's handler
runs, with a handle to the seat that emitted the line. This is a genuine
extension of what agents can *do* — the same mechanism `[agent:dm]` and
`[agent:spawn]` use, opened up.

Three properties make it safe to build on:

- **Exactly once per matched line.** Not "usually once". You can put a
  non-idempotent side effect in a handler without a de-duplication guard — the
  only callback in the whole API that earns that.
- **A throw becomes a reply, not a crash.** Your exception is caught and
  injected back to the emitting agent as an error line. Throwing *is* the error
  channel.
- **Always privileged.** A verb is off for every seat until the operator ticks
  it in that session's intent checklist. There is no way to ship one enabled by
  default. The consequence to expect: a freshly installed plugin's verb is inert
  everywhere, silently, and looks exactly like a broken registration. Say so in
  your README — every user hits it once.

Verbs share **one global namespace** across every installed plugin, so picking a
generic one (`run`, `sync`, `open`) is a latent conflict with a plugin that does
not exist yet. `gitbranch`, not `branch`.

### 3.2 React to sessions coming and going

`onCreate` and `onExit` are the complete lifecycle set. They fire synchronously,
they are contained if they throw, and `onCreate` fires for sessions restored at
launch as well as fresh ones.

What there is *no* notification for: anything about a session's world changing
underneath it — a `git checkout`, a file appearing, a branch renamed. Nothing
tells the plugin, and nothing tells Clodex either, so the gap is detection
rather than delivery. The practical consequence, and it bounds what is worth
building: **the freshness of anything a plugin caches is set by how often it
re-asks, not by when the data changed.** Plugins that *report* are
straightforward. Plugins that must be instantaneously *correct* are not.

### 3.3 Type into a running agent

`inject(text)` writes into a session's input as if the operator had typed it. By
default it is parkable — if the agent is mid-turn, the text waits and arrives
with its next turn instead of interrupting.

This is the narrowest part of the API and the easiest to misuse, because it
reads as "send a message" and is actually "type at a prompt". Four consequences,
all covered in §4:

1. A newline in your text may submit it early, splitting one message into
   several. Collapse to a single line before you call.
2. Queued injects are flushed as one newline-joined turn, so two individually
   fine calls can merge into a multi-line payload subject to rule 1.
3. Anything not a string is coerced, never rejected — `inject(null)` types the
   word `null` into the user's prompt.
4. It is fire-and-forget and returns nothing. Written, queued, parked and
   dropped are indistinguishable from the caller. If your plugin needs to know
   its text landed, it has to observe the agent doing something.

### 3.4 Ship skills and subagents

A plugin folder can carry `skills/<name>/SKILL.md` and `agents/<name>.md`, and
every seat that has the plugin gets them — namespaced by the plugin's id, so the
skill is invoked as `/<plugin-id>:<skill>` and the agent is delegated to as
`<plugin-id>:<agent>`. This is the one capability with **no code at all**: a
manifest naming neither half is valid when the directory carries one of those
directories, so a pure content pack is a legal plugin.

It is also the one place where a plugin changes what an agent can *reach* rather
than what it can *do to Clodex*, and the reach is real — a skill is instructions
the seat loads, an agent is a subagent it can delegate to.

Three properties bound what to build on it:

- **Per seat, by the plugin tick.** A seat whose plugin list excludes the plugin
  never sees either. Content follows the plugin, and there is no per-skill switch:
  the checklists and library drawers show a plugin's skills and agents as
  read-only rows under its name.
- **Bound at spawn.** They are written when the seat starts, so enabling or
  disabling the plugin — or editing the files — reaches a running seat only at its
  next start.
- **A bad entry costs only itself.** A name that fails `AGENT_NAME_RE` or a skill
  directory with no readable `SKILL.md` is skipped with a logged reason; the rest
  of the bundle loads.

The layout, the name rule and the visibility rule are in
[`README.md`](README.md); the manifest half of it is §2 of the contract.

### 3.5 Read a session's context and telemetry

A plugin can list sessions (globally or per workspace), get a handle with
`name`, `type`, `cwd`, `workspaceId` and liveness, ask `fsScope` for a session's
working directory, and pull a read-only telemetry snapshot for sessions running
through Clodex's wire proxy. `fsScope` refuses peer sessions outright — a plugin
routing its filesystem work through it cannot accidentally read a peer machine.

Be precise about what that refusal covers, because two things sound like it and
are not true: it does not scope workspaces, and it does not confine paths to the
cwd it hands you. Both are the plugin's job (§14).

Git work specifically is lent from core: `host.lib.gitWorktree` gives seven
functions for repo detection, branch discovery, and creating or removing
worktrees — the same code Clodex uses itself.

---

## 4. The one thing plugins cannot reach, and it is the interesting one

**A plugin cannot see what an agent said.** Not the turn text, not the thinking
blocks, not the transcript. Clodex parses agent output for intents in three
places, and all three terminate inside core; there is no `onTurn`, no transcript
reader, and no event carrying turn content.

So the class of plugin that is *not* currently writable includes: a thinking-log
recorder, a turn archiver, a cross-session search over what agents actually
said, anything that summarises or grades a turn, and anything that reacts to
agent output other than through an explicit `[agent:…]` verb the agent chose to
write.

The workaround that exists today is the verb: an agent can *tell* a plugin
something by emitting an intent. That is cooperative rather than observational —
useful, and a genuinely different thing.

Whether to open a turn-content surface is an open design question, not an
oversight. The honest reason it is still open: the source that carries thinking
blocks in full is the wire proxy, the fallback source (transcript files) is
lossy, and a surface built on only the first would be silently empty for some
session types — which is worse than not having one.

---

## 5. What the host guarantees you, as a user of plugins

- **Every plugin can be turned off**, from Plugins ▸ Manage Plugins…, and
  disabling one removes its UI from every open window immediately.
  `CLODEX_PLUGINS=0` skips the plugin system entirely — the app is required to
  work with none of it loaded.
- **A crashing plugin does not take the app down.** Its `activate()` throwing is
  logged and skipped; after two consecutive failed launches it is held back
  until you press Retry.
- **A plugin's verb does nothing until you grant it**, per seat.
- **There is no sandbox.** An engine half runs with the app's full privileges.
  The host API is a *contract* — it exists so plugins are removable, versionable
  and uncoupled from core internals, not so a hostile plugin is contained. Treat
  installing a plugin as running its author's code, because that is what it is.

---

## Where to read next

- [`plugin-api.md`](plugin-api.md) — the contract, and the authority on
  everything above.
- [`README.md`](README.md) — how to build one, and where it goes.
- [`tools/README.md`](tools/README.md) — scaffold a valid plugin and verify it
  against the real host in three commands.
