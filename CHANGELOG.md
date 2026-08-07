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

- **Fixed the documented syntax for running a command in your terminal tab.**
  The help text told agents to write `[agent:term exec <command>]`, with the
  command inside the brackets. That form has never worked: the command belongs
  *after* the closing bracket, as `[agent:term exec] pwd`. An agent following
  the instructions literally ran no command and was told only that the intent
  was unrecognized. The help now shows the working form, and its own prose no
  longer contradicts it.

  Only agents granted the terminal intent ever saw the wrong line, so most
  sessions were never affected. Those that were get the correction as a protocol
  diff on their next turn rather than a rewritten prompt.

- **A mistyped `[agent:term …]` now says what the right form is.** Agents that
  get the brackets wrong were told only that the intent was unrecognized, next
  to a list of valid intents that included `term` — which reads as "the verb was
  fine" and sends them hunting for the wrong problem. The bounce now names the
  correct form for that specific mistake. It never guesses at the command and
  never runs one: it explains and refuses.

- **Writing a terminal command no longer breaks when the agent keeps talking.**
  A command ended at the closing bracket in the documentation but not in the
  code: whatever the agent wrote on the lines below was pulled into the command,
  which was then refused for spanning multiple lines. So a correctly written
  command failed because of the sentence after it, and the agent had to know to
  close it with `[agent:end]`. The command now ends where its line ends, as the
  instructions always said. A trailing `[agent:end]` is still accepted and does
  nothing.

  One form stops working: putting the command on the line *below* the bracket.
  That was never in the agent instructions — only in an error message you saw
  after already getting it wrong — and it now produces a refusal naming the
  form that works.

## 5.1.0 — 2026-08-07 — Terminals reach further, and a lost message finally arrives

- **The "Clodex is back" notice now actually reaches the agent that asked for
  the reboot.** An agent that restarts Clodex makes itself inert in the process,
  so it gets told when the app is running again. That notice has existed for a
  while and had never once been delivered — seven restarts, seven log lines
  saying it was handled, nothing arriving.

  The cause was a promise being mistaken for a receipt. The notice was handed to
  the message store for the restarted agent and then deleted from disk in the
  same breath, as though handing it over were the same as it landing. It isn't:
  the agent's CLI is still redrawing a long conversation at that moment, and a
  message delivered into that window can vanish with no copy left anywhere. Now
  the notice is kept until the agent demonstrably takes a turn, and re-offered
  in the meantime — twice, spaced to clear the startup window, then given up on.
  Worst case you see the same one-line notice twice; it carries its own
  timestamp, so a late duplicate reads as harmless. Notices older than 7 days
  are still dropped rather than delivered.

  To be plain about what this is: nothing in the stack can confirm a message was
  received, so this is a bounded retry, not a guarantee. It is labelled that way
  in the code too, because reading "handed over" as "delivered" is the exact
  mistake that hid this for seven restarts.

- **Deliveries that go missing now say so.** Several paths could claim a queued
  message off disk and then fail to deliver it, leaving no trace in the log —
  which is why the bug above survived as long as it did. Those paths now record
  when a claim comes up empty. This is diagnostic only; nothing changes about
  what gets delivered.

- **`[agent:term exec]` works on bash now, not just zsh.** Until now an agent
  asking to run something in your terminal was refused outright unless your
  shell was zsh — bash could be typed into, but nothing could tell the agent
  what a command had printed or what it exited with, so the feature declined
  rather than run something blind. bash is the default on most Linux
  distributions, so that was a large share of people getting nothing.

  It needs **bash 4.4 or newer**, and the reason is worth stating because macOS
  is the awkward case: Apple still ships bash **3.2** as `/bin/bash`, which
  lacks the hook this relies on. If that is your `$SHELL`, the agent's refusal
  now tells you the version you have and the version you need rather than
  suggesting you switch to zsh. A newer bash from Homebrew works.

  One honest caveat. Reporting requires us to start bash with our own startup
  file, and bash refuses to combine that with being a login shell — the two are
  mutually exclusive, unlike zsh where they are not. So the terminal tab
  *reconstructs* what a login shell reads: `/etc/profile` first, then the first
  of `~/.bash_profile`, `~/.bash_login` or `~/.profile` that exists, exactly as
  bash itself would. Your PATH and aliases come through. What differs is that
  `shopt -q login_shell` answers false, so a startup file that branches on it
  takes the other path. We would rather tell you that than fake the flag. As
  always, nothing under your home directory is written or modified, and if any
  of this cannot be done the terminal opens as an ordinary shell with reporting
  switched off — never a broken one.

- **The drawer's terminal now works over the web too.** 5.0.0 said the term tab
  exists only in the desktop app; that has changed, and the reason it changed is
  that the restriction never bought anything. A Clodex reached over the web can
  already open a session of type *bash*, which is a login shell on that same
  machine started by that same person — so refusing the drawer's terminal
  refused a tab, not a capability. The two doors now agree.

  Attaching from a browser gives you **the same shell the desktop drawer has**,
  not a second one: one process per window and seat, and a tab that joins it is
  handed the scrollback so far, exactly as re-opening the drawer on the desktop
  is. That is deliberate — the alternative, a blank pane on a live shell, hides
  a half-typed line or an open pager rather than protecting anything, since the
  history in question is your own and the machine is the one you are already
  signed in to.

  Two things deliberately did *not* change. The **ctl console** stays
  desktop-only: it runs clodexctl verbs, which is a different question from a
  shell. And a terminal **on a peered machine** stays desktop-only too — that
  one reaches a third box, which nothing else on the web surface can do.

## 5.0.0 — 2026-08-07 — The drawer grows up, and terminals get shared

- **Text you select in the drawer can ride along to the agent.** Off by default,
  behind its own preference. With it on, highlighting text in any drawer tab —
  the terminal, the ctl console, the activity feed — offers it to the active
  session, and there are two gestures with two different meanings. *Selecting*
  is ephemeral: it rides the next request only, is never cached, expires on its
  own, and is gone whether the agent used it or not. *Copy* is deliberate and
  permanent: it lands in the session's transcript, where the agent can refer
  back to it for the rest of the conversation. The split is deliberate — a
  highlight is a glance, a copy is a decision — and this is separate from the
  memory hints, which offer an agent things it wrote itself; this forwards what
  *you* highlighted, which is a different consent decision and so has its own
  switch.

  Copy works from every drawer tab now, not just the console, and it takes your
  selection rather than the whole pane — selecting a few lines in a 200-block
  console and pressing Copy used to overwrite the clipboard with all of it, and
  you only found out when you pasted. It also tells you what it copied, with a
  byte count, since a clipboard write can fail silently and look exactly like
  one that worked.

  A **📋** button in the drawer header shows what is actually riding your next
  message: the selection, anything queued, and the memory hints sharing the same
  block. It deliberately reports what the proxy holds and what Clodex believes
  *separately* instead of reconciling them into one answer — during development
  the two disagreed, with text on the wire while the status line said nothing
  was armed, and an inspector built on the same belief as the status line would
  have repeated that with more authority.

- **The status bar moved to the bottom of the window**, below the drawer instead
  of above it. It had been colliding with a tall drawer and getting painted over.

- **The ticket board shows the newest tickets first.** It used to sort
  quietest-first to surface stalls by position, but a stalled ticket already
  announces itself, so the ordering only meant the ticket you just filed landed
  at the bottom of a growing board.

- **`ctx` commands work without the prefix in the ctl console.** `list` does
  what `ctx list` does, in a pane whose status line already shows which context
  you are in. Real verbs always win, so nothing is shadowed.

- **`ListAgents` is now in the tool list**, so it can be turned off per session
  like the rest. Anthropic added it to the CLI; until it was listed here,
  unticking it would have had no effect, because a tool Clodex doesn't know
  about can't be put on a session's deny list.

- **A Terminal tab for a peer's session — a real shell on their machine.** Off
  by default, and the machine that would host the shell is the one that decides:
  tick "Allow terminal sharing" on a peer in its info popover. Until someone
  ticks it, a peer session's Terminal tab simply says the other box has not
  enabled it. With it on, the tab works the way the local one does — you type,
  you see output, resizing follows your window.

  It is the *same* shell the operator of that machine sees in their own Terminal
  tab for that session, not a second private one. That is deliberate: a shell
  running on someone's machine that they cannot see is the thing to avoid, and
  sharing the terminal makes their view of it impossible to lose. Closing your
  tab detaches your view and leaves their shell alone.

  The grant is visible while it lasts, not just at the moment you give it: the
  peer's header carries a marker for as long as terminal sharing is on, and both
  machines log the opening and the closing to the IPC log. Turning it off closes
  any shell already open, immediately, and the other end is told it was revoked
  rather than being left to think the network dropped.

  Separately from the grant, the session in your sidebar is marked for as long
  as someone is actually watching its terminal, and the mark clears when they
  leave — including when their connection simply drops. Opening the shared
  terminal starts the shell if it wasn't running, so a peer can be in a shell on
  your machine with no tab open for it on your screen; this is the marker that
  says so. Reconnects of a viewer who was already there stay quiet in the log,
  so a flaky link doesn't bury the openings that matter.

  Alongside the per-session mark there is a standing notice at the bottom of the
  sidebar whenever anyone is in one of your terminals, naming the session. The
  mark rides a session row, and a row is not always there to ride — you might
  have archived the session, filtered it out of the list, or be looking at a
  different workspace. The notice doesn't depend on any of that. Killing or
  archiving a session also ends the peer's view of its terminal, told to them as
  a close rather than a dropped connection; the shell itself keeps running,
  since it's yours.

  That mark is a precondition, not a decoration: keystrokes and resizes from a
  peer are refused unless that peer's box has the terminal open, so there is no
  way to type into one of your shells without the marker being on. And if you
  close the window a shared shell belongs to, the peer watching it is told the
  terminal was closed rather than being left with a pane that has quietly
  stopped — after which the peer cannot start a new one there either. Sessions
  outlive their window, so without that a peer could open a shell in a workspace
  you had closed, and every surface that would tell you — the mark, the tab, the
  log row — lives in the window that isn't there.

  On your side of a peer's terminal, if their box goes offline or they withdraw
  the grant while you have the tab open, the pane says so instead of going
  quietly inert.

  One thing worth being clear about, because the checkbox sits next to a
  particular peer: the switch is per peer as a *record of what you intended*, but
  what it turns on is a capability of your machine's wire. Clodex's peer wire has
  no cryptographic caller identity — it binds to loopback and the SSH tunnel is
  the boundary — so anyone who can reach that tunnel can use the capability while
  it is on. Treat it as "terminal sharing is on for this box", and turn it off
  when you are done.

- **Security fix: plugins could write files and run destructive git operations
  from the browser client.** When you serve Clodex to a browser, that connection
  is deliberately denied some of the sharper desktop capabilities. Plugin
  methods slipped past that line: an authenticated browser session could call
  *any* method of *any* loaded plugin, which for the built-in Workbench meant
  writing arbitrary files, committing, discarding changes, checking out
  branches, pushing, and creating or removing worktrees in any session's
  directory. Those now refuse from the browser and work only in the desktop app;
  reads — the file tree, file contents, `git status`, diffs, branch and worktree
  listings — are unaffected, so the browser Workbench still shows you everything
  it did before.

  This covers plugins only. Clodex's own file editing and session controls are
  unchanged and still reachable from a browser, so the browser surface remains
  a privileged one: only give the address and token to someone you would hand
  the machine to.

  Plugins now say which of their methods a browser may call, and the default is
  none. A third-party plugin with a browser-facing UI needs one line in its
  manifest to keep working there; the built-in plugins are already updated. If
  you only ever use the desktop app, nothing changes.

- **The agent can run a command in the terminal you are watching.** Off by
  default, and granted per session: tick "Run commands in the seat's terminal"
  in the session's intents list. With it on, the agent can type one command into
  its own Terminal tab — you see it run, in your shell, with your aliases and
  your history — and gets the output back. It is for the moment you hand a
  debugging session over but still want to watch: the agent drives, the terminal
  is still yours.

  The safeguards are the interesting part. It only ever reaches the terminal of
  the session that asked, never yours or another session's. It refuses rather
  than guesses: if the tab is not open, if something is already running in it, if
  a full-screen program like an editor or a pager has the terminal, or if the
  command is anything other than a single line, the agent is told why and nothing
  is typed. It never opens a terminal on your screen by itself. And it always
  gets an answer — if you Ctrl-C the command, close the tab, or the command is
  still going after two minutes, the agent is told that instead of waiting
  forever. A command that outruns the two minutes is *not* cancelled; it keeps
  running and its output arrives when it finishes.

  Two things it is careful about, both cases where the terminal is yours and the
  agent arrived mid-thought. If you had half a command typed at the prompt, that
  line is abandoned first — the same Ctrl-C you would press yourself — so your
  fragment can never end up joined onto the agent's command and run, whichever
  keybindings you use. And if you started something a fraction of a
  second before the agent's command arrived, the agent is told the terminal
  reported a *different* command finishing rather than being handed your result
  as if it were its own.

  The command itself must be plain text: anything invisible in it — a control
  character, a zero-width space, a right-to-left override — is refused rather
  than quietly removed, because the whole point is that the line you watch is the
  line that runs.

  Reporting must be on for this to work, since it is the same completion marks
  that carry the result back. If it is off, or your shell is not zsh, or the tab
  was opened before you turned reporting on, the agent is told which of those it
  is rather than running the command blind.

- **The agent can see what you run in its terminal.** Off by default;
  Preferences → "Report the commands I run in a session's terminal". With it on,
  each command you run in a session's Terminal tab is reported to that session's
  agent: the command line and its exit code, plus the tail of the output when it
  failed. A command that succeeded sends its line alone — a build that prints
  four thousand lines and works is not news. Reports ride along with your next
  message rather than interrupting, so they cost nothing until you say something.
  Nothing is sent for the shared terminal when no session is selected.

  This works by adding a small generated startup file to the terminal's shell so
  it can mark where each command begins and ends (the OSC 133 convention iTerm2
  and VSCode use). Your own `.zshrc` is sourced normally and is never modified.
  Requires zsh; another shell simply gets an ordinary terminal with no reporting.

- **The Terminal tab now hides itself where it made no sense.** A bash session is
  already a shell, so the drawer offered it a second, unrelated one. Worse, a
  peered session showed a terminal running on *your* box rather than the peer's —
  and every peer session in a workspace was quietly sharing that one shell. The
  tab now appears only for sessions it can actually serve. A terminal on the peer
  itself is a separate feature and is not in this release.

- **Each session gets its own terminal.** The drawer's Terminal tab used to be
  one shell per window, so switching sessions left you in the previous one's
  shell and directory. Every session now has its own, opening in its own working
  directory and keeping its own scrollback, and switching sessions switches
  shells. A session's shell ends when the session is deleted.

- **The drawer can be made taller.** A **⇕** button in the drawer header swaps
  the proportions — the drawer takes about 70% of the window and the session
  terminal keeps the rest, which is enough room to actually debug in the
  terminal or clodexctl tabs. It deliberately stops short of full screen: the
  session terminal stays visible, since watching an agent react to what you
  just typed is the point. The setting is remembered per window, and collapsing
  a tall drawer still collapses it — the height comes back on the next expand.

- **The bottom drawer is now a tab host.** It used to be the IPC log and
  nothing else; it now owns a tab strip with per-tab unread badges, and the IPC
  log is simply the first tab. Everything about the old drawer still works the
  same way — the same toggle, the same menu item, the same export and clear
  buttons — but there is now somewhere for the activity feed, a clodexctl
  console and a terminal to live. Those arrive next.

- **Subagent activity is now a drawer tab, and it stays put.** Clicking a
  subagent row used to open a popover that vanished the moment you clicked
  anywhere else, taking everything it had collected with it. That popover is
  gone; the drawer's new **Activity** tab holds a chip per subagent across the
  window's sessions, and the feed you select keeps accumulating while you switch
  sessions, look away, or the subagent finishes. Aged-out subagents keep their
  chip for as long as there is history behind it. The tab costs nothing while it
  is hidden or the drawer is collapsed — the chips ride telemetry that already
  arrives, and the one feed poll runs only for the feed you are looking at.
  It is honest about the lag it has: the feed updates at turn boundaries, the
  footer says so, and it tells you how long ago the last turn landed rather
  than pretending to be live.

- **The activity feed now shows every subagent turn, not one in five.** It read
  its turns from wirescope, which keeps only the most recent one per subagent
  and replaces it on the next request — so a subagent working faster than the
  poll had most of its work silently dropped, and what you did see was already
  a turn behind. Clodex sits in front of wirescope on the same connection, so
  those turns were crossing our own process the whole time; the feed now reads
  them there and keeps them. Turns that happen between two polls queue up
  instead of disappearing, which means nothing is lost while you are looking at
  another tab. If a very long-running subagent overflows the history we keep,
  the feed says so at the top rather than quietly closing the gap.

- **Feed rows say what a tool did, not just which tool ran.** A busy subagent
  read `Bash Bash Read Bash Bash` — every row true and the column as a whole
  useless. Each row now carries the argument that identifies the call: the
  command for `Bash`, the pattern for `Grep` and `Glob`, the path for a file
  tool, the description for a spawned `Task`. Snippets are trimmed to their
  first line and capped, so a heredoc or a multi-line script stays one row.
  This costs nothing extra on the wire: the arguments were already streaming
  past the collector that watches which files get touched, and it now keeps
  the part it was throwing away.

- **The feed shows what a subagent was thinking, not just what it did.** A
  reasoning block used to be dropped on the wire, so the feed could show a tool
  call and the sentence after it but never the thinking that led there. Turns
  now carry their reasoning as its own field, shown above the tools it explains
  and clamped to a few lines so the feed stays scannable. It is kept strictly
  separate from the turn's visible text on purpose: that text is what Clodex
  scans for `[agent:...]` commands, and an agent that merely reasons about
  sending a message must never be treated as having sent one.

- **The drawer has a clodexctl console.** A new **ctl** tab runs `clodexctl`
  against your contexts without leaving the app or opening a terminal —
  `sessions`, `run`, `exec`, `send`, `spawn`, `restart`, `logs`, `query`,
  `skills`, `args`, and the whole `ctx` family. Each command and its output stay
  together as one block, so Copy gives you a transcript rather than a flattened
  blob, and ↑/↓ walks your history. The connection stays warm between commands
  instead of re-dialing each time. Bearer tokens are stripped from every block
  including error output, and `ctx list` masks them the way `ctx show` always
  has. A **?** button lists the verbs that actually run here, derived from the
  console's own allowlist rather than a copy that could drift from it, and
  `help` / `<verb> --help` work as they do in the terminal — including for the
  verbs the console will not run, so asking why `attach` is refused gets you the
  verb's documentation rather than a second refusal.

  What it will not run is what a block cannot hold: `attach` and `logs
  --follow` are live streams, `deploy`/`upgrade`/`web` and friends are long
  children or servers, and `kill` and `restart-app` are irreversible acts whose
  confirmation prompt has nowhere to appear in a one-line input. The Terminal
  tab next door runs all of them. The console exists only in the desktop app: a
  Clodex reached over the web has no such channel registered at all.

- **The drawer has a terminal.** A **term** tab with a real login shell, one per
  window, opening in the directory your sessions in that window already work in.
  It starts the first time you look at it, not at launch, and keeps its
  scrollback while you switch tabs or collapse the drawer. Closing the window
  closes its shell. Like the ctl console, it exists only in the desktop app —
  there is no such channel on a Clodex reached over the web. It starts out yours
  alone; the two ways an agent can reach a terminal both arrived later in this
  release, and both are off until you turn them on.

## 4.15.0 — 2026-08-05 — Infra paths, and a review that arrives

- **Terraform and HCL paths in the terminal are now clickable.** The link
  scanner matches by extension — an allowlist, so ordinary prose stays inert —
  and it had no infrastructure languages in it at all, which left
  `modules/vpc/main.tf:42` as dead text. Adds `.tf`, `.tfvars`, `.tfstate` and
  `.hcl`. State files are included: they often hold secrets, but an agent
  working in your tree can already edit one, so hiding the viewer was never the
  thing protecting it.

- **A review no longer goes missing when the reviewer seat is brand new.** The
  scope is handed to a seat that has not taken its first turn yet, and only one
  event could deliver it; when that event did not fire, the review sat unread
  on disk forever while the seat looked alive and idle. There is now a second,
  independent path that delivers it, so a review that is waiting always lands.

- **A reviewer template's thinking-strip setting now actually applies.** Saving
  a strip level on the reviewer template had no effect on the seats that
  `[agent:team-review]` spawns — they ran unstripped whatever the template
  said, and nothing about the running seat showed it. The level is read from
  the template and applied to the seat.

- **The reviewer is told it has no shell.** Its tools are Read, Grep and Glob;
  there is no Bash, so `git diff` and friends were never available to it.
  Across 65 captured reviews, reaching for them anyway was the most common
  wasted round trip — each one re-bills the whole review context and returns
  nothing. It is also now told to issue independent reads together, since a
  review's cost tracks the number of requests, not the number of files.

- **The sidebar's PR chip no longer disappears thirty seconds after launch.** It
  painted at boot and then vanished for the life of the window: the cheap
  refresh that runs every 30s omits the git and gh work, and the renderer could
  not tell "this refresh didn't ask" from "the answer is none". Refreshes now
  say which questions they asked, so a cheap one can neither overwrite nor be
  believed about an expensive one's answer.

- **Revoking a plugin's access to a session now takes effect immediately.** The
  badges and menu entries it had painted used to stay up for the life of the
  window, because the sidebar refresh could not say "this session grants
  nothing" in a way the renderer could tell apart from "this refresh didn't
  ask".

- **Plugins can now read what an agent says.** A session-scoped plugin granted
  turn text receives each turn as the agent writes it — the capability that
  makes turn archivers, cross-session search and standup writers possible,
  where before a plugin could see a session's name and status but not one word
  of its work. The grant is per session and defaults off, and a plugin granted
  only tool inputs or thinking does not receive turn text: the capabilities are
  separate because they carry different risk. Nothing bundled uses this yet.

- **Plugins can now be scoped to individual sessions.** A plugin whose manifest
  says `"scope": "session"` is invisible to every session that has not granted
  it — absent from that session's intent checklist and prompt, not listed and
  refused. Grants are per capability (turn text, thinking blocks, tool inputs),
  each defaulting off, edited in the Intents popover's new Plugin Access block.
  Nothing shipped uses this yet: all four bundled plugins declare no scope and
  behave exactly as before. Scope means visibility, not isolation — intent verbs
  still share one global namespace.

- **The file popover's Diff tab now has line numbers**, the way the CLI shows
  them: additions and context numbered in the new file, deletions in the old,
  restarting at each hunk. The code column lines up with the File tab's gutter,
  so switching tabs on the same file no longer shifts everything sideways.

- **A session can now be spawned with the wire off.** New "Wire off" checkbox
  under Other options: the seat launches with no `ANTHROPIC_BASE_URL` at all —
  no Clodex tee and no API proxy. This is what Anthropic's remote access needs
  (attaching to a running session from the phone app refuses to work when that
  variable is set), so a wire-off seat can be reached from your phone and still
  drive the rest of the fleet through intents, which come from the transcript
  and are unaffected. The cost is the wire-only features: cache warmth, wire
  telemetry and protocol-accurate activity all go quiet, so wire-off rows carry
  a `⊘` in the sidebar rather than looking merely idle. The file list a session
  has touched still works — it is read from the transcript — but edits stop
  being attributed to the subagent that made them.
  Context %, tokens and cost still show — those come from the CLI's own status
  hook. The setting is remembered, so a restart, a restore or a template spawn
  all come back wire-off.

## 4.14.0 — 2026-08-04 — Every path in the terminal is a door

- **File paths in the terminal are now clickable.** When an agent mentions
  `renderer/lib/format.js:71`, clicking it opens that file in the peek modal,
  scrolled to line 71 and highlighted. The CLI is not involved and needs no
  support for this — Clodex scans the text it has already rendered. Paths are
  matched by shape, so a click on something that only looks like a path tells
  you it could not be found rather than doing nothing. Truncated paths are
  recovered by matching against the files that session has touched; a path that
  matches two of them is refused rather than guessed at. A leading `@` — the
  CLI's own "load this file" syntax — is understood, while a real path that
  starts with one (`node_modules/@babel/…`) still resolves normally.
- **The line numbers an edit prints are clickable too.** When a tool call shows
  its gutter under `Update(file.js)`, clicking a number opens that file at that
  line — the numbers name a line but not a file, so Clodex reads the file from
  the header above them. A number only links when it is part of an unbroken
  gutter under such a header, so numbers in ordinary output stay inert.
- **The file peek can be dragged by its title bar**, so it can be moved off
  whatever it is covering instead of only resized. A fresh open re-centres it;
  following a path or stepping back leaves it where you put it.
- **The File view shows line numbers**, and paths inside a viewed file are
  clickable too — following one keeps a back arrow to where you came from.
  A relative path resolves against the file it appears in first, so
  `../lib/format.js` means what it means to that file.
- **A file can now be edited in the peek.** An Edit tab next to Diff and File,
  with Cmd+S, a dirty marker, and a prompt before discarding unsaved changes.
  Editing is confined to the session's own directory and refuses a file that
  changed on disk since you opened it, so an agent still working in that file
  cannot have its edit silently overwritten. Files too large to load whole are
  not editable — saving one would discard everything past the display limit.
  Sessions running on a peer machine are viewable but not editable.
- **A session listing that ignored workspace boundaries has been removed.** The
  `session:listAll` IPC channel returned every session in every workspace. No
  client ever called it — the tray, the one thing it was written for, reads the
  same data in-process — but the browser frontend dispatches any registered
  channel by name, so an authenticated connection bound to a single workspace
  could have used it to list all of them. Deleted, along with the note in the
  architecture docs that wrongly described it as feeding the tray. A new test
  now fails if any IPC handler is registered without appearing in the API
  contract, which is how this one stayed unnoticed.
- **You can now file a ticket for later without starting it.**
  `[agent:task add <role>] <spec>` dispatches immediately — it delivers the spec
  to the seat the moment it is idle. Writing "BACKLOG, do not start" at the top
  of the ticket did nothing, because nothing reads the body; only the worker's
  own reading of that first line ever stopped it. Add `park` —
  `[agent:task add park <role>] <spec>` — and the assignee is recorded while the
  spec stays undelivered. A parked ticket is skipped by the queue, never replayed
  to a restarted seat, and exempt from the stall watchdog, so it also stops
  making real work wait behind it. `[agent:task assign <id> <role>]` releases it
  and sends the spec; `[agent:task park <id>]` parks or unparks one already open,
  so changing your mind no longer means cancelling and refiling. Both listings
  and the ticket board mark parked rows.

- **A seat's shell now sees the same Clodex root the app does.** The helper
  scripts — the team roster, the monitor, the task ledger — find their data
  through `CLODEX_HOME`. Commands you fire with `[agent:exec …]` were already
  pointed at the app's own root, but the same script run by hand from a seat's
  terminal inherited whatever the app happened to be launched with, so the two
  routes could read different trees and disagree about who is on the team. Every
  session now starts with that variable set to the app's root, which closes the
  split. The consequence worth knowing: setting `CLODEX_HOME` yourself in a
  session's environment no longer has any effect — it is overridden, the same way
  `TERM` always has been. Nothing else in that environment changes.

- **A session can now be told to skip wirescope's spawn-directive block.** Set
  `CLODEX_SPAWNER_HINT=off` in a session's environment and the proxy stops
  adding the `[wirescope]` block — the documentation of how to spawn subagents —
  to that seat's system prompt. It is worth doing for a seat that will never
  spawn one, since the block otherwise rides along on every request it makes.
  `=on` is the opposite, for a port where the block is off by default; anything
  else, including leaving the variable unset, changes nothing. The cold reviewer
  seat already skipped the block because it holds no spawning tools, so nothing
  about it changes here; what is new is that the switch is available to any
  session rather than being wired into one internal code path.

- **A rejected ticket command no longer eats what you wrote.** Fire
  `[agent:task done]` at a ticket someone already closed, or `[agent:task add]`
  from a seat that is not the lead, and the report or spec you just composed used
  to vanish with the error — it existed only in that turn, and nothing had kept a
  copy. Now every rejection saves the body first and the error tells you where it
  went, so you can recover it instead of rewriting it. If the save itself fails
  the error says that plainly rather than naming a file that is not there, and
  because the message directory is swept after thirty minutes the reply tells you
  that too. This happened twice in one night to agents working on Clodex itself,
  once losing a review verdict.

- **Clodex no longer records a message as sent while it is still queued.** Text
  bound for a session waits for a safe moment — the seat has to be idle, not
  mid-draft, not paused on a permission dialog — and that wait can run to
  minutes. The internal call that queues it, though, answered "delivered" the
  instant it accepted the bytes, so anything Clodex wrote down on the strength of
  that answer was recording a write that had not happened yet. If the app quit
  during the wait, the record said the message went out and the message was gone.
  The affected spots each hold something you would notice missing: parked mail
  waiting on a restart, a team's roster introduction, and the stall alarm that
  tells a lead one of its agents has gone quiet. They now wait for the write
  itself. The alarm additionally checks that the stall it is reporting is still
  the one happening — an agent that speaks up while the alarm is queued ends the
  stall, and the old code would have quietly disarmed the next one.

- **Turning an intent off no longer destroys what an agent wrote with it.** If a
  session is not allowed to send direct messages, and it composes one anyway, the
  refusal used to arrive with the message already gone. The bounce now explains
  that the capability is off for that seat, that retrying will fail the same way,
  and that only you can change it — from Edit Session → Intents. Four verbs also
  save the body first and tell the agent where it went: direct messages, inbox
  notes, reminders, and memory writes, the ones whose payload is composed prose
  that took a turn to write. A refused compact does not, because its note is still
  sitting in the context it was written for; a refused exec does not, because its
  arguments mean nothing without the command. Anything else says plainly that the
  body was lost rather than pretending otherwise. Saving is capped per seat and
  per verb so a session that has not learned the setting cannot fill the message
  directory by retrying every turn.

- **`[agent:context reload]` no longer strips a session's environment.** Reload
  respawns the CLI in place, and it was dropping every environment variable the
  session had been given. The loss outlived the reload: the respawn rewrote the
  session's saved record without them, so the variables were gone from every
  later resume as well, not just the running process. A session that reloaded
  once came back subtly different and stayed that way.

- **Team task artifacts are written outside your repository.** A team's working
  notes — specs, journals, design documents — live under
  `~/.clodex/projects/<project>-<hash>/tasks/`, never in the project being worked
  on. The directory is named for the project so it can be browsed by hand, and
  the hash is taken from its resolved path, so two checkouts that happen to share
  a folder name do not quietly share one artifact directory.
- **A restarted agent is told what it was working on.** A ticket's instructions
  used to reach a seat exactly once, when it was assigned. If that seat then
  crashed, cleared, or reloaded, it came back with no idea what its job was, and
  nothing ever told it again — from the board the ticket still looked assigned and
  in progress. Open tickets are now re-delivered when the agent comes back up, at
  the moment it can actually receive them, which is a different moment for Claude
  and Codex sessions. Only tickets belonging to that specific agent are replayed.

## 4.13.0 — 2026-08-04

- **Every sidebar session has an ⓘ button now.** Hover a row, click the ⓘ, and
  you get what Clodex already knew but had nowhere to say: how many times this
  conversation has been compacted and how much context those compacts threw
  away, turns and API requests, how big the transcript has grown, and the cost —
  in all four of its scopes, each labelled, because they are genuinely different
  numbers. Spend since the last compact, spend since the CLI process started,
  spend on this whole conversation, and **spend by this agent across every
  conversation it has ever held**, which only ever goes up: a /clear starts a
  fresh conversation but does not reset the seat's lifetime total. Where the
  older records have aged out of the ledger, the panel says how many it still
  has rather than presenting a short total as complete. Reading it costs
  nothing until you click — the transcript scan runs on demand, not on the
  poll.
- **Preferences is seven collapsible groups instead of one long scroll.** Every
  setting was expanded at once, so finding one meant scrolling past eight others
  and their explanations. Groups now start collapsed, each with a one-line
  summary of what is inside, and the ones you open are remembered. The settings
  themselves were regrouped rather than just folded: the two statusline sections
  are one "Statusline" group, and default tools and Claude MCP — both of which
  only affect sessions you create from now on — are one "New session defaults"
  group that says so once instead of twice. Traffic optimization now names
  wirescope as its first entry, since the transcript bake and the memory hints
  under it are things wirescope does — none of them exist without it, and the
  dialog never said so. Nothing moved out of the dialog and nothing changed what
  it does; a collapsed group still saves exactly as before.
- **Turning off traffic optimization now actually stops contextual hints.**
  Sessions already running kept the proxy address they were given when they
  started, so unticking the setting stopped wirescope but left those sessions
  still matching your drafts against memory and posting hints at a port with
  nothing on it. Each failed post also held that session's incoming messages for
  up to 30 seconds, so a DM sent right after you changed the setting arrived
  late. Sessions you routed to a proxy explicitly are unaffected — they keep
  their hints, as they always should have.
- **Fixed: a restarted proxy stopped being recognized as Clodex's own** —
  which showed up as Preferences saying "not running" next to a proxy that
  plainly was, no Restart button, and a vendored wirescope update that never
  got picked up no matter how many times you relaunched. Clodex identifies the
  proxy it started by a small pid file, and on a restart the outgoing process
  deleted the incoming one's copy on its way out. Everything downstream reads
  that file, so one missing byte turned a managed proxy into an unmanaged one.
  Recovering meant killing the process by hand. If you are on a proxy that
  reads "not running", it will re-adopt itself the next time it restarts.
- **A proxy Clodex lost track of now finds its way back.** The bug above left
  some proxies already orphaned, and nothing recovered them: Preferences kept
  saying "not running", the Restart button stayed hidden, and a vendored update
  was never picked up no matter how many times you relaunched. Clodex now
  re-adopts a proxy on the expected port only when it carries a private setting
  that Clodex itself sets at launch and nothing else supplies. A proxy you
  started by hand is left alone even when it runs from the same directory, and
  so is one belonging to another Clodex install on the same machine — neither is
  ever stopped or restarted by this one.
- **Two test runs can no longer wedge each other** (contributors only). Parts
  of the suite bind real ports, so two at once deadlock — both sit at 0% CPU
  and neither finishes, which looks exactly like a slow suite. `npm test` did
  not take the lock the digest path has always used, so the most obvious
  command in the repo walked past the guard; a stray run had been stuck for
  over thirteen hours. It now refuses immediately, naming the process holding
  the lock and how to clear it.
- **An agent now reaches for the tools you gave it.** Agents were told which
  commands you had granted them and how to call them, but not that those were
  the intended way to do the job — so they noticed the command and then wrote
  the equivalent shell line by hand, which is slower, noisier, and what the
  command existed to avoid. A team lead was also being shown its reviewer in a
  way that read like an ordinary helper, so it built its own instead of using
  the review channel that reports back to you. Both now say plainly what they
  are for and when to use them.
- **An agent's lifetime spend now survives a restart, and Opus 5 turns are no
  longer free.** The ⓘ panel's fourth number — everything this agent has ever
  spent — is the one that only goes up, and it was being reset: restarting a
  session dropped the list of conversations it was summed from, so "all time"
  quietly became "since the last restart". Separately, Opus 5 had no price row
  at all, so those turns costed at zero while still counting as requests — a
  conversation that had plainly cost something showed a total far below it.
  Both are fixed going forward; sessions already recorded with a zero total
  stay as they were.
- **Claude 5 Sonnet's introductory pricing now expires on its own.** The rate
  drops to standard on 1 September 2026 and the change was tracked as a note
  telling us to remember; it is now scheduled, so receipts before that date
  keep the rate they were billed at and later ones do not.
- **An agent updated by a new Clodex version now picks up its new instructions.**
  An agent's instructions are frozen while its conversation is warm — rewriting
  them mid-conversation would throw away everything it has cached, so changes
  are handed over as a diff instead. What was missing was the other half: at a
  /clear or a compact, where the conversation is gone or already being rebuilt,
  the frozen copy can safely be replaced. It was not being replaced, so an agent
  running across an upgrade could keep instructions from a week earlier
  indefinitely — one seat here ran six days that way. Refreshing costs nothing
  at a /clear and rides a cost the compact has already paid.
- Vendored wirescope v0.6.47.
- **An agent that gets an irrelevant memory now drops it without telling you.**
  Retrieval matches on words, so it misses — and when it did, agents announced
  the miss: one idle seat was handed a memory about an unrelated project,
  correctly declined to act on it, then summarized it back to you "so it isn't
  lost". The hint said to ignore it if unrelated, but said more loudly that it
  would not be repeated, so agents preserved it rather than dropping it. An
  unrelated memory is now dropped in silence, which is what it cost you nothing
  to receive.
- **A memory attached to a turn now says when you said it.** Hints arrived
  undated, so a claim from two years ago read as current — "your branching
  strategy is main/qa/devel" asserted flatly, with nothing to tell the agent it
  described work from 2024. Measured over the live stores: of 22 memories
  delivered across 30 questions, 15 were over a year old and 7 of those had no
  date recoverable from their own wording. Each memory now carries the month it
  was learned. Which memory rides is unaffected — the date is shown, never
  matched.
- **A Preferences toggle that cannot act now says so.** Three checkboxes — the
  resume-time transcript bake and both hint settings — did nothing unless
  wirescope was on, but you could still tick them, save, and
  relaunch to find them still ticked and still inert. They are now greyed with
  the reason underneath, and semantic ranking greys the same way when hints
  themselves are off. Your choices are remembered, not discarded: turn the proxy
  back on and they return as you left them.
- **The semantic pass no longer throws away the memory your question matched.**
  It was meant to reorder what the word-matching gate found; it was instead
  re-ranking the whole store and replacing that result outright. Asking "any
  other colleagues in my orbit?" matched a memory listing your colleagues on two
  words — and delivered three about an assistant project, LinkedIn posts and
  parenting, because they scored a hundredth of a point higher in a range the
  whole store fits inside. Measured over 12 questions: 41% of delivered memories
  were ones the question had actually matched, and on half of them every match
  was discarded. Now 100%.
- **A personal question now retrieves memories that actually mention it.** In a
  memory store about one person, every unit is similar to every question about
  that person — "who are my colleagues?" spanned 0.600 to 0.584 across its whole
  result, so what rode was three confident units about agent collaboration and
  AWS networking while the ones naming actual colleagues sat far below. A memory
  must now share a word with the question, and the pool it is chosen from is wide
  enough for that to mean something. Measured over 14 personal questions:
  precision rose from 40% to 75%, and four questions the store simply cannot
  answer (pets, music, and two others) now stay silent instead of shipping three
  confident irrelevant memories.
- **A hint no longer outlives the draft it was ranked against.** Arming happens
  at a typing pause, so a draft you keep editing could leave a hint registered
  against text that no longer exists. Continuing to type already replaced it;
  what didn't was editing your way down to *no* match — the previous winner
  stayed armed and rode the request. The hint slot is now cleared whenever the
  current draft earns nothing, including when it becomes unreadable (history
  recall, tab completion) or drops back below the length floor.
- A hint now says it is retrieved rather than verified: where one conflicts with
  what you just said, the agent is told you are right.
- **A hint can carry more than one memory, bounded by characters rather than by
  a count of one.** Short units — which is most of the common store — now ride
  together instead of one at a time, so a question the store answers in three
  places gets all three rather than whichever sorted first. Measured across
  eight matching questions: 19 units delivered where there were 8. The winner
  always rides; runners-up are admitted only while they stay close to it in
  score and inside the budget.

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
