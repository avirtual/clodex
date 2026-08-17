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
`prompt` (which system prompt briefs the seat), `template` (which library
template shapes the seat: model, tools, grants, cwd), `brief` (one line about
the role, shown in the roster) and `dispatch` (what a ticket for this role
does: `standing` delivers to the live seat, `spawn` mints a one-shot seat in
the shared checkout, `worktree` mints a one-shot seat on its own branch in its
own git worktree).

With that file alone you have a working loop: the lead writes a ticket with
`[agent:task add hand] <spec>`, `[agent:task start <id>]` mints a branch and a
worktree, spawns a hand seat in it and delivers the spec; the hand commits and
closes the ticket; the loop verifies the branch and escalates or reviews.

Everything below is what you add so that loop is *productive* on your code.

## The four things your project must supply

### 1. Where the seats run — handled, but know why

A seat needs a working directory. Ticket seats never had a problem here: the
loop boots them at the team's `root` (or in a worktree off it) and ignores what
the template says.

The trap is the *other* spawn paths — the lead's
`[agent:spawn name:X template:Z]` with no explicit `cwd:`, which the lead is
told about in its own team block, and picking a template in the New Session
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

`[agent:exec <name>]` lets a seat run a pre-registered command. Definitions
live in `~/.clodex/library/exec/<name>.json`, and a template grants a seat a
subset by name.

Clodex ships three definitions and seeds them on first run:

| Command | Portable? |
|---|---|
| `clodex-team` | **Yes** — runs a script Clodex itself ships (`${CLODEX_BIN}`). Roster, ticket list, retire. |
| `clodex-monitor` | **Yes** — same. Runs a long command in the background and DMs the seat its output. |
| `clodex-run-tests` | **No** — runs `${TEAM_ROOT}/scripts/test-digest.sh`, which is a script *this repo* happens to have. |

`clodex-run-tests` is the shape to learn from. `${TEAM_ROOT}` expands correctly
for your team — so the grant *follows* your root faithfully and then bounces,
because there is no `scripts/test-digest.sh` there. A def written against a
token is portable; whether the thing it points at exists is your project's
business.

The shipped hand template grants only `clodex-team` for exactly this reason: a
default that fails on first use teaches an operator to distrust the whole
grants list.

**To add your own:** drop a JSON def in `~/.clodex/library/exec/`, write the
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

### 3. The merge gate wants `scripts/run-tests.js`

Before a closed ticket reaches a reviewer, the loop runs the branch's own test
suite — a full run, in the ticket's worktree. Order is deliberate: a cold
review is expensive, and paying it for a branch that fails its own suite is the
most costly mistake the loop can make.

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

### 4. Project knowledge — the one file you are expected to write

The role prompts tell a hand how to *be* a hand. They cannot tell it that your
migrations live in `db/`, that the integration suite needs a running Postgres,
or that one directory is generated and must never be hand-edited. That is your
project's knowledge, and it belongs in an **append prompt**.

The shipped hand template names the stem `team-project`. Append prompts resolve
against the shared prompt library, so **today that stem means exactly one file**:

```
~/.clodex/library/prompts/append/team-project.md
```

Write it there and it rides into every seat whose template names the stem. Note
the consequence of it being the *library*: the file is shared by every team on
this machine. If you run teams on two projects, either keep the content generic,
or give each team's template its own stem (`acme-project`, `beta-project`) and
write one file per stem.

Clodex ships no `team-project.md` and `Create Team…` writes no skeleton —
deliberately. An empty placeholder would report as "resolved" while the seat
booted with nothing useful, which is worse than a visibly missing file. **The
missing file is the message**: a named, checked-for path rather than a
convention buried in a document.

Write it in your own words. What the project is, what the layout means, how to
run things, what breaks in non-obvious ways.

> **Designed, not built:** per-team prompt directories
> (`~/.clodex/teams/<name>/prompts/append/<stem>.md`, shadowing the library so
> each team can carry its own copy of a stem) are designed but **not
> implemented**. Nothing reads that path today — a file placed there is silently
> ignored. Use the library path above until this ships.

## How a role finds its prompt

A role's `prompt` names a stem resolved against the shipped prompt library
(`~/.clodex/library/prompts/system/<stem>.md`). The three stock stems —
`clodex-team-lead`, `clodex-team-hand`, `clodex-team-reviewer` — are library
files, shared by every team, which is what keeps them receiving fixes rather
than being forked per project. Their names say "clodex" for historical reasons
only; nothing in their text does.

If you want a divergent prompt for one role on one team, point the role at your
own stem. The recommended change is smaller than that, though: leave the role
prompts alone and put project specifics in the append file above. The role
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

The lead's team block spells out the reachable actions for whatever roles exist,
so you do not have to teach it the vocabulary.

## Checklist for a new project

1. `Create Team…`, pointed at your project root.
2. Write `~/.clodex/library/prompts/append/team-project.md`.
3. Decide about tests: add `scripts/run-tests.js` emitting TAP, or accept
   per-ticket escalation.
4. Optional: add exec defs for the commands your agents will reach for most,
   using `${TEAM_ROOT}` so they travel.
5. Start the lead seat and open a ticket.

Steps 1 and 5 are the team. Steps 2–4 are the parts only you can write.
