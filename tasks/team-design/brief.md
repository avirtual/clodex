# Brief: what a Clodex team should be

Design task. Reason, do not implement. No file sweeping — the mechanism is
described below by the person who built it and is its only user. If you need a
file, read exactly that file; do not survey.

Prior art in this repo, worth reading for method and for its writing rule:
`tasks/durable-state/design.md` (by the previous designer instance, same seat).
Several instances cited below are the same events it analyzes, seen from a
different angle: it asked "why did the record go wrong," this asks "why did the
team let it."

## The situation

Clodex runs several CLI agents (Claude Code, Codex) side by side as PTY
sessions with inter-agent messaging. On top of that sits a **team** mechanism:
a manifest names roles, seats are spawned against roles, and a lead dispatches
work to them through tickets.

It works. It has been in daily use for weeks. But it has had exactly **one
team, on one project, with one operator** — and that project is Clodex itself.
Every default, every role, every rule in the role prompts was derived from
building the tool with the tool. The question is what of that is real and what
is an artifact of the sample size being one.

The goal is teams that are **agnostic** (nothing about them assumes this
project, this domain, or software at all), **versatile** (they bend to how a
given project actually works rather than imposing our shape), and **not a PhD
to set up** (a user who has never read the source can get a working team and
understand what they just got).

## The mechanism as it exists

**Manifest.** `~/.clodex/teams/<name>/team.json` — outside the project, never
in the user's files. Keys: `lead` (a seat name), `root` (absolute project path;
one team per root, enforced), `roles` (object). Created via a `team:create` IPC
that adopts the calling session as lead.

**Role definition** keys: `instantiate` (`session` | `subagent`), `prompt` (a
system-prompt file name), `brief` (one line, shown in rosters), `template` (a
spawn template name), `tools`, `standing`. Stock roles seeded at create:

- `lead` — "holds durable context, dispatches specs, verifies and integrates."
- `hand` — `instantiate: session`, "implementer; executes a spec to done, one
  distilled report per task."
- `reviewer` — `instantiate: subagent`, tools capped to `Read/Grep/Glob`.

`reviewer` is **reserved**: reached only through an `[agent:team-review]`
intent, which spawns the seat itself, forces the CLI type, and enforces the
tool cap in code (the manifest is agent-writable, so caps cannot live there).
The verdict returns as `[agent:review-done]` and the seat retires.

**What each seat is told.** Three injected lines: your seat name, your team and
root, your role, and one line of derived dispatch grammar (which intents reach
which roles — computed from the manifest, not stored). Plus a role prompt:
three shipped markdown files, **103 / 123 / 64 lines**, carried by every seat
for its whole life.

**Tickets.** A team-scoped durable store. `[agent:task add <role>]` + spec body
opens a ticket and delivers it to that role's live seat (or queues it as
backlog). Also `assign`, `done`, `reject`, `cancel`, `list`. A ticket assigned
to a live seat that goes quiet past a stall window nudges the lead once.

**Editing.** A GUI popover edits roles with no hand-editing of JSON. `lead` and
`reviewer` rows are read-only (operator-owned topology). Removes/renames
fail-closed when a live seat or open ticket still encodes the role.

**Composition in practice, all of it:** a lead (this operator's main seat), one
`hand`, ephemeral reviewers, and recently one `designer` role on a different
model tier for reasoning-heavy work. Never more than two live workers at once.

## Evidence: what actually went wrong, in real use

Every one of these is a real event, not a hypothetical. Most are from a single
day. They are the entire empirical base — treat them as such, including the
possibility that a general design cannot be induced from them.

1. **The stalled hand.** The lead told the hand "hold, don't touch this file"
   in a direct message, then later assigned it work via a *ticket* — a
   different channel. A GUI restart respawned the hand in between. The hold
   survived (it was in the resumed transcript); the ticket assignment did not.
   Verified in code: ticket delivery is one-shot, and a respawned seat sees
   open tickets only as bare IDs. The hand sat idle, correctly obeying an order
   nobody had lifted. The lead noticed only because the operator said "i think
   your hand is in a state of limbo."

2. **The phantom teammate.** The roster listing showed a role *definition*
   alongside live seats, in the same list, without distinguishing them. The
   lead messaged a seat that did not exist and got no error it understood.

3. **Watchdogs that fire after the fact.** The lead sets a self-reminder on
   dispatch (because a crashed hand never reports, and delivery is passive so
   the lead never wakes). Three fired *after* the work had completed — the
   falsifying event was invisible to the timer. Cost: three unnecessary wakes,
   each re-billing the lead's full context.

4. **Status traffic that costs more than the work.** A monitoring command was
   set to wake the lead on each output event; a single release run woke it ~20
   times, and 9 of those were content the lead had itself written 30 minutes
   earlier being read back. The operator flagged it directly.

5. **The re-run suite.** A task artifact said a test suite was "running at time
   of writing." A restarted lead could not distinguish *finished green* from
   *died with its process*, and re-ran it. (Analyzed in the durable-state
   design; included here because the durable-state fix is a writing rule, and
   the question of whether a *team* mechanism should make it unwritable is
   open.)

6. **The seat that vanished mid-thread.** While this brief was being written,
   the designer seat was archived out from under an active thread. The lead
   found out from an incidental system notice, not from any team mechanism.
   Nothing in the ticket or roster layer treats "the agent I am mid-conversation
   with no longer exists" as an event.

7. **The lead is the merge queue and does not know it.** All verification and
   integration funnels through the one seat whose context is most expensive.
   There is no mechanism that makes that pressure visible, and no guidance on
   the point where adding a worker starts costing more than it saves.

## What to produce

An artifact at `tasks/team-design/design.md`.

**1. What a team is FOR.** Give a discriminator a user can apply *before*
setting one up, to decide whether a team beats a single agent on their work.
The current claim, asserted in a role prompt and never measured, is that a lead
plus a cheap disposable worker costs less than one agent doing everything. Name
the conditions under which that is true. Name, concretely, the work for which a
team is the wrong choice — that section is not a disclaimer, it is half the
design, and its absence is why a new user can spin up three seats for work that
wanted one agent and conclude the feature is theater.

**2. The role vocabulary.** Are `lead` / `hand` / `reviewer` primitives, or are
they three points our single sample happened to occupy? Derive the minimal set
from a property (what distinguishes roles from each other — context lifetime?
verifiability of output? authority? tier?) rather than from our usage. If the
right answer is that roles should not be a fixed vocabulary at all but
generated from such a property, say so and show what the user names instead.

**3. Setup.** Zero to a working team. What is the smallest thing a user does,
and what should they get? Consider seriously whether the default should be a
team of ONE (the lead alone, with the machinery latent and roles added when a
real need appears) versus the current seed of three roles. A user who cannot
articulate what their `hand` is for has been handed a cost they cannot evaluate.
Whatever you propose, state what the user must *understand* to use it — that
budget is the real setup cost, not the clicks.

**4. Adjudicate the seven instances.** For each: design defect, implementation
bug, or correct behaviour the operator misread? Which generalize beyond this
project, and which are artifacts of the lead being the tool's own author? A
finding that some of them are *not* worth fixing is a real finding. Instance 1
in particular: is one-shot ticket delivery the bug, or is a lead who holds
orders in one channel and work in another the bug?

**5. Prompt economics.** 290 lines of role prompt, carried by every seat for
its entire life, re-billed on every turn. Some of it is load-bearing; some is
scar tissue from specific expensive mistakes, written as a rule without the
experience that makes it legible. Which is which, and what is the principle for
deciding? Note the two structural constraints: a rule that must survive context
pressure cannot depend on the agent remembering to apply it, and a rule the
agent has no way to *check* it followed is decoration.

**6. Versatility.** What does a team look like on a project that is not
software — a writing project, a research thread, a data analysis? Does the
mechanism bend or break? Be specific about which parts are secretly
software-shaped (the verification story leans hard on "tests are green," which
is a luxury most domains do not have — what replaces it?).

## Constraints

- Prefer rules and shape over new infrastructure. If you propose something that
  must be built, say so explicitly and carry the argument.
- Nothing may assume this project or this domain. The shipped role prompts
  already say "this project's team," never "Clodex" — hold that line.
- No emojis anywhere (operator standing rule).
- Do not propose putting team state inside the user's project files. Clodex
  never writes to a user's project.
- Where the evidence does not support a conclusion, say that instead of
  inventing one. A design that names its own unknowns is more useful here than
  one that is complete.
- Write to `tasks/team-design/design.md`. Journal outcomes as you go — past
  tense, pinned. Nothing in the present progressive.
