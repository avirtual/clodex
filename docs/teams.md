# Teams — standing one up on your own project

A **team** is a lead agent, one or more implementer seats, and a ticket loop
that carries a spec from the lead to a working branch and back. The engine
itself is project-neutral: tickets, git worktrees, branch-per-ticket, spawn,
review, escalation and merge-forward know nothing about Clodex. The three
shipped role prompts describe how a lead, a hand and a reviewer *behave*, and
name no repository, no test command and no file of ours.

So most of a working team arrives for free. What does not — the handful of
things that are inherently *your project's* — is what this document is about.
Each one is either defaulted, or is a **named file the app tells you to write**.

> Reading order: this is the operator-facing guide. `docs/architecture.md` says
> where the code lives; the modules named here are `team-manifest.js` (the
> manifest schema and its stock role definitions), `team-tickets.js` (the ticket
> loop) and `team-root-expand.js` (the `${TEAM_ROOT}` token).

## What `Create Team…` gives you

From the Teams menu, `Create Team…` writes
`~/.clodex/teams/<name>/team.json` — a small data file:

```json
{
  "lead": "<name>-lead",
  "root": "/absolute/path/to/your/project",
  "roles": {
    "lead":     { "prompt": "clodex-team-lead" },
    "hand":     { "prompt": "clodex-team-hand", "template": "clodex-team-hand" },
    "reviewer": { "prompt": "clodex-team-reviewer" }
  }
}
```

That is the whole team. `root` must be absolute — a relative root would resolve
against whatever directory the app happens to be in. A role carries at most
`prompt` (which system prompt briefs the seat — or, when the template names one
of its own, which prompt is appended after the team block; see *How a role finds
its prompt*), `template` (which template
shapes the seat: model, tools, grants, cwd — resolved against
`~/.clodex/teams/<name>/templates/` first, then the shared library), `brief`
(one line about the role, shown in the roster) and `dispatch` (what a ticket for this role
does: `standing` delivers to the live seat, `spawn` mints a one-shot seat in
the shared checkout, `worktree` mints a one-shot seat on its own branch in its
own git worktree).

With that file alone you have a working loop: the lead writes a ticket with
`[agent:task add hand] <spec>`, `[agent:task start <id>]` mints a branch and a
worktree, spawns a hand seat in it and delivers the spec; the hand commits and
closes the ticket; the loop verifies the branch and escalates or reviews.

Everything below is what you add so that loop is *productive* on your code.

## What a team directory holds

`team.json` is one file in a directory the team owns outright:

```
~/.clodex/teams/<name>/
  team.json                 lead, root, roles
  prompts/system/<stem>.md  role prompts the team owns
  prompts/append/<stem>.md  project knowledge the team owns
  templates/<stem>.json     seat templates the team owns
  exec/<name>.json          exec grants the team owns
```

The loop's own data is *not* here: `tickets.json` and the per-ticket `tasks/`
directories are keyed to the PROJECT, not the team, and live under
`~/.clodex/projects/<leaf>-<hash>/` (`clodex-paths.js`, `projectDirFor` /
`taskDirFor`). One project can be worked by several teams, and a board that
moved with the team would split its own history.

One rule covers all four kinds: a name written without a colon — a role's
`prompt`, its `template`, an `appendPromptFiles` stem, an `execCommands` name —
resolves against this directory first and the shared library second. A name
*with* a colon is a plugin ref (`<plugin>:<stem>`) and never looks here. Team
preflight (the roles popover) says which names resolved to the team's own
copies.

A team's own template is reachable by naming it — from a role's `template`, from
`[agent:spawn … template:<stem>]` by a seat inside the team — and is not listed
machine-wide in the New Session dialog or the library drawers. The same goes for
a reviewer template: name it in the reviewer role, since the reviewer's
prefix-based discovery reads the library only.

Nothing under `teams/` is seeded for you. `Create Team…` writes `team.json` and
stops, so a directory holding only that file behaves exactly as it did before
any of this existed, and every piece its manifest names is served by the shared
library. The one thing that fills the rest of the directory is **Gather**, and
only when you ask for it.

### Gather — make the team own what it uses

Gather walks the manifest, finds every library piece the team references — role
prompts, project knowledge on the append rail, seat templates, exec defs — and
copies each into the team's own directory under the same stem. Nothing is
rewritten: `team.json` is untouched, the templates keep their refs, and the
team-first rule above means the next spawn simply resolves against the copies.

It never overwrites. A piece the team already owns is reported **kept**, a
plugin-namespaced ref (`<plugin>:<stem>`) is **skipped**, and a ref the library
does not have is reported **missing** (preflight is what tells you about those;
Gather cannot copy what is not there). Running it twice is a no-op reporting
everything kept.

Three ways to run it, all the same plan:

- the Gather button on the roles popover — it shows the plan and asks before
  writing;
- `[agent:team gather]` from the team's lead seat, or `[agent:team gather dry]`
  to see the plan without writing;
- the `team:gather` IPC, for anything driving Clodex.

After Gather, the team's copy is the one to edit. The Templates drawer lists
every gathered template under a **Team &lt;name&gt;** heading, below the library
rows and above the plugin ones; Edit and Delete there write back into
`~/.clodex/teams/<name>/templates/`, and that copy is what the next spawn reads.
The library row it was copied from now says **Shadowed by team &lt;name&gt;** with
a button that opens the team copy — because editing the library row after a
Gather changes a file the team's seats no longer look at.

The same plan is also what the roles popover renders under each role, whether or
not you press Gather: every role row lists the pieces it uses — its system
prompt, its template, the template's own prompt, each append stem, each exec
command — with a badge saying **team** (the team owns it), **library** (borrowed
from the shared library), **plugin** (a namespaced ref, never gathered) or
**missing** (it resolves nowhere). A `↳` marks a piece the role did not name
itself and inherited from its template. Because it is the Gather plan rather
than a second walk, it matches `[agent:team gather dry]` line for line, and
applying Gather flips every **library** badge to **team**.

**The trade-off is upstream fixes.** The three stock role prompts ship as
library files precisely so every team keeps receiving improvements to them; a
gathered copy is a fork and stops. So gather when you want the team to be
self-contained — copied to another machine, or removed without leaving pieces
behind — and delete a copy to fall back to the library version.

## The four things your project must supply

### 1. Where the seats run — handled, but know why

A seat needs a working directory. Ticket seats never had a problem here: the
loop boots them itself and ignores what the template says. A worktree dispatch
boots the seat **inside its own tree** — its shell starts where it works, and it
does not load the shared checkout's gitignored `.claude/CLAUDE.md`; a role `cwd`
rides along, re-rooted onto the tree. A spawn dispatch has no tree, so its seat
boots at the team's `root` (or the role's area under it). The seat's record
remembers the shared checkout in `worktree.main`, so a seat whose tree is removed
by hand resumes there instead of failing.

The trap is the *other* spawn paths — the lead's
`[agent:spawn name:X template:Z]` with no explicit `cwd:`, which the lead is
told about in its own team roster, and picking a template in the New Session
dialog. Both take the template's `cwd` verbatim. A template that hardcodes an
absolute path therefore boots the seat **in the project that template was
written for**, while its ticket lives in yours. It looks like a working seat.
It is why this is a trap and not a gap.

The fix is a token. A template may write:

```json
{ "cwd": "${TEAM_ROOT}" }
```

and it is expanded, at spawn time, to the root of the team the *spawner*
belongs to. One template serves every team. The shipped `clodex-team-hand`
template — what `Create Team…` gives your hand role — already does this, so a
fresh team needs no action here.

**If the token cannot be resolved, the spawn is refused**, with a message
saying so. It is never quietly replaced with an empty string or your home
directory: substituting the *wrong* root is worse than failing, because the
seat starts, work happens in a tree nobody expected, and the green result looks
like its own. You will see this if you spawn from a template using the token
while sitting outside any team root — the remedy is an explicit `cwd:`.

The same token works in exec command definitions (below), where it has always
worked.

### 2. Exec grants — the shipped ones, and yours

`[agent:exec <name>]` lets a seat run a pre-registered command. Definitions live
in `~/.clodex/teams/<team>/exec/<name>.json` or `~/.clodex/library/exec/<name>.json`
— the team's copy wins — and a template grants a seat a subset by name. The grant
is still the capability: a def under either directory only shapes what an
already-granted name does.

Clodex ships three definitions and seeds them on first run:

| Command | Portable? |
|---|---|
| `clodex-team` | **Yes** — runs a script Clodex itself ships (`${CLODEX_BIN}`). Roster, ticket list, retire. |
| `clodex-monitor` | **Yes** — same. Runs a long command in the background and DMs the seat its output. |
| `clodex-run-tests` | **Yes** — runs `${CLODEX_BIN}/clodex-run-tests.js`, which runs your `scripts/run-tests.js` (the merge gate's runner) and prints a one-line digest. |

`clodex-run-tests` is the shape to learn from. The one file it needs from you is
`${TEAM_ROOT}/scripts/run-tests.js` — the same runner the merge gate below
already requires, so a project that can merge a ticket can already get a digest.
A def written against a token is portable; the project supplies the one thing
only it can.

The shipped hand template grants all three, because all three work on a fresh
team: a default that fails on first use teaches an operator to distrust the
whole grants list.

**What a stock hand is.** `clodex-team-hand` boots Opus (`--model
claude-opus-5`) with **every skill off**, the trimmed tools list, and those three
exec grants. It is lean on purpose: the first team stood up from the bootstrap
skill came up with Fable-class hands carrying every installed skill, and was
stopped on cost. `[agent:team role-set hand model:<alias>]` changes the model
(`opus`, `sonnet`, `haiku`, `fable`). The template editor's skills popover turns
skills back on — the "every skill off" default ships as the sentinel
`"disabledSkills": ["*"]`, which a save from that popover replaces with the
explicit list of names it is showing.

**To add your own:** drop a JSON def in `~/.clodex/teams/<name>/exec/` — or in
`~/.clodex/library/exec/` when you want every team to share it — write the
script it names under your project root, and add the command's name to your
hand template's `execCommands`. Use `${TEAM_ROOT}` rather than an absolute
path, and the def stays portable to your next team:

```json
{
  "argv": ["/bin/sh", "${TEAM_ROOT}/scripts/my-digest.sh"],
  "cwd": "${TEAM_ROOT}",
  "description": "One line the agent reads before deciding to use this.",
  "timeoutMs": 120000,
  "schema": { "type": "object", "additionalProperties": false, "properties": {} }
}
```

The `description` is not decoration — it is what the seat sees in its prompt,
and it is how the seat decides to reach for your command instead of assembling
the equivalent shell line itself. See `docs/exec-tools.md` for the payload
schema vocabulary.

`timeoutMs` above is a placeholder, not a recommendation. A command that runs a
whole test suite needs far more than two minutes — the shipped
`clodex-run-tests` sits at seven — and the failure it prevents is not the one it
looks like: the wrapper is killed at the ceiling while the work carries on, so a
run that SUCCEEDED loses its report and keeps holding whatever lock it took.

### 3. The merge gate wants `scripts/run-tests.js`

Before a closed ticket reaches a reviewer, the loop runs the branch's own test
suite — a full run, in the ticket's worktree. Order is deliberate: a cold
review is expensive, and paying it for a branch that fails its own suite is the
most costly mistake the loop can make. A red verify run is measured a second
time before it rejects — a green re-run proceeds to review and the record names
the first run, while a second red rejects carrying both runs' failing names.

**Today that step looks for `scripts/run-tests.js` in the worktree**, spawns it
with `--reporter=dot`, and parses TAP output. It also diffs the branch's
`package.json` dependencies against the root checkout's and refuses on drift.

If that file is not there, `_runTicketSuite` reports "could not run" — and
could-not-run is treated as **an escalation, never a rejection**. The hand is
not sent back to redo correct work over a harness it does not control; the lead
is told instead. That degrades *safely*, which is the important half. The other
half: with no runner, **every single ticket escalates to the lead**, so the
loop is usable but not autonomous.

So a project with a different test command has two options today:

- Add a `scripts/run-tests.js` that runs your suite and emits TAP
  (`--reporter=dot` is passed to it), or
- Accept per-ticket escalation and have the lead judge each branch.

A project with **no test suite at all** is a first-class case, not a broken
one — it simply takes the second option, and every ticket lands in the lead's
lap for a judgement call. Nothing rejects work for the absence of tests.

> A configurable `verify` field in `team.json` — declare your own command, or
> declare that the team has none — is designed but **not built**. Do not write
> `verify` into a manifest yet; nothing reads it. Until it lands, the runner
> path above is the whole story.

**The suite runs under a box-wide lock, and that is deliberate.** Two suite runs
on one machine can rewrite files under each other, so `scripts/test-digest.sh`
locks at the team ROOT even when it is measuring a worktree. The consequence is
worth stating plainly, because it looks like a bug the first time it bites: a
hand verifying its own branch holds the lock for the whole run, so an unrelated
ticket's merge can arrive to find the tree busy.

That collision is transient and the loop treats it as such — it waits and
retries, up to ten times and never more than ten minutes, then escalates with a
manual `git merge --no-ff` command. It does not hold the merge queue while it
waits: other tickets merge past a waiting one. Only this one refusal retries; a
dirty tree, a moved branch and a red suite still stop on the first try, because
each of those is a state a human has to look at.

The rule that follows, for anyone reading a refusal: **a lock collision is not a
wedge, and a lock is never cleared by hand.** A refusal names the pid holding
the lock, but a pid file lags its real holder — the printed pid can be dead
while a different live run holds the lock. Check `ps` for a live runner before
concluding anything. Deleting a valid lock deadlocks the two runs it was
protecting.

**One conflict the loop resolves itself: CHANGELOG.md.** Every ticket adds its
bullet at the head of `## Unreleased`, so the second of two in-flight tickets
always conflicts there even when nothing else overlaps. When the ONLY conflicted
path is the root `CHANGELOG.md` and both sides did nothing but insert lines
(nothing deleted or rewritten, no `## ` heading added on either side), the loop
keeps both — master's bullet above the branch's — completes the merge commit and
says so in the `[ticket MERGED]` notice, so you read `## Unreleased` once before
a release. Any other conflict, in that file or any other, still escalates on the
first try.

### 4. Project knowledge — the one file you are expected to write

The role prompts tell a hand how to *be* a hand. They cannot tell it that your
migrations live in `db/`, that the integration suite needs a running Postgres,
or that one directory is generated and must never be hand-edited. That is your
project's knowledge, and it belongs in an **append prompt**.

The shipped hand template names the stem `team-project`. Write it in your team's
own directory:

```
~/.clodex/teams/<name>/prompts/append/team-project.md
```

It rides into every seat whose template names the stem, and it belongs to this
team alone — two teams on one machine can each keep their own `team-project`.

The library path still works and is still the shared one:

```
~/.clodex/library/prompts/append/team-project.md
```

Use it for content that is genuinely generic across every team on this machine.
A team's own copy of a stem wins over the library copy of the same stem.

Clodex ships no `team-project.md` and `Create Team…` writes no skeleton —
deliberately. An empty placeholder would report as "resolved" while the seat
booted with nothing useful, which is worse than a visibly missing file. **The
missing file is the message**: a named, checked-for path rather than a
convention buried in a document.

Write it in your own words. What the project is, what the layout means, how to
run things, what breaks in non-obvious ways.

A team directory carries its own prompts, beside its `team.json`:
`~/.clodex/teams/<name>/prompts/system/<stem>.md` and
`~/.clodex/teams/<name>/prompts/append/<stem>.md`. A stem without a colon
resolves there first and in the library second; a `<plugin-id>:<stem>` ref is a
plugin reference and is unaffected. The library seeder never writes under
`teams/`, so a team's own copy is yours and no upgrade refreshes it under you.

## How a role finds its prompt

A seat's system prompt is the template's `systemPromptFile` when the template
names one; otherwise it is the role's `prompt`. A role `prompt` that did not
become the system prompt is appended after the team block, so a role's briefing
is never dropped: the template supplies the persona, the role supplies the
delta. When both name the same stem it is applied once. This holds for ticket
seats, reviewer seats and `[agent:spawn … template:]` seats alike. Team
preflight notes a role whose two sources disagree, since only one of them is the
system prompt. It also warns when the template's system prompt resolves nowhere,
because that seat boots with no system prompt at all.

Every prompt stem preflight resolves out of a template — the `systemPromptFile`
and each append stem — is left alone when it is a plugin-namespaced ref, by the
same rule the runner applies (`<plugin>:<stem>`, an id before the colon): the
plugin holds that file, teams and the library never do, so checking it could only
produce a false miss. A role's own `prompt` is the exception and is still
checked, because a role prompt is read with no plugins at spawn, so a namespaced
ref there genuinely misses.

A role's `prompt` names a stem, and a stem resolves in two places: the team's own
`~/.clodex/teams/<name>/prompts/system/<stem>.md` first, then the shared library
at `~/.clodex/library/prompts/system/<stem>.md`. The three stock stems —
`clodex-team-lead`, `clodex-team-hand`, `clodex-team-reviewer` — ship as library
files, shared by every team, which is what keeps them receiving fixes rather
than being forked per project. Which of the two answered is the **team** /
**library** badge on that role's row in the roles popover. Their names say "clodex" for historical reasons
only; nothing in their text does.

If you want a divergent prompt for one role on one team, point the role at a new
stem, or run **Gather** (above) and edit the copy it puts under that team's
`prompts/system/` — a copy is a fork, and stops receiving upstream fixes until
you delete it. The recommended change is smaller than either, though: leave the
stock role prompts in the library, where they keep receiving fixes, and put
project specifics in the team's own `prompts/append/`. The role
prompts describe *behaviour*; the append describes *your code*. Keeping that
seam is what lets a Clodex upgrade improve your team's judgement without
touching anything you wrote.

## Scaling the team

Roles are cheap. Add one in the roles popover — click your team in the sidebar —
give it a `template` and a `brief`, and the lead can dispatch tickets to it by
name.
Two seats can hold the same role; a ticket assigned to a role that has a
worktree `dispatch` mints a fresh branch and a fresh seat per ticket, which is
what keeps parallel work from colliding in one checkout.

The lead's team roster spells out the reachable actions for whatever roles exist,
so you do not have to teach it the vocabulary.

## Checklist for a new project

1. `Create Team…`, pointed at your project root.
2. Write `~/.clodex/teams/<name>/prompts/append/team-project.md`.
3. Decide about tests: add `scripts/run-tests.js` emitting TAP, or accept
   per-ticket escalation.
4. Optional: add exec defs for the commands your agents will reach for most,
   using `${TEAM_ROOT}` so they travel.
5. Start the lead seat and open a ticket.

Steps 1 and 5 are the team. Steps 2–4 are the content — yours to decide, though
a lead granted the intents below can write step 2 for you.

An agent can do step 1 instead of you, if you granted it the privileged
`team-create` intent (Settings ▸ the seat's intent checklist — off by default):
`[agent:team create <name> root:<abs-path> [lead:<seat>]]` writes the same
manifest `Create Team…` does. The root must already exist and belong to no other
team; the lead defaults to `<name>-lead` and names a seat that does not exist yet.
The manifest it writes is not an empty one: `lead`, `hand` and `reviewer` are
already in it, all three standing. So the next step is to spawn the lead seat with
its cwd at the root — after the create, never before, because a seat resolves its
team from its cwd at boot and carries that roster for the rest of its life, so one
spawned first never learns it leads — and then to make the hand per-ticket with
`[agent:team role-set hand dispatch:worktree]`. `role-add` is for roles that do
not exist yet; on one that already does it refuses.
`[agent:team set-lead <seat>]` re-points the lead afterwards, and only the current
lead may do it.

Step 2 is reachable from the lead too, so the whole path runs on intents — create,
spawn the lead, `role-set` the hand, then the file verbs below and
`[agent:team role-add …]` for any role the stock three do not already cover:

- `[agent:team template-save <stem>]` + a JSON body writes
  `~/.clodex/teams/<name>/templates/<stem>.json` — the seat template a role's
  `template:` names.
- `[agent:team prompt-save system|append <stem>]` + a markdown body writes
  `prompts/system/<stem>.md` or `prompts/append/<stem>.md` — a role prompt, or
  the project knowledge of step 2.
- `[agent:team template-rm <stem>]` and `[agent:team prompt-rm system|append
  <stem>]` delete one. A template, or a `system` prompt, that a role in
  `team.json` still names is refused: the drawers have no such guard, because a
  person deleting one can see the roles popover and an agent cannot. An `append`
  stem is named by no role, so nothing guards it.

All four file verbs are lead-only, like every other `[agent:team …]` verb, and
write only inside the team's own directory. The library at `~/.clodex/library/` stays yours,
as do the `exec/` defs of step 4 — no intent writes either.

`[agent:team role-add <role>]` and `[agent:team role-set <role>]` take
`dispatch:standing|spawn|worktree` and `cwd:<rel>` beside `prompt:` and
`template:`, so the intent path reaches every field the roles popover edits —
`dispatch:worktree` is the one that makes a hand role mint a branch, tree and
seat per ticket, and without it an agent-built team can only ever add a standing
role. `cwd:` is relative to the team root, as everywhere else. `model:` derives
`templates/<role>.json` from the role's template (or `clodex-team-hand`) with that
`--model` and points the role at it; a bracketed id such as `claude-opus-5[1m]`
cannot be written here, use the alias — `opus`, `sonnet`, `haiku`, `fable`.

`lead` and `reviewer` are operator-owned topology: every role verb refuses them,
so a team you meant to run solo still carries a reviewer definition — harmless,
and the roster renders it as not addressable until a seat exists. `cwd:` names a
directory that must already exist under the root; Clodex never creates it.

The whole sequence is packaged as the **team-bootstrap** skill in the public
plugin library (`avirtual/clodex-plugins:team-bootstrap`, via Plugins ▸ Manage
Plugins… ▸ Install from GitHub…). Install it on the seat you talk to and tell that
seat you want a project that does X and need a team for it: it interviews you for
the name, the lead seat, the shape of the team, how tests run and what the project
is, then emits the create and the spawn and briefs the lead with the rest. It
needs the privileged `team-create` intent on that seat, and says so before it asks
you anything.
