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

- The guard that checks every intent in the code is exercised by a test now
  reads the code as code. It had been pairing quote characters over raw bytes,
  so a backtick inside a comment opened a "string" that ran on for lines —
  dropping real intents from the set it checks while collecting a thousand
  fragments that were never intents at all. Comments, regular expressions and
  nested template interpolation are now understood, and the count the guard
  reports is one you can trust.
- That same guard now also refuses to read a predicate it does not understand,
  rather than quietly reporting on the part it could parse.
- The guard that keeps the intent parser and its test corpus in step now also
  covers the sub-verbs that decide how an intent's body is read. That set is
  derived separately from the one the earlier guard checks, so a sub-verb could
  be added to it and go untested — the same way one went untested for a full
  release cycle before.
- A ticket reviewed more than once now reports each round's cost separately.
  The review seat was named from a counter that is freed when a seat retires,
  so a second round could reuse the first round's label — or come out ordered
  backwards. The round is read from the ticket itself now, and the seat is
  named for the ticket and round it belongs to, so it is also findable in the
  roster while it works.
- A ticket's automatic test run no longer reports green over a dependency set
  the branch has stopped declaring. It compares the branch's declared
  dependencies against the checkout it borrows `node_modules` from, and holds
  the ticket for you instead of reviewing work whose suite only passed because
  the borrowed tree still carried a package the branch dropped.
- `node_modules` is ignored again on a fresh clone. The entry only matched a
  real directory, so the symlink a ticket run creates showed up as an untracked
  change on every machine except one that happened to carry a local exclude.
- The guard that keeps the intent parser and its test corpus in step now covers
  `[agent:team …]` as well as `[agent:task …]`, and a new check makes sure a
  future family of sub-verbs cannot be added without being covered too — whatever
  its verbs are spelled with. A sub-verb went untested for a full release cycle
  this way.

- A stalled ticket's alarm now tells you what the seat was actually doing. It
  names the seat's last tool call — and distinguishes a call still in flight
  from one that died mid-write — alongside the branch's commit count and
  whether the tree is dirty. A dirty worktree on its own never separated a
  working seat from one killed mid-turn, which is how a genuinely dead seat
  got dismissed as busy.
- A stall that nobody answers now re-escalates on a doubling schedule
  (30m, 1h, 2h, 4h) instead of speaking once and going quiet. The doubling is
  what keeps an unattended stall visible without flooding the prompt stream:
  an 8-hour stall speaks about five times, not sixteen.
- The stall watchdog no longer alarms about tickets that were filed but never
  started. Opening a ticket for a role records that role as the assignee, so a
  backlog ticket looked dispatched to the watchdog even though no seat was ever
  spawned and nothing could be stalling. Twenty-eight open tickets were in that
  state, and with the new escalation schedule above they would have produced
  roughly 140 alarms a night about work nobody had started.
- A ticket's verify step now runs the test suite in the ticket's own worktree
  before a reviewer is spawned, so nobody is asked to review a branch that does
  not build. The suite runner gets its own process group and is killed as a
  group on timeout: it blocks in a synchronous spawn, so the previous kill left
  the inner test process running and still holding ports, which deadlocked the
  next run against a lock it had inherited.
- Fixed a packaging test that only ever passed in a checkout where a build had
  been run: it asserted the existence of directories that are gitignored and
  untracked, so it failed in every fresh clone and every ticket worktree.
- The ticket board no longer flags filed-but-unstarted tickets as stalled, and
  a ticket dispatched from the board is now recorded as started. The board kept
  its own copy of the stall rule and did not get the fix above, so the same
  twenty-eight tickets stayed lit on screen. Fixing only that would have been
  worse than the bug: assigning a ticket from the board delivers its spec but
  never stamped a start time, so a board-dispatched ticket would have read as
  never-started forever — invisible to the board's flag and to the watchdog
  alike. A stall nobody is told about is the more expensive direction.
- A ticket's artifact directory is now found anywhere in its spec, not only on
  the first line. A spec that named its task dir lower down left the review
  step with nowhere to write the diff, so it computed one and threw it away —
  measured nine times in a night, the largest discarding 78KB, twice on the
  tickets that fix the review loop itself. The scan is a strict superset, so
  any spec that resolved before resolves to the same directory now. The loop
  also checks that a destination exists before spending a full-branch diff on
  it, and when there is none it names a recovery that works: the suggested
  command is parsed by the real intent grammar and exercised end to end, so
  renaming an intent breaks the test rather than quietly leaving the advice
  pointing at a command nobody can run.
- Fixed a stall-sweep test that could not have caught the bug it was written
  for. Every exemption fixture had a single-element board, so an exemption
  that skipped the entire remaining sweep instead of just its own ticket
  looked identical to a correct one, and would have silenced every alarm after
  the first exempt ticket with the suite still green.
- A review verdict on a ticket now tells the lead it arrived. It was written
  to the ticket record and nowhere else, so the only way to learn a review had
  finished was to poll the board — while an ad-hoc review scoped by a path
  reported back normally. The record is still the source of truth and the full
  verdict is still kept out of the inbox, since one measured verdict ran to
  nearly 16KB; what arrives is a summary with the verdict, the round and the
  must-fix count. The full text is written beside the ticket's review diff in
  its own task directory, so it outlives both the reviewer and the half-hour
  sweep that used to be the only copy.
- Two agent commands of the same kind in one message no longer collapse into
  one. Their de-duplication key ignored the ticket id, so `[agent:task start
  t1]` and `[agent:task start t2]` looked identical and the second was dropped
  with no error to the sender — measured on two ticket approvals emitted
  together, where only the first took effect and the second's worktree and
  branch survived unnoticed. It affected every command carrying an id, and
  `team role-rm` across different roles. Genuine double-pastes still collapse,
  which is the direction that matters: the key can only tell more things
  apart, never fewer.
- Fixed a test that had been passing without checking anything since the
  `task start` command was added. It compares the command parser against a
  frozen copy of the parser it replaced, over a corpus harvested from three
  test files — and the file exercising `task start` was not one of them, so
  the frozen copy never learned the command and the comparison stayed green.
  The corpus now asserts that every command in the real grammar appears in it,
  so the next command added cannot slip through the same gap.
- A repeated stall alarm now says which rung of the escalation ladder it is on.
  Every alarm from the second onward said "repeat 1", so the 1h, 2h and 4h
  warnings were indistinguishable from each other and the number was simply
  false — in a message whose whole purpose is to be trusted when it says
  something is wrong.

- A retired role field in `team.json` now says so on load, instead of vanishing
  once the file claims a current schema version. `roles.reviewer.tools` looks
  like a capability restriction and enforces nothing — the real cap is in code —
  and a version-stamped manifest dropped it in silence, so the file kept reading
  as policy. The warning partitions by measured effect rather than by key name:
  a key is described as still-read only when deleting it actually changes the
  role, which matters because `worktree` is honored for an exact `true` on a
  non-reserved role with no explicit `dispatch` and inert everywhere else.
  Telling the owner of an inert `worktree: false` to "write `dispatch:
  \"worktree\"` instead" would have converted a standing role into one that
  mints branches nobody asked for.

- Reporting a ticket done now runs the review, instead of asking the lead to.
  `[agent:task done]` recorded the report and stopped there: the lead had to
  notice the ticket, check the branch existed and carried commits, materialize
  the diff, assemble a scope out of the spec and the report, and only then spawn
  the reviewer — six manual steps per ticket, every one of them the same. Closing
  a ticket now verifies its tree (the branch exists, the base is an ancestor of
  its HEAD, there are commits to look at), writes the diff, builds the review
  scope from the ticket's own spec and report, and spawns the cold reviewer
  itself. Anything that stops it — a missing branch, no commits, a base that
  drifted, a reviewer that cannot be spawned — is escalated to the lead with what
  it found and what it had already done, so a loop that stops says why. The lead
  still merges, and still only after a verdict.

- The terminal's shell refusal no longer reads as a version treadmill. When your
  shell is a bash too old to report command results, the message used to name two
  version numbers and point at Homebrew — which reads as "your machine is behind"
  when the truth is the opposite. bash 4.4 is from 2016; macOS still ships 2007's
  3.2 as `/bin/bash`, so the newest Mac reports the same version as the oldest.
  The refusal now says that, says nothing needs updating, and offers zsh first —
  it has been the macOS default since 2019, so it is already there and needs no
  install. It also tells you to restart Clodex afterwards, without which the
  advice quietly does not take: the shell is read from the app's own environment
  at launch, so changing it and opening a new tab reproduces the same refusal.

- Filing a ticket and starting it are now two acts. `[agent:task add]` wrote the
  ticket and immediately minted its branch, its checkout and its teammate, so a
  lead who wanted to think about a ticket before running it had to remember to
  park it — and "do not start yet" written in the body was read by nobody. `add`
  now writes the ticket and starts nothing; `[agent:task start <id>]` mints the
  tree and the seat and delivers the spec. A ticket you have not started is
  simply one you have not started, and the board says so.

- A cold reviewer's verdict on a ticket now lands on the ticket. It was delivered
  to the lead as a message, so the finding of a full review existed only in one
  agent's conversation: if that agent compacted, or the reviewer's report arrived
  while it was busy, the verdict was gone and the review had to be paid for
  again. The verdict, its must-fixes and its round number are written to the
  ticket record, which outlives every seat involved. A review you asked for
  yourself with `[agent:team-review]` still reports back to you, unchanged.

- A cold reviewer now boots already knowing what it is reviewing. The scope you
  pass to `[agent:team-review]` was sent to the new seat as a message, which meant
  it arrived at the seat's first turn — and a message written while the CLI is
  still drawing its interface is wiped by it. The seat then sat idle, looking like
  it was thinking, holding a briefing that said how to review but not what; the
  lead had to notice and resend. Six times in one day. The scope is now part of
  the reviewer's prompt, present before it takes a turn at all, so there is no
  moment at which it can be lost — and it survives a compact, which the message
  did not.

- How a role gets its work is now a named choice you can see and change. Whether
  a ticket went to the role's live seat or minted a fresh one in its own branch
  and checkout used to be a `worktree: true` boolean that only a hand-edit of
  `team.json` could set — a field with two behaviours, one of which had no name.
  It is now `dispatch`, set from the team popover's Roles section: `standing`
  hands the spec to the seat already holding the role, `worktree` gives the
  ticket its own branch, tree and teammate. Existing team files keep their
  setting; the old key is still read, so a file nobody has edited behaves as it
  did before, and is rewritten the next time any role changes.

- Ticket branch names are readable again. The branch was slugged from the
  ticket's first line, which is also where the dispatch format asks for a link to
  the task folder and where a lead naturally writes the ticket number — so the
  branch ended up repeating the number, swallowing the folder path, or, when a
  lead guessed the number before the board issued one, asserting a ticket that
  does not exist. The slug now drops a leading number and any folder path, and
  truncates on a word boundary rather than mid-word. The ticket's link to its
  folder is unchanged; only the branch name is.

- Finishing a ticket is now one step. `[agent:task accept <id>]` closes it,
  retires the seat, removes its worktree and deletes its branch — but only after
  git confirms the branch really is merged into the base. If it is not merged, or
  if the check cannot run at all, nothing is removed and it says why. Accepting
  also records which session did the work, so a seat can be brought back later
  for a hotfix instead of being reconstructed from scratch.

- Retiring a seat no longer claims a directory has uncommitted work when it
  simply is not there any more. Removing a merged worktree before retiring its
  seat — the correct order — made the confirmation report uncommitted changes in
  a directory that had just been deleted, and tell you to go commit them. It now
  distinguishes a tree it could not inspect from one that is genuinely dirty.
  Both still archive the seat rather than discarding it.

- Asking for a test run while one is already going now says so, instead of
  timing out. The refusal existed but could never be seen: the script waited the
  full 120 seconds before printing it, and the exec entry killed the run at
  exactly 120 seconds, so the caller got an unexplained timeout. It now gives up
  after 30 seconds and reports which run holds the suite and how long it has been
  going — enough to tell a healthy run from a wedged one.

- The Tickets panel no longer needs a team, and can now edit the board. It used
  to find boards by walking the list of teams, so a project without one showed
  nothing at all; it now lists projects directly, with team membership shown as
  extra detail where it exists. Tickets can be opened, re-specced, assigned to a
  live session, closed and cancelled from the panel — previously it was
  read-only and every change had to go through an agent. Editing is desktop-only;
  the browser frontend stays read-only. Note that closing a ticket here does not
  hand the seat its next ticket or write the cost record, which `[agent:task
  done]` still does.

- Tickets no longer require a team. `[agent:task add/list/done/...]` used to
  refuse outright unless a `team.json` owned the session's directory, so filing
  a note to yourself meant first inventing a team to be your own lead. The verbs
  now work in any git repository, keyed to that repo's ticket board — the same
  board a team in that repo would use, so tickets filed solo are still there
  after a team is created. Outside a git repository the verbs still refuse,
  since there is no project for a ticket to belong to.

- Ticket boards copied to the new per-project location now re-sync themselves.
  The copy ran once and was then locked, so a board copied while a ticket was
  still being worked kept the half-finished version forever — one ticket showed
  as open after it had been closed, and the stall watchdog nudged about it. Each
  launch now refreshes any record the old board has a newer version of, and stops
  doing anything once the old board goes quiet.

- Bundled wirescope updated to v0.6.51. The `/_session` view labelled each block
  with its position in the request payload, which looked like a count of how many
  times that message had been sent and was not one — a request carrying a message
  plus the system message alongside it showed as two calls when only one crossed
  the wire. Blocks now read `call 3 x16`: which call first carried it, and how
  many have re-sent it since. The header gains an API-calls count next to turns.

- The ticket board now belongs to the PROJECT rather than to the team, so two
  teams working one repo share one board instead of each keeping a private list
  the other cannot see. Existing boards migrate themselves on first launch: your
  tickets are copied, never moved, and the old file is left where it is. A board
  that cannot be read is skipped and retried next launch rather than replaced.

- Seat spawn/retire notices now go to the team lead alone. Every seat on the
  project used to get them, so a hand mid-task was woken to be told that an
  unrelated reviewer had restarted — news it cannot act on. Who is up is the
  lead's business. Each seat still boots with an accurate roster; only the
  interruption is gone.

- A reviewer template whose `tools` is not a list, or is an empty one, no longer
  spawns a reviewer holding every tool the cap allows. Both cases used to be
  indistinguishable from leaving `tools` out, so a typo in the template granted
  more than it asked for — the one direction that should never happen by
  accident. Each is now refused with the edit that fixes it: make the value a
  list, or put allowed tool names in it. Leaving `tools` out still means "accept
  the full set", unchanged.
- A cold review is now refused, with an explanation, when the reviewer template
  asks for tools that share nothing with what a reviewer is allowed
  (`Read`/`Grep`/`Glob`). That combination used to spawn a reviewer with every
  tool disabled — a seat that could not open the diff it was reviewing, and
  reported on it anyway. The refusal names what the template asked for and what
  is allowed, and no reviewer name is consumed. Templates that narrow to some of
  the allowed tools, or name none at all, are unaffected.
- A reviewer template's auto-compact opt-out now applies to the reviewer seat.
  Turning auto-compact off in a template used for cold reviews had no effect —
  the setting was read on other spawn paths and skipped on that one, so the seat
  compacted anyway with nothing to say it had. Templates that do not set the
  field are unaffected.
- A template environment key that is refused now says which of the two problems
  it hit, on every path that spawns a seat. A key outside the allowed set needs
  operator approval; a key whose value is not a string needs the value quoted.
  One path reported the second as the first, sending operators to ask for
  permission they already had.
- Ticket cost is now attributed to the seat that actually did the work. A
  ticket filed against a role is recorded against the seat it was handed to,
  including when the original seat died and a sibling picked the work up on the
  next respawn. Previously the record kept naming the seat the ticket was first
  pinned to, so a rollup could publish a dead seat's lifetime spend under work
  somebody else did. Where the record and the delivery disagree about who
  worked it, the cost says the seat is unknown rather than picking one.
- Ticket boards name the role a ticket was filed under rather than the seat it
  was handed to, in the tickets viewer as well as the built-in boards. Replies
  suggesting a recovery command name the role too — suggesting a seat that has
  since gone would hand back a command that bounces.
- A team role now declares only the four things something actually reads:
  `template`, `prompt`, `brief`, and `dispatch`. The other five —
  `instantiate`, `standing`, `tools`, `type`, `ephemeral` — were declarations no
  spawn path consumed, so setting one changed nothing while reading exactly like
  configuration. `tools` was the worst of them: a role that appeared to cap a
  seat's tools did not, and the only real cap lives in code. Team files carrying
  the old fields are migrated in place the next time any role is edited, and are
  read correctly until then.
- Ticket work now reports what it cost. Closing a ticket writes a `COST.json`
  into its task directory: the spend of the seat that worked it, how many
  commits landed on its branch, and two counters for the waste the rollup exists
  to expose — work redone after a rejected review, and worktrees left behind by
  retired seats. Where the seat that spent cannot be identified with certainty
  the record says so rather than guessing, since a confident wrong number
  poisons every total that sums it.
- The `clodex-team` roster no longer annotates roles with a field the schema
  deleted. It read `team.json` directly rather than through the shared loader,
  so it had kept rendering `instantiate` — which would have silently vanished
  from the line once a team file migrated.
- Plugins can ask whether a worktree is dirty. `host.lib.gitWorktree.isDirty()`
  reports whether a checkout holds work git would track, so a plugin can warn
  before an action that would discard it.
- A template's environment keys are now reported when they are refused, on
  every path that spawns a team seat. A key outside the allowed set and a key
  whose value is not a string are different problems, and they are now named
  differently — previously an allowed key with a mistyped value was reported as
  needing approval the operator already had. Ticket seats announce refused keys
  too; they used to drop them silently while other paths said so.

- Retiring a teammate no longer abandons its worktree. A discarded seat's
  checkout was left on disk with nothing pointing at it — retiring dropped the
  only record naming the tree, so neither Clodex nor the sidebar could find it
  again, and any commits on its branch that had not been merged were stranded
  there. The confirmation said its state lived on in the task artifact, which
  was true of its notes and not of its code. Retiring now removes the checkout,
  and archiving still keeps it, since an archived seat is resumable and that
  checkout is what it resumes into.

## 5.6.0 — 2026-08-11 — Teams in the menu bar, and a clock that knows you are working

- **Agents no longer look idle while they are working.** The idle time shown
  for a session — in `[agent:who]`, in the sidebar, and in the tray — measured
  how long ago the activity LABEL last changed, not how long ago the agent last
  did anything. An agent taking request after request without changing state
  stayed labelled "thinking" while its clock ran, so a long turn reported
  minutes of idleness. The same number decides whether a message to an agent is
  delivered or held until its next turn, so busy agents had messages parked and
  cold ones woken. It is now stamped from the agent's actual traffic. Restart
  behaviour is unchanged: a resumed session still dates from its last real turn
  rather than from the restart, and a session whose files carry a clock ahead of
  the machine's no longer keeps that wrong time permanently.

- **Teams are reachable from the menu bar.** A new Teams menu lists every team,
  opens its roles editor, and — the part that was missing — creates a team
  without spawning a seat for it. Until now a team could only be born as a side
  effect of creating a session, and the only way to edit one was an unhinted
  right-click on a sidebar group header, which exists solely when the sidebar is
  grouped by Project. That right-click still works; it is no longer the only way
  in. The menu also stays for a box with no teams at all, since that is exactly
  the box that needs to create its first one.

- Long turns no longer die at ~5 minutes of stream silence. Clodex now spawns
  every seat with the Claude CLI's stall threshold raised to its maximum of 30
  minutes, which mostly matters behind a proxy, where a slow first token used to
  surface as `API Error: Response stalled mid-stream.` This is a floor, not an
  override: a value you set in any env scope (global, workspace, or session)
  still wins. It has one cost worth knowing — setting the variable at all takes
  the CLI off its server-side default, so a future upstream change to that
  default no longer reaches you in either direction.

- A second agent asking for a reboot too soon after another one is no longer
  told "a reboot happened" when none has. Since restarts now wait for an
  all-idle window, the earlier request may still be pending — or have been
  cancelled or dropped without ever restarting anything. The refusal now says
  a reboot was *requested* that long ago, which is the fact Clodex actually
  knows.

- Reboot: a deferred restart that is abandoned no longer reports itself to a
  seat that merely shares the requester's name. A seat killed and recreated
  under the same name during the wait — which can run up to 30 minutes — was
  receiving a parked "reboot DROPPED" for a restart it never asked for.

## 5.5.3 — 2026-08-11

- `[agent:reboot]` no longer interrupts working agents. It used to relaunch
  half a second after the request, which landed mid-turn and cut off whatever
  any session happened to be streaming — including agents that had nothing to
  do with the reboot. It now waits for every session to go quiet before
  restarting, giving up after 30 minutes rather than waiting forever. Measured
  against a month of traffic: about a fifth of all mid-stream cutoffs were
  caused by this, and 19 of 25 reboots interrupted at least one agent.
- If a pending restart is abandoned, the requesting agent is now told why.
  Previously it was always told sessions had stayed busy for 30 minutes, even
  when the operator had cancelled the restart by hand a moment earlier — and it
  was invited to ask again, which turned a deliberate cancel into a loop. A
  cancelled restart now says so and says not to re-request it.
- The "restart dropped" notification no longer claims the restart was
  cancelled, and names the agent that asked for it when an agent did.
- **Keep-warm "Always" is no longer silently switched off overnight.** This
  corrects the behaviour described in 5.5.0: a rejected ping that looked like
  an expired credential used to clear the Always setting from the session's
  record, on the reasoning that Clodex cannot refresh your credentials for you.
  That reasoning was wrong. The CLI refreshes its own token on its next real
  turn, so the rejection is temporary — but the erasure was permanent, and the
  seat came back cold with nothing to show why. Measured on one box: every such
  disarm happened overnight, and a seat that missed the erasure by chance
  recovered on its own about twelve minutes later and stayed warm for six more
  hours. Now no ping failure of any kind, credential-shaped or not, can clear
  what you set: the strikes still stop that round of pinging, and the seat
  picks it back up on its next turn. Only you withdraw an Always.
- Traffic optimization updated to wirescope v0.6.50, which drops the
  boiling-pot analysis that measured out negative and was removed from Clodex
  last release. No change to how requests are handled.

## 5.5.2 — 2026-08-11

- Fixes the Workbench being unusable over web access, where the file tree
  showed nothing and no button or the close X responded to a click, though they
  still lit up on hover. It looked like something invisible was covering the
  panel; in fact the panel had never finished being built. Hiding the two
  desktop-only browse buttons in 5.5.0 aborted the rest of the setup, so most
  of the Workbench was never connected to anything. Desktop was unaffected.
- The release now opens a real window and checks that the interface actually
  starts before it builds anything. Nothing in the previous checks ever loaded
  the interface, which is how 5.5.0 shipped with a sidebar that drew nothing —
  a release that reproduces that failure now stops instead of publishing.
- Running the test suite against a filename that does not exist is refused by
  name instead of quietly reporting success over a run that executed nothing.
- The test suite now refuses to report success when a filter (a test-name or
  skip pattern) matched nothing at all. It previously counted the files it had
  opened and filtered away as passes, so a mistyped pattern produced a green
  run with a plausible-looking number of passing tests and nothing verified.
- The release's startup check now runs against a clean, throwaway profile
  rather than whatever state the app on that machine had accumulated, so a
  failure that only affects a first-time user can no longer pass it. It also
  fails instead of hanging if the app never finishes starting.
- Removes the Boiling Pot, the per-file token-carriage report on the View menu,
  along with the background counting that fed it. It was built to find files
  being read wastefully; measured against a month of real usage, the waste it
  was looking for came to well under a tenth of a percent of spend, and most of
  what it did find was scratch files rather than code. Nothing else used it, so
  it went rather than kept collecting. Existing counter files are left alone.

## 5.5.1 — 2026-08-11 — v5.5.0 loaded no sessions; upgrade straight past it

- **Fixes a v5.5.0 regression that left the sidebar empty.** 5.5.0 moved the
  file peek and report panel to the document root so they would stop opening
  behind the inbox drawer. They landed after the tag that loads the interface,
  which runs while the page is still being read, so both were missing at the
  moment the code that wires them looked for them. That threw, and the throw
  stopped the rest of the interface from starting — no session list, no agents.
  Only 5.5.0 is affected; 5.4.0 and earlier are fine, and the stacking fix that
  release shipped is unchanged and still works. If you installed 5.5.0, replace
  it with this build.

## 5.5.0 — 2026-08-11 — notes you can click, folders you can browse

- **Links and file paths in inbox notes are now clickable.** Agents routinely
  put a URL or a `renderer.js:71` in a `[agent:notify-user]` note, and both used
  to be dead text you had to retype. A URL opens in your browser; a path opens
  the same file peek a path click in the terminal does, jumping to the line if
  the note named one. Paths in notes whose author has since exited cannot be
  resolved and say so rather than failing silently, since notes deliberately
  outlive the seat that raised them.
- **The Workbench can now browse any folder, not just the session's own
  directory.** "Go to Folder…" in the Files panel opens a native chooser, and
  "Up" steps to the parent. The chosen folder becomes the working root for
  Source Control too, so the two panels can never end up showing different
  trees — if you browse into a different repository, Source Control shows that
  repository. The banner that already appeared for a selected worktree now
  appears for a browsed folder as well, and says "folder" rather than
  "worktree", because it is what tells you which tree a Commit is about to
  write to. Clicking it returns you to the session directory. Nothing is
  remembered across restarts: Clodex always reopens on the session's own
  directory.

- **Keep-warm can now be set to "Always" on a session that should never go
  cold.** The fire button's menu gains an Always option next to 1/4/8 hours.
  Unlike a duration it is a property of the seat, not a one-off arming: it has
  no deadline, and it re-arms itself when you restart Clodex, so a lead agent
  stays warm through an absence longer than you planned for. It still stops on
  its own if two pings are rejected in a row. When the rejection is your
  credentials — which Clodex cannot refresh for you — the setting is cleared
  along with it, so it will not quietly start again on the next launch; a
  rejection of any other kind stops keep-warm for this run only and leaves
  Always set, so restarting Clodex picks it up again. Picking a duration
  afterwards replaces it. The button reads "held always" rather than counting
  down to a deadline that does not exist. Available on sessions whose keep-warm
  is handled in-process; sessions routed through an external proxy keep the
  1/4/8 choices.

- **Keep-warm no longer gives up because your network hiccupped.** A dropped
  connection, a closed laptop lid, or an overloaded upstream now counts as a
  ping declined rather than a ping failed, so it does not spend the two-strike
  stop. Only a rejected credential does. Before this, two unlucky minutes
  offline were enough to switch keep-warm off — and on a seat set to Always,
  to erase that setting for good while you were away from the machine.

- **Keep-warm survives `/clear`.** Clearing a session's context starts a new
  conversation underneath it, and the keep-warm hold used to stay attached to
  the old one — leaving the session quietly going cold until Clodex was
  restarted. It now hands over to the new conversation, and the old one is
  released rather than left behind burning a little CPU every minute for the
  rest of the session.

- **Peer sections in the sidebar fold, and a new workspace starts folded.**
  Click a peer's header to collapse it — the caret and the hidden-session count
  match the local group headers. The fold is remembered per workspace, so a
  workspace opened for one project no longer greets you with every session on
  every peer you have ever connected to; peers stay folded until you open them
  there, including peers that appear for the first time. Pausing a peer is also
  reachable again: it is on the header's right-click menu, and unlike the ⓘ
  popover's button it works on a peer that is offline — which was the one case
  where you could not pause at all. The popover's button now says "Pause" too,
  matching the "paused" the header has always shown.

- **The file peek opens above the inbox drawer, not behind it.** A path
  clicked in a note used to open the peek underneath the drawer that
  launched it. `#main` is `position: fixed`, so a full-screen overlay
  nested inside it was flattened to `#main`'s stacking order however high
  its own z-index; the peek and the report panel now live at the document
  root. Also fixed for the report panel, which had the same latent trap.
- **The Workbench's browse controls no longer appear on the web frontend.**
  "Go to Folder…" and "Up" are desktop-only: repointing the root from a
  browser would let the read methods walk any directory on the server, so
  the write is refused there. The buttons used to be present and fail into
  a toast; now they are absent.

## 5.4.0 — 2026-08-10 — A branch and a checkout for every teammate

- **Teammates can now work on the same repo at the same time, each in its own
  checkout.** `[agent:spawn name:X cwd:Y worktree:<branch>]` boots the new seat
  in its own `git worktree` on that branch, so two agents editing the same
  project no longer fight over one working tree — one can be mid-edit on a
  feature while another runs the tests. The branch is created if it does not
  exist and checked out if it does, and the tree is removed along with the
  session when you delete it. A spawn that fails cleans up the tree it made
  rather than leaving it behind.

- **A team role can now get a branch and a checkout per ticket, automatically.**
  Set `"worktree": true` on a role in its `team.json` and every ticket the lead
  opens for that role mints a branch named after the ticket, spawns a teammate in
  its own branch, and points the ticket at that teammate rather
  than the role. The teammate starts in the project as usual and is told where
  its worktree is, at the top of the ticket. One ticket, one branch, one
  teammate — so several can run at
  once without sharing a working tree, and the branch is there to review and
  merge whether or not the teammate is still alive. Roles are opted out by
  default, so existing teams work exactly as before. If the worktree cannot be
  created the ticket is still opened and stays with the role — it never quietly
  falls back to the shared checkout. The branch forks from the tree the lead is
  actually looking at, not from the default branch, so a ticket written against
  unpushed work reaches its teammate as described. Filing a ticket ahead of time
  and releasing it later gets the same treatment as opening one directly.

- **Re-assigning a ticket that already has a checkout does the right thing
  either way.** Assigning it back to its role while its teammate is still working
  now just re-sends the spec to that teammate, instead of handing the ticket —
  and the location of its checkout — to whichever teammate answered for the role
  first, who was mid-work in a different branch. And if the teammate is gone, the
  same command brings up a replacement on the *existing* checkout, so the commits
  it left on the branch are still there; previously the ticket came back
  unassigned with a git error. A checkout you deleted yourself is noticed and a
  fresh one made, rather than the teammate being sent to a directory that is no
  longer there. If the teammate is merely archived rather than gone, the ticket
  says so and tells you the two ways out — unarchive it, or delete the session to
  free the name, which also deletes its checkout, so anything left uncommitted
  there goes with it (committed work stays on the branch). And a ticket whose
  checkout is still held by a live teammate is not moved to another one: you are
  told who holds it, and nothing is changed — not the ticket, and not the teammate,
  which is never told its ticket moved when it did not. That holds whichever
  teammate or role you were moving it to, including ones that have no checkout of
  their own, since it is the ticket's checkout at stake. A parked ticket also stays
  parked through a refused move rather than being quietly dispatched by it.

- **Deleting an old teammate no longer deletes the checkout its replacement is
  working in.** When a ticket's replacement takes over the existing checkout, the
  old teammate's session stops pointing at it, so deleting that leftover row does
  what it says instead of pulling the tree out from under the live one. That holds
  whether the replacement inherited the checkout or got a fresh one in the same
  place — deleting a checkout's folder by hand frees the name, and the next one
  lands right back on it. It also holds when the teammate started up and then
  failed partway: its checkout is still recorded against it, so deleting it
  removes the tree instead of leaving it behind with nothing pointing at it.

- **Deleting a worktree's folder by hand no longer burns its branch.** git keeps
  the bookkeeping entry when the directory disappears from under it and then
  refuses to check that branch out anywhere else — `already used by worktree at`
  a path that no longer exists. Clodex now clears those dead entries before
  making a worktree, so a branch stays usable after an `rm -rf`.

- **Teammates now commit their own work, and the lead merges it.** The shipped
  team prompts previously told every hand never to commit, which made sense when
  they all shared one working tree and would have been committing over each
  other. With a branch and a checkout each, that rule left their work invisible:
  nothing a reviewer or the lead could look at until it was hand-carried. A hand
  now commits to its own branch as it works, the lead merges after the review
  verdict, and pushing stays with you. A hand that is *not* in its own worktree
  still leaves committing to the lead.

- **A teammate working in a worktree stays on its team.** Team membership was
  decided by directory: since git puts a worktree *beside* the project rather
  than inside it, a seat that moved into one silently dropped off the roster and
  stopped being reachable for tickets — which the lead saw as "no live seat yet",
  a waiting message for something that was never going to arrive. A team is now
  identified by its repository, so every worktree of it counts as the same
  project.

- **Agents stopped being told to reply to notifications that nobody sends.**
  Roster and team notices arrive from a stand-in sender called "team", and each
  one invited a reply. Session names are shared across the whole app, so if any
  session happened to be named `team`, those replies went to it — an unrelated
  agent, in another workspace, receiving fragments of conversations it was never
  part of. System notices no longer advertise a reply address. The same applied
  to `reminder`, `memory` and `reboot`.

- **An agent asking for its team's ticket board now receives the board.** A
  registered exec command replies to the agent with the last line of what it
  printed, which is the right answer for a command that reports a single verdict
  and the wrong one for a listing — the agent that asked for its tickets got the
  footer ("200 done, 33 cancelled") and no rows, and nothing about the reply said
  a board had been dropped. A command whose answer is genuinely several lines can
  now say so in its definition (`replyMaxBytes`) and have those lines delivered,
  with an explicit note when there were more than the budget allowed. Commands
  that report one line are unchanged.

- **A malformed monitor request can no longer write outside its own directory.**
  `clodex-monitor` used the agent name and monitor id from the request as
  directory and file names without checking them, so a request naming a path
  instead of a name could reach elsewhere on disk — including the file cleanup
  removes. Both are now checked, by the same rule the rest of the app uses for
  session names.

- **A resumed agent is now told when Clodex was upgraded underneath it.** An
  agent's system prompt is written once, when its conversation starts, and
  rewriting it later would re-bill the whole conversation — so a session you
  resume after updating Clodex carries the prompt it was born with. Until now it
  learned about the new version only if the prompt's own text had changed, which
  most releases don't do: an intent that kept its name but changed its arguments
  would just quietly keep being used the old way.

  Such a session now receives one line at its next message, naming the version
  it was last running under and the one it is running under now, and saying the
  running app wins where the two disagree. Sessions started fresh get nothing —
  they are already current. Nothing is sent for an upgrade that happened before
  this feature existed, since there is no record of what to compare against; the
  first resume establishes the baseline and the next upgrade is announced.

  Underneath it is a general per-session notice queue, so future one-off
  advisories that are in no rush can ride the same channel.

- **A peer reached over `https://` is now actually encrypted.** Clodex has
  always accepted an `https://` peer URL, and the command-line client always
  dialled it properly — but the app's own peer connection dialled every peer in
  plain HTTP regardless, while sending your peer token on each request. If you
  run a peer over TLS, that token was going over the wire in the clear. It now
  dials TLS for `https://` URLs, on port 443 unless you name another.

  One consequence to know about before you update: a peer whose certificate is
  self-signed or issued by a private CA will now fail to connect rather than
  quietly falling back to an unencrypted connection. That is the point of the
  fix, but it is a real change if that describes your setup.

- **Agents whose names begin with `_`, `.` or `-` can reach the network again.**
  Such a name has always been legal to create, and the session looked completely
  healthy — but the request router rejected it, so every request that agent made
  failed and it never reached Anthropic at all. The router now accepts the same
  names the app lets you create. Paths like `..` stay refused.

- **A container mount at `/` is refused instead of silently shadowing
  everything.** The sandbox checks that your mounts do not collide with the
  directories it manages, and every specific one was caught correctly — but `/`
  itself slipped through the check and took precedence over all of them.

- **Host paths with unusual characters no longer corrupt the sandbox config.** A
  directory containing a quote, a backslash or a newline produced a broken
  container definition; a Windows-style path could stop it loading entirely.

- **The new-session directory suggestions no longer span workspaces.** The
  "popular" list was built from every session on the machine, so it could
  suggest — and reveal — directories belonging to a different workspace. It now
  reflects only the workspace you are in, which does mean a shorter list.

- **A dropped streaming connection now gives up instead of retrying forever.**
  If reconnecting succeeded but the handler setting it up kept failing, the
  retry budget reset on every attempt, so the backoff never grew past its first
  step and the give-up path was never reached.

- **A workspace holding only archived sessions no longer looks empty.** The
  workspace rows in the Window and tray menus counted running sessions only, so
  a workspace whose seats were all archived showed no session count at all —
  the same way a genuinely empty one does. Choosing Delete Workspace… from that
  row then warned you about deleting the sessions the label had just implied
  were not there. Rows now count both, naming the running subset when the two
  differ ("3 sessions (1 running)"), and the delete confirmation counts both
  populations at click time rather than reusing a number captured when the menu
  was built — a tray menu can sit open for minutes.

- **The cache-bust inspector opens in about a second instead of sixteen.**
  Vendored wirescope v0.6.48, which decides each turn's verdict from the billing
  receipts it already has rather than re-reading every request body, and leaves
  the per-turn detail out of the response unless something asks for it. The
  popover shows the same numbers; it just stops downloading five megabytes to
  render them. The session navigator's turn view got the same treatment and is
  now roughly eight times faster.

## 5.3.0 — 2026-08-08 — a switch the serving box can actually reach

- **Terminal sharing moved to Settings, and now works on a box with no peers of
  its own.** The switch that lets a peer open a terminal on your machine used to
  live on each peer's info popover — but the thing it controls is one box-wide
  capability, not a per-peer permission, so a box that only *serves* (a server
  deployment with nothing dialled out from it) had no peer row to put the
  checkbox on and could never turn it on at all. That was the reported symptom:
  the peer's sessions show up, bash sessions open fine, and the Terminal tab
  never appears.

  It is now a single checkbox in **Settings ▸ Phone access ▸ Terminal sharing**,
  beside the other things this box serves. If any peer had it ticked before, the
  box keeps serving; if none did, it stays off — an upgrade never switches this
  on or off for you. The "sharing is on" indicator moved with it, from the peer
  row to the sidebar header, so it is still on screen without opening anything.

  Settings now also says what the switch actually exposes: a peer does not get a
  shell of its own, it attaches to the same drawer shell your Terminal tab
  shows, is handed its scrollback, and can type into it while you are. Turning
  it off still closes any remote shell already open.

## 5.2.0 — 2026-08-08 — your terminal, on your terms

- **The terminal reporting checkbox is now three choices.** It used to decide
  two unrelated things at once: whether the agent could run a command in your
  Terminal tab at all, and whether it was told about every command *you* ran
  there. Wanting the first without the second — let it run something when you
  ask, but stop narrating your own work — was not expressible, so the only way
  to stop the stream was to switch the whole feature off.

  In Settings the choices are now **Off** (no marks; the agent cannot run a
  command there either, since it would never learn one had finished), **Only
  what the agent asks for**, and **Everything I run too**. Existing setups keep
  what they had: the box ticked becomes "everything", unticked becomes "off".
  Nothing is switched on for you.

- **Switching the stream off now takes effect at once, and takes your queued
  commands with it.** Reports wait for your next message rather than
  interrupting the agent, so switching off used to leave the last few commands
  sitting in the queue — and the next thing you typed sent them anyway. Those
  pending reports are now discarded, and the change applies to terminals
  already open rather than the next one. Reports already merged into a
  conversation cannot be recalled, and Settings says so.

  Also stated plainly there: terminal reports are sent **verbatim** — a command
  line carrying a token, a password in a URL or an `Authorization` header goes
  as written. The redaction mentioned for panel selections applies to that
  feature only, which the wording no longer leaves ambiguous.

- **A terminal command whose result the shell could not label is no longer
  discarded.** Running `[agent:term exec] pwd` twice in a row answered "finished,
  but the shell did not report which command ran" — with no exit code and no
  output — even though both had been captured correctly. Bash declines to add a
  repeated command to its history, and Clodex read the unchanged history number
  as "we do not know what this was" and threw the whole answer away. Since a
  stock Ubuntu sets `HISTCONTROL=ignoreboth`, this hit every repeated command on
  a Linux box, including the very first command in a new terminal when the same
  one was the last thing run in the previous one.

  An agent that asked for a command now gets its exit code and its output back,
  under the command it sent. Where the shell genuinely did not confirm what ran,
  the answer says the name is *assumed* rather than reported, and warns that if
  the operator ran something at that moment the output may be theirs — so the
  agent can tell a confirmed result from an inferred one.

- **More commands are reported by name on Linux terminals.** Where the shell
  skipped a history entry only because the command repeated one, Clodex can now
  say what ran instead of reporting it unnamed. Where a command was kept out of
  the history on purpose, it stays unnamed, deliberately — guessing there would
  attach an unrelated command's name to output the operator meant to keep out of
  the record. That covers a shell with history switched off, a command typed with
  a leading space on a shell set up to skip those, and any shell with a
  `HISTIGNORE` pattern list, where there is no way to tell whether a given
  command was one of the skipped ones.

## 5.1.1 — 2026-08-07

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
