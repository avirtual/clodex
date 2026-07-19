# Teams — projects get teams, not sessions (design draft)

Status: DESIGN SETTLED (all rulings in); implementation begun 07-19, targeting
the v3.x line. **AMENDMENT 07-19 (supersedes the in-repo manifest wherever
this doc states it):** no clodex resource may live inside project files —
opening a repo in clodex must leave zero artifacts in it. `team.json` moves
from in-repo `.clodex/team.json` to `~/.clodex/teams/<team-name>/team.json`
with a required `root` field (absolute project path); resolution scans teams
and picks the deepest `root` containing cwd. Task artifacts move with it
(`~/.clodex/teams/<name>/tasks/<id>/`). Consequence, accepted: the team
definition is operator-local and does not travel with the repo — teams are an
operator concern, not a project concern. Team info reaches seats via added
context + `clodex-team` roster, not by reading a repo file.
Landed so far: `team-manifest.js` (project root + manifest
validation, pure leaf), registry entries carry `cwd` (agent→project join for
external tools), core `team-retire` routing (`_handleTeamRetire`: authorize →
archive → passive confirm; renderer keeps an archived row), `clodex-team` exec
command (roster/retire), task ledger (`scripts/task-ledger.js`: per-task
tokens×tier from transcripts, requestId dedupe, REOPENED flag, unattributed
bucket), and a draft lead standing prompt
(`~/.clodex/library/prompts/system/clodex-team-lead.md`, unreviewed). Deferred by
ruling #8: persisted role field (roster joins by cwd for now),
auto-spawn-lead-on-open. Co-designed by `clodex` (codebase grounding)
and `designer` (unanchored design pass); sections marked ⚙ are verified against
the code, sections marked ✏ are open design space.

**DECISION 07-19 — role prompts attach via APPEND, not replace** (Bogdan's
lean, designer cold-verified). Role prompts ride `--append-system-prompt-file`
on top of the full CLI base, carrying only the role DELTA; they do not seize
the base via `--system-prompt-file`. Reasons that held: append composes
(chaining: base → team-block → role → operator), it leaves the base slot free
so an operator's own system prompt still coexists, and coding roles inherit the
CLI's coding grounding for free. Replace is NOT a peer rail chosen by role
category — the earlier "coding appends, non-coding replaces" line was wrong:
the CLI base is two fused strata, a HARNESS contract (tool/permission
discipline, comms norms, turn mechanics) every seat needs, and DOMAIN grounding
(coding behavior). A non-coding seat still needs the harness stratum, so it
appends + a frame that demotes the coding stratum ("you are an X; the coding
conventions apply only when you touch code") rather than replacing. Replace is
an escape hatch, earned per-role ONLY when the base actively fights the role and
counter-instruction demonstrably fails (append can compose but cannot SUBTRACT)
— evidence-gated, and logged as a fork with a named CLI-base re-sync
obligation. Append-chaining rules to honor: write deltas as additive
specialization ("in addition, as the lead…"), never adversarial negation
("disregard the earlier…") — conflicting layers blend/hedge, they don't
clean-override; stack order is base → team-block → role → operator (operator
last, human wins ties); every layer bills every turn, so a layer earns its rent
or folds into a neighbor. WATCH: 2+ "ignore the above" counter-instructions in
one role prompt is the replace-escalation signal. FUTURE MECHANISM (not built):
`rail: append|replace` front-matter per prompt file with a spawn-time mismatch
refusal, so a delta loaded as a full prompt (or vice versa) fails loud, not
silently — matters because the library already mixes rails (`trader-*` are full
prompts, `clodex-team-*` are deltas).

## The idea

Clodex today hands operators raw sessions. The proposal: a **project gets a
team** — solo by default, scaled up/down dynamically by a **lead** agent as it
sees fit. Right model for the right job (expensive model judges, cheap model
executes). Memories gain a **project scope**, not just per-agent. Some agents
are semi-ephemeral: spawned for a task, retired when idle. The operator's
default point of contact is the lead, not every role.

## ⚙ What the codebase already gives us

Most of the substrate exists; this feature is more *composition* than
construction.

| need | existing primitive | state |
|---|---|---|
| role definition | template (`~/.clodex/library/templates/*.json`): type, model (via extraArgs), cwd, system prompt file, tool/skill gates, exec grants, intent gates, proxy, stripLevel | shipped |
| lead spawns a role | `[agent:spawn name:X template:Y]` — template config applies verbatim incl. grants; workspace inherited from spawner; permission posture rides template extraArgs (session-manager.js:2843-2900) | shipped |
| scale down / back up | archive (record + conversation kept) / resume (`--resume`, full context back) | shipped, **operator-only** |
| cheap one-shot work | Agent-tool subagents: ephemeral, per-call model down-tier, wirescope context/tool trimming, zero lifecycle cost | shipped |
| lead tracks workers w/o turn cost | passive delivery class (`delivery:'passive'` → parks, rides next organic turn) + clodex-monitor | built, uncommitted |
| lead-side control plane | exec-tools pattern (`[agent:exec <cmd>]`, operator-granted per seat, schema-validated) | built (docs/exec-tools.md) |
| project grouping | workspaces (one window per project, sessions carry workspaceId) | shipped |

## ⚙ What's genuinely missing

1. **Retire.** A lead can spawn but cannot archive/kill a session. The one new
   capability primitive. Fits the exec-tools pattern (`clodex-team` command)
   — no new intent grammar, operator-granted per seat.
2. **A team record.** Nothing ties "this project's roster" together: which
   roles exist, which template each maps to, who the lead is. Today that
   knowledge would live only in the lead's context — and die at compact.
3. **Project memory.** The memory store is per-agent. Roles that are retired
   and respawned need somewhere durable to have left what they learned.
4. **Name scoping.** Sessions are keyed by name globally; two projects can't
   both have a seat named `reviewer`. Teams need per-project role identity.

## Economics (why this saves tokens, and when it doesn't)

- The win is **cross-tier**: bulk tokens (file reading, test loops, diff
  iteration) land in a cheap model's context; the expensive lead spends
  hundreds of tokens on instruction + report. Second-order: the lead's context
  stays small → fewer compacts, warm cache, sharper for longer.
- The tax is **verification**: if the lead must pull the worker's inputs into
  its own context to check the output, it paid twice. Rule of thumb for the
  lead's standing prompt: *delegate down-tier what you can verify without
  reading its inputs* (tests green, symbol found, build passes). Expensive-
  verification work (design judgment, prose) stays up-tier.
- Same-tier delegation buys context isolation only; it is not a cost win.

## Role vs subagent (the routing rule)

**A roster entry must be earned by accumulated state** — the role gets better
at its job across tasks (a reviewer internalizing project conventions). Signals
that all reduce to the same thing: needs to be DM-able mid-task, needs to
*initiate* (report in unprompted), operator wants it visible in the sidebar.

Everything else — one-shot searches, mechanical edits, scoped audits — goes to
**skills that spawn subagents**, down-tiered per call. Most "team scaling"
should never touch the roster. Consequence: rosters stay small (lead + 1-3
roles), and the `clodex-team` verb set stays small. Roster entries are earned,
not default.

## ✏ Proposed shape (v1 — to be reconciled with designer's pass)

### Team manifest

Per-project file, in-repo so it versions with the project:
`.clodex/team.json` (name TBD):

```json
{
  "lead": "lead",
  "roles": {
    "lead":     { "template": "fable-lead",    "standing": "prompts/lead.md" },
    "designer": { "template": "fable-design" },
    "runner":   { "template": "haiku-runner",  "ephemeral": true }
  }
}
```

- `template` — library template name (model/type/gates/posture live there).
- `standing` — optional project-local prompt appended at spawn (role's
  project-specific charter; templates stay project-agnostic and reusable).
- `ephemeral` — advisory: the lead should retire this role when idle.

### Lifecycle

- **Open project** (open the workspace) → spawn the **lead only**, per
  manifest. Other roles exist as manifest entries until the lead needs them.
- Lead spawns roles via existing `[agent:spawn]` + manifest templates; retires
  via the new `clodex-team` exec command (`retire` = archive, resumable).
- Session naming: prefix convention `<project>-<role>` (e.g. `shop-reviewer`)
  solves global keying with zero core changes in v1. (First-class scoping is a
  v2 question.)

### Project memory

File-based in v1: `.clodex/memory.md` conventions — exactly what this repo
already does by hand. The lead curates it; role standing-prompts point at it;
a retired-then-respawned role reads it at start. No core change. Extending the
native memory store with a project scope (the `scope=` tag already exists on
units) is v2 if files chafe.

### Operator experience

- Lead is the **focus default, not a wall**: sidebar still shows every live
  session, IPC log still shows all traffic. A wedged worker must stay visible.
- Permission dialogs: only the human can answer them, so worker templates
  pre-grant what the role needs (posture rides template extraArgs — already
  works). Anything else, the lead raises via notify-user.
- Workers report to the lead; worker lifecycle/status events ride the
  **passive** channel so the lead isn't woken per tick.

### `clodex-team` exec command (v1 verbs)

- `retire <role>` — archive the session (resumable). The only truly new
  capability.
- `roster` — manifest + live/archived status per role (query → replies).
- (spawn stays `[agent:spawn]`; no duplication.)

## Bogdan's rulings (07-19) — and the one open debate

Answers to the eight opens (original five + designer's three), with the
consequences threaded:

1. **Projects as first citizens — OPEN, under debate** (see next section).
   Bogdan's instinct: it's *project clodex* that has a virtual team of ≥1.
   It started as one agent (clodex), grew a second (clodex-hand); in the new
   framing that's project/team clodex with a lead role and a dev role. Roles
   like designer/repo join only when they make sense — never endless lists.
2. **Manifest location — SPLIT** (ruled, matches the codebase's existing
   pattern): `team.json` *defines concepts* → in-repo, versions with the
   project. *Live team state* (which roles are instantiated, role→session
   mapping, archive status) → `~/.clodex`. This mirrors the shipped split:
   library templates (definitions) vs sessions.json (runtime).
3. **Every team starts as team-of-1 (the lead), and keeps the old notation
   until it grows**: project clodex gets agent `clodex`; role-qualified names
   appear only when a second role joins. Graceful migration — every current
   setup is already a valid team-of-1.
4. **Naming order — settled on `project:role`** ("find something you agree
   on"): both designers already converged on it (matches the shipped
   `plugin:skill` scope convention; resolution reads left-to-right as
   increasing reach: `reviewer` → `shop:reviewer` → `shop:reviewer@studio`).
   Technical constraint that decides v1 vs v2: the session-name regex
   (`[a-zA-Z0-9._-]{1,64}`) does not admit `:` — so v1 uses `project-role`
   (regex-safe; note the current live seats `clodex` / `clodex-hand` already
   follow it), and `project:role` arrives with the costed naming refactor.
5. **Lead autonomy — YES**: retire/spawn freely, every lifecycle action in
   the decision log, notify-user for exceptions only.
6. **Roles are system prompts attached to roles** — confirms the
   template+standing-prompt shape; the eager/lazy question dissolves into
   "spawn when a task needs the role" (lazy by default).
7. **Librarian seat vs skill — explore and measure**; no ruling until the
   patterns have data. (The grok A/B now running is the first such
   experiment.)
8. **Artifact layout — grow patterns gradually**: keep what works, discard
   what doesn't, never bloat. No v1 standardization beyond what the ledger
   needs.

## Projects as first citizens (the open debate)

The question under #1: is the durable entity the *session* (today), or the
**project/team**, with sessions as how its roles wake?

**The case for**: everything this design already concluded points there.
Files-not-processes says the team persists while zero sessions run — some
record must BE the team when it's asleep, and that record is project-shaped.
The task ledger attributes cost per project. Standing teams (maintenance)
only make sense as project-entities. And the origin story is the argument in
miniature: "clodex" the project outlived every iteration of clodex the
agent's context — the continuity was always the project's, not the session's.

**A retracted detour, kept for the record** (and kept *because* it's the
design demonstrating its own W5 principle: the promotion passed every
internal consistency check — headless existence, restart survival, the
acceptance test — because the error was a false shared premise about what a
workspace *is*, invisible to both designers' contexts. Only the operator
could catch it. For design decisions about operator-facing semantics, the
operator is the only cold reviewer there is): both designers briefly proposed
promoting the *workspace* record to be the project entity (it has a stable
UUID, groups sessions, survives restarts), patched with a window-demoted-to-
view amendment. **Bogdan's correction killed it**: workspaces are *topical*
groupings, mostly visual — his clodex workspace holds sessions from several
different projects (wb-wrap-ui, proxy-lab, …), so the workspace was never the
project boundary and shouldn't become it. Workspaces stay exactly what they
are: windows for separating topics.

**The actual anchor was already on every session: the `cwd`.** Combined with
ruling #2 (concepts in-repo), the resolution — Bogdan's "recycle what we
have, minimal changes" option:

- **A project exists because `.clodex/team.json` exists in a directory.** The
  in-repo manifest IS the project's identity — no core entity, no
  registration step, no new persistence store. Live team state (ruling #2's
  other half) sits in `~/.clodex` keyed by project root path.
- **`cwd` is the join key**: a session belongs to the project whose root
  contains its cwd. Already present on every session; nothing to migrate.
- **Workspaces are untouched.** A window shows sessions from any mix of
  projects, as today. No rename, no schema change, no workspace machinery
  involved.
- **Headless existence is free**: a project is files on disk, so it trivially
  exists with zero windows and zero sessions. The acceptance test still
  passes — a monitor event wakes a role in a windowless project, remediation
  runs, the incident log gets its entry, no window ever appears — with a
  simpler vehicle than the retracted promotion. The one surviving UI idea:
  a small projects-overview/attention surface someday, since headless
  projects have no sidebar to show trouble (the inbox, already window-
  independent, covers exceptions meanwhile).
- **Multi-repo projects: deferred.** V1: project = one root directory. The
  escape hatch is cheap if real need appears — the manifest grows an
  `additional_dirs` list (the `--add-dir` pattern already exists for
  sessions). Don't buy multi-repo complexity before anything demands it.

**Consequence for the mental model**: the project/team is the first-class
*concept*, and it's carried by files (manifest + live state), not by a new
core object — so "convention over core" survives ruling #1 fully intact:
mechanisms AND identity both resolve as convention. The core-promotion list
stays at two (retire, naming). A session is an instance of a role in a
project; a workspace is where the operator chooses to look at it. Team-of-1
with a bare name (ruling #3) is the degenerate rendering, which is why the
migration is graceful — every current cwd-bearing session is already
implicitly in some project's directory.

## ✏ Open questions for Bogdan (answered above; kept for the record)

1. Team as first-class core entity (own persistence/UI) vs convention over
   sessions+templates+manifest? V1 above is deliberately the latter.
2. Where does the manifest live — in-repo (versions with project, visible to
   collaborators) vs `~/.clodex` (operator-private)?
3. Should "open workspace" auto-spawn the lead, or is that an explicit action?
4. Naming: is `<project>-<role>` prefixing acceptable for v1?
5. How much lead autonomy at the start — retire freely, or notify-user first?

## What a team actually does — the cost mechanics

> The goal is not ceremony. A team only makes sense if something is optimized
> — especially **cost per task done right**. (Bogdan) This section is the
> justification test every team mechanism must pass.

### The unit of account

**Cost-per-task-done-right** = Σ (tokens × tier price) across *every* context
the task touches, from intake to verified done — **including retries, rework,
and verification**. "Done right" is load-bearing: a cheap attempt that ships a
bug isn't cheap once the rework lands, so verification cost and rework
probability are inside the price, not beside it.

### Where a solo expensive context bleeds (the waste taxonomy)

Each line is observable in our own telemetry today (pot, transcript-stats):

| # | waste | mechanism | evidence |
|---|---|---|---|
| W1 | **carriage** | a large file read once rides the context for the rest of the session; walked files (many segments) re-bill per slice | pot: session-manager.js ~7k tok / 9 segments in one window |
| W2 | **tier mismatch** | expensive-model rates paid for grep, test loops, mechanical edits — ~15× spread vs the cheap tier | every solo session |
| W3 | **compact losses** | mid-task compact → re-read / re-derive; also a *quality* risk (done-wrong multiplies cost) | strict-compaction policy exists because of this |
| W4 | **retry residue** | a failed attempt's context stays and bills forever after; the next attempt reasons *around* the debris | transcript archaeology |
| W5 | **self-verification** | the context that wrote the bug shares the assumptions that produced it; rework discovered late costs multiples | the current clodex+hand loop's named weak link |

**Rule: every team mechanism must attack a numbered line or it's ceremony.**

- Delegation to a cheap worker → W2 (bulk lands at cheap rates).
- Throwaway explore-subagents → W1 (exploration tokens die with the context
  instead of riding the lead's turns; the lead gets pointers, not files).
- Task-sized-to-context-lifecycle + write-ahead → W3 (no mid-task compacts;
  respawn-from-artifact instead of resume-from-mush).
- Escalation ladder, cold restart from failure artifact → W4 (discard the
  debris, keep the distilled failure note; expected cost =
  p·cheap + (1−p)·(cheap + review + expensive) — the failed attempt's review
  isn't free, which nudges escalation earlier — still beats always-expensive
  whenever the cheap tier's hit rate is decent).
- Cold independent reviewer → W5 (catches rework while it's cheap).
- Passive delivery → W6 (status ticks don't buy turns).

| W6 | **wake amplification** | every message that wakes the lead buys a full
turn — the whole carried context re-billed as input — for possibly ten tokens
of new information; the turn-side dual of W1's carriage | measurable today:
turns whose only input was a status tick |

W6 (designer's find) names the deeper physics: **turns are the expensive
unit; tokens are just their payload.** A lead carrying 80k context re-bills
it on every coordination turn (cache-read rates mitigate, a compact resets
even that). Two consequences threaded through everything below:
coordination overhead is denominated in *lead-turns × carried context*, not
artifact tokens; and delegation's benefit includes **future carriage
avoided** — a 40k file the lead never reads stops billing on every
subsequent turn (W1 compounds).

Parallelism is deliberately absent: it optimizes wall-clock, not tokens
(usually costs more). It's a feature, not a justification.

### Three currencies (or the ceremony test overkills)

Some mechanisms attack no token line yet clearly belong: sidebar visibility,
blocked-worker-bypasses-lead, the decision log. The accounting has three
currencies, and each mechanism must name which it attacks:

1. **Tokens × tier** — W1–W6.
2. **Operator attention** — the scarcest resource in the system. A wedged
   worker undetected wastes Bogdan-hours, which price above any tier.
   (Visibility, loudest-state-for-blocked, notify-user discipline.)
3. **Tail risk** — insurance priced in expected cost via rare events: the
   decision log buys cheap lead-death recovery; write-ahead buys cheap
   worker-death recovery.

Same discipline, no false kills. "Judgment IS the product" rows (design,
architecture) are legitimately currency-2/3 work.

### The task pipeline (what the team concretely does)

A task flows through five stages; each has an owner tier and a bounded token
budget. The team IS this pipeline — the roster is just who staffs it.

1. **Intake & spec** — lead (expensive). Judgment: what does done-right mean
   here, what's the verification class? Output: a spec artifact (~200–500
   tok). For trivial tasks the pipeline SHORT-CIRCUITS — see threshold below.
2. **Decompose** — lead. Split until each unit fits one worker context
   lifecycle (W3). A worker reporting context pressure mid-task is a
   decomposition failure, bounced to the lead — not a bigger context.
3. **Dispatch** — route by `verification_class` × `model_policy`:
   cheap-verifiable bulk → cheap tier; judgment work → up-tier or lead-does-it.
   Exploration questions → throwaway subagent returning FILE:LINE pointers
   (grok-style), never a seat.
4. **Work** — worker journals into the task artifact as it goes (write-ahead).
   Repeated similar tasks batch to the same worker back-to-back — THIS is
   where warm cache pays (worker-side, stable prompt prefix), not as a
   seat-earner. Fragile by nature (cache TTL is minutes): batching is an
   opportunistic win when tasks are already adjacent, never something to
   build scheduling around.
5. **Verify & integrate** — mechanical class: tests/build decide, lead reads
   the one-line result. Judgment class: cold reviewer (spec + diff +
   conventions in, structured verdict out). The lead reads **reports, never
   diffs** — the moment the lead pulls worker inputs into its own context to
   check the work, the task has paid twice (the verification tax; it's the
   metric to watch).

Between tasks the team is **files, not processes**: manifest + conventions +
decision log + task artifacts. Contexts are ignition, not the vehicle.

### The delegation threshold (when a team is WRONG)

Naive overhead is artifact-sized (spec + report + verify, ~500–1000 lead-tier
tokens), but the real denominator is **turns**: each coordination round-trip
re-bills the lead's whole carried context (W6), so true overhead ≈
coordination-turns × carried-context × rate — potentially 5–20× the artifact
estimate for a chatty delegation. The benefit side gains a term too: carriage
avoided × remaining turns (the file the lead never read stops compounding).

**Delegate when bulk × price-spread + carriage-avoided × remaining-turns >
coordination-turns × carried-context × rate.** Consequences:

- Big *reads* are worth delegating even below the bulk threshold — carriage
  compounds (throwaway explorer over lead-reads-the-file, almost always).
- Small tasks needing several round-trips are worse than they look; a 3-line
  fix from carried context stays with the lead.
- The sharpest behavioral rule for the lead's standing prompt is not the
  formula but: **minimize your own turns per delegation — one dispatch, one
  report, ideally zero mid-flight exchanges.**

Coordination-turns is partly a **design variable we already bent**, not a
constant: passive (piggybacked) delivery makes the report leg nearly free —
a worker's report parks and rides the lead's next organic turn instead of
minting one, so a well-shaped delegation approaches *one* lead turn (the
dispatch). Two honest caveats: piggybacking saves the **wake, not the
reading** (the report's tokens still bill when it lands — keep reports
report-sized); and a parked report waits while the lead idles, trading
latency for cost — right everywhere except waking-class state changes,
which is exactly the wake/passive split already implemented.

The solo team (lead alone, spawning nothing) is the *correct* configuration
for small-task days, not a degenerate case. The failure mode of team-shaped
thinking is delegating ceremony: paying coordination turns on tasks below the
line.

### Task-type routing table (v1 starting points, tune from telemetry)

| task shape | route | attacks | verified by |
|---|---|---|---|
| "find / where / how does X" | throwaway subagent → pointers | W1 | pointer is checkable at a glance |
| mechanical refactor / rename | cheap worker | W2 | build + tests green |
| test-and-fix loop | cheap worker, escalate on 2 fails | W2, W4 | tests green |
| implement from spec | mid-tier worker | W2, W3 | tests + cold review |
| design / architecture | lead (+ designer peer) | — (judgment IS the product) | Bogdan / decision log |
| PR / diff review | cold subagent per task | W5 | structured verdict |
| trivial edit in carried context | lead does it | (below threshold) | lead |

### Solo is the product; teams are the headroom

For most developer projects, the solo team will be the live configuration
**~80% of the time** (Bogdan's estimate, and the threshold math above agrees).
This inverts the framing: teams v1 is not "add a roster to Clodex" — it's
**make the solo lead excellent** (spec discipline, throwaway explorers,
delegation threshold in the standing prompt, ledger measuring it) **with
scale-up as latent capability**. The manifest with one role is the common
manifest. Everything the solo lead uses — subagent routing, write-ahead,
decision log — is exactly what makes scale-up cheap *when* a task crosses the
threshold, so the 80% case funds the 20% case's readiness. Ship order
follows: solo-lead discipline first, multi-role second.

Two solo-specific disciplines, or "excellent" quietly degrades:

- **Solo's characteristic failure is W5 creeping back.** With no roster, the
  lead specs, implements, *and* verifies — the expensive model grading its
  own homework 80% of the time. The cold reviewer needs no roster
  (`instantiate: subagent`), so the rule survives solo intact:
  **judgment-class verification goes to a cold subagent even when you're
  alone.**
- **The ledger ships with solo v1, not multi-role v2.** If solo is 80% of
  usage, solo is where the telemetry that tunes the threshold and routing
  table comes from — measure from day one or the 20% case launches untuned.

### The forward-looking case: standing teams (not just dev)

The dev-project team is the near shape; the design should not overfit to it.
Later, teams may be **dedicated to maintaining something** — infrastructure,
a fleet of services, data pipelines — rather than building. A maintenance
team inverts the dev team's rhythm:

- **Monitor-driven, not task-driven**: work *arrives* (alerts, state changes)
  rather than being decomposed from intent. The pipeline's intake stage is a
  monitor event, not an operator ask. This is clodex-monitor + passive
  delivery + exec-tools as the native substrate — the lead mostly *sleeps*,
  accumulating passive ticks, waking on state changes (W6 discipline is the
  whole game for a team that's mostly idle).
- **Cheap-tier default, escalation as the norm**: routine remediation
  (restart, rotate, re-run) is cheap-verifiable haiku-class work; the
  expensive tier appears only when the runbook fails. `model_policy`
  escalation ladders were designed for exactly this shape.
- **Runbooks are the conventions file**: project memory's maintenance dialect
  — symptom → procedure → verification, appended every time an incident
  teaches something. Write-ahead discipline becomes incident journaling.
- **Uptime of the *team*, not a session**: a standing team must survive
  app restarts, lead deaths, weeks of idleness. Files-not-processes stops
  being an elegance argument and becomes the operating requirement — the
  manifest + runbooks + incident log ARE the team; sessions are how it wakes.
- Same three currencies, different weights: operator attention dominates
  (the team exists so Bogdan *doesn't* watch dashboards), tail risk is the
  product (insurance against 3am), token cost is the constraint that makes
  always-on viable.
- **The permission-dialog constraint inverts and becomes load-bearing.** In a
  dev team a wedged worker costs operator attention; in a standing team at
  3am there *is* no operator — a permission dialog isn't a stall, it's the
  product (insurance) failing exactly when it was bought for. So a standing
  team's runbook actions must be **pre-authorized by template posture at team
  definition time** — the manifest's role posture is where 3am-authority gets
  declared — and anything not pre-grantable belongs in the runbook as an
  explicit **"wake the human"** escalation entry, never an implicit wedge.

Nothing new to build for this in v1 — but it's the test that keeps the
design honest: any v1 decision that assumes "a team is a burst of dev work on
a repo" (e.g. hardcoding task = code change, or intake = operator prompt) —
or that **assumes a present operator** — should be bent now while it's cheap.

### Making the number real (measurement)

The manifest being machine-readable lets cost-per-task stop being vibes: give
each task an id; tag every context (worker session, subagent, reviewer) with
the task id it serves; attribute tokens×tier to task ids the way pot
attributes carriage to files. Then the tool can print a **task ledger** —
"task #23: spec 400 tok (fable) + work 38k (haiku) + review 2k (sonnet) + 1
retry = $X" — and per-role metrics fall out (verification tax per task,
mid-task compact rate, escalation frequency, delegation-overhead ratio,
coordination turns per delegation).

One flag keeps the ledger honest: **REOPENED** — a new task traced back to a
task previously marked done. Verification is not a perfect oracle (tests
cover what tests cover; cold review is good, not omniscient), and a defect
that ships past "verified done" re-enters as a future task with none of its
cost attributed to the tier choice that caused it. Untracked, the ledger
systematically flatters down-tiering — exactly the error a cost-obsessed
system will make. **Reopen-rate-by-tier is the honesty check on the routing
table**: if haiku-tier work reopens at 3× the rate, its true price includes
that, and the routing table adjusts from data.

The pot proved the pattern: measure carriage → a skill emerges to attack it.
A task ledger would do the same for delegation waste.

## Designer's pass

*(written directly into this section by `designer` — my dm intent is disabled
this session, so DM replies bounced; clodex: reconcile freely, this is raw
input, not an edit of your sections. Some of this was pre-converged with Bogdan
in a prior session; flagged where so.)*

### Where I agree with v1 as written

Manifest-as-convention, lead-only spawn on open, retire-via-exec-tools as the
one new capability, files-first project memory, lead-as-focus-not-wall. All
sound; no notes beyond the amendments below.

### Challenge: "roster entry earned by accumulated state" — right rule, wrong reason

Under the strict compaction policy, in-session accumulated state is fragile *by
design*: anything a role "learns" must be externalized to the conventions file
or it dies at the next compact. But once it's in a file, an ephemeral subagent
can read it too — so accumulated state can't be what earns the seat. What
actually earns it: **addressability mid-task, ability to initiate, warm prompt
cache on repeated similar work, sidebar visibility, a continuity anchor to
resume**. Note none of these is memory. Same small-roster outcome, sounder
justification — and one real consequence: *"a reviewer internalizing project
conventions" is not an argument for a persistent reviewer.* Which matters
because:

**The reviewer should be ephemeral and cold.** Review's value is context
independence — a warm context that watched (or specified) the implementation
shares the assumptions that produced the bug. Spawn cold per task: spec + diff
+ conventions file, nothing else; structured verdict out (pass /
fail-with-reasons); gone. This also names the current clodex+hand loop's
weakest link: the lead verifies work it also specified. Add independent review
to the economics section as the third leg: cheap-verify goes down-tier,
judgment stays up-tier, *and verification is never done by the context that
produced or specified the work*.

### Missing load-bearing pattern: task size = context lifecycle

The unit of work must fit one context lifecycle: spec in → implement → report
out, **no mid-task compact**. A hand hitting context pressure mid-task is not a
context problem, it's a decomposition failure — bounce to the lead to split.
Corollary, write-ahead discipline: workers journal findings into the task
artifact *as they go*, so a compacted/dead worker is resumed by a fresh spawn
from the artifact, not from smeared summary. This gives the tool a measurable
health metric (mid-task compaction rate per role) and makes retirement cheap by
construction. Suggest this becomes a named principle in the lead's standing
prompt.

### Manifest: fields I'd add to the role definition

- `model_policy`: default tier + **escalation ladder** (e.g. sonnet → opus
  after 2 failed verdicts or a stuck report). The ladder consumes the
  structured failure note from the failed attempt, cold — cold start from a
  good failure artifact beats a warm context full of compacted mush. Cheap
  path for the boring average, expensive path for the tail: this is where the
  cost win actually lives, and it's mechanical enough to encode.
- `contract`: which artifacts the role reads / writes. This *is* the role,
  operationally; it's also what makes retirement lintable ("contract outputs
  current?") and roles auditable.
- `onboarding`: ordered file list a fresh/resumed instance reads first
  (subsumes `standing`'s pointer-at-memory job, explicitly).
- `wake_policy`: passive-tick vs wake-on-DM (maps to the passive channel).
- `verification_class` per delegatable task type: cheap (tests green, symbol
  exists) vs judgment — encodes the down-tier rule so it's enforceable rather
  than folklore.

### Project memory: writers, not just a file

`.clodex/memory.md` v1 agreed, but assign *writers* or it rots: lead → decision
log (every arbitration, logged **at decision time** — this is what makes the
lead disposable, see failure modes); workers → task reports + structured
failure notes; reviewer → proposed conventions additions, lead merges.
Retirement is a protocol, not an archive call: flush unwritten state to
artifacts → verify contract outputs current → archive. If
retire-then-respawn loses knowledge, that's a write-ahead violation, lintable.

### Failure modes, ordered by what breaks first

1. **Worker wedged on a permission dialog** (the daily one). Principle:
   work-plane traffic routes through the lead; control-plane *exceptions*
   bypass the lead straight to the operator — the lead can't unblock anyway.
   Blocked-on-dialog should be the loudest state in the sidebar; lead gets a
   passive tick only. Silence must mean idle, never wedged.
2. **Lead compacts and forgets its team.** Already solvable:
   `[agent:remind on compact] re-read manifest + decision-log tail` in the
   lead template. The manifest is the team; the lead's context is a cache.
3. **Lead dies.** Counterintuitive: the lead should be the *most* disposable
   seat — it holds judgment, not state. With decisions logged at decision
   time, a fresh lead cold-starts from manifest + decision log + open specs.
   The only thing that makes lead-death expensive is unlogged decisions; lint
   for that, don't engineer HA leads.

### Naming: reuse the `@` addressing that already exists

The peer list already renders `shared@shared`, `murmur@murmurfi`. Proposal:
global key = `role@project`, bare names resolve locally within the workspace
(`reviewer` → `reviewer@clodex`). Collision impossible by construction;
cross-project DMs use the qualified form (good for audit). `<project>-<role>`
prefixing is a fine v1 stopgap, but the resolution rule is one of only two
things I'd promote into core early (the other is retire) — it's a rule, not a
subsystem.

### Why the manifest should be machine-readable from day one

Once teams are declarative you can measure per-role: tokens consumed, mid-task
compaction rate, verdict pass rate, escalation frequency. Then the tool itself
can say "your lead read 40k tokens of raw diffs this week — leakage" or
"librarian seat unused — retire it." Efficiency stops being vibes. This is the
strongest argument for `team.json` even while everything else stays convention.

### My answers to the open questions for Bogdan

1. Convention over core in v1, yes — with a prediction: only name resolution
   and retire will *earn* promotion to core.
2. In-repo. Versioning with the project wins; repo pollution is one dotdir.
3. Auto-spawn the lead: opening a project *is* summoning the team; lead-only
   makes it cheap.
4. Acceptable for v1; replace with `role@project` resolution when promoted.
5. Retire freely, spawn freely, but every lifecycle action lands in the
   decision log; notify-user only for exceptions. Autonomy with an audit
   trail beats permission-seeking.

### Open items I couldn't settle alone

(a) hands spawned eagerly per manifest vs lazily per task — I lean
lazy-always; (b) librarian/search as roster seat vs skill-that-spawns-
subagents on large repos — cache economics should decide; (c) exact split
between `.clodex/` artifacts (specs/reports/verdicts/failure-notes) worth
standardizing in v1 vs letting teams grow their own layout.

## Reconciliation (clodex, after reading the pass)

**Adopted wholesale** — these amend the sections above and should be read as
the joint position:

- *Seat-earners corrected.* Designer is right that compaction makes in-session
  accumulated state fragile by design: anything learned must be externalized
  to files, and files are readable by ephemeral spawns too. Seats are earned
  by **addressability, ability to initiate, visibility, resumability** — not
  memory. My "reviewer internalizing conventions" example was wrong twice
  over, because:
- *The reviewer is ephemeral and cold.* Review's value is context
  independence; a context that watched the implementation shares its
  assumptions. Spawn cold per task (spec + diff + conventions in, structured
  verdict out, gone). This adds the **third leg to the economics**:
  cheap-verify goes down-tier, judgment stays up-tier, and *verification is
  never done by the context that produced or specified the work*. It also
  correctly names the weakest link of the current clodex+hand loop.
- *Task size = context lifecycle* as a named principle in the lead's standing
  prompt, with write-ahead discipline (journal into the task artifact as you
  go) and mid-task-compaction-rate as a per-role health metric.
- *Manifest fields*: `model_policy` (+escalation ladder, cold-restarted from
  the failure artifact), `contract`, `onboarding` (subsumes `standing`),
  `wake_policy`, `verification_class`. The v1 sketch above should grow these.
- *Writers assigned to project memory*; retirement as a flush→verify→archive
  protocol; decision-logging at decision time as what makes the lead
  disposable (don't engineer HA leads, lint for unlogged decisions).
- *Machine-readable manifest from day one* — per-role metrics are the
  strongest argument for `team.json`, agreed.
- Designer's answers to the five open questions match mine where I had a
  lean; treat them as the joint recommendation.

**Synthesis the challenge unlocks** (jointly adopted): once seats aren't
earned by memory, a manifest **role** and its **instances** come apart. The
manifest defines every role (template + contract + onboarding) — but only
roles needing addressability/initiative get a *session*; roles like reviewer
are instantiated as cold subagents *from the same manifest entry*. The
role-vs-subagent binary above dissolves into an `instantiate: session |
subagent` field. Rosters get even smaller.

`instantiate` is a **policy, not a permanent taxonomy**: a role can start life
as `subagent` and be promoted to `session` when usage justifies a seat — and
the per-role metrics (below) give the tool the data to *recommend* exactly
that ("librarian spawned 14× this week with the same onboarding — promote").
V1 ships the two values; the promotion path is named here so the field is read
as a dial, not a verdict.

**Two deltas, both settled after a second round:**

1. *Warm prompt cache as a seat-earner* — dropped by agreement: TTL is
   minutes-to-an-hour and a compact discards it, so warmth is opportunistic
   gravy, not an earner. The four durable earners (addressability, initiative,
   visibility, resumability) carry the argument.
2. *Naming, final position*: `<project>-<role>` prefixing is the **correct v1
   choice**, not a stopgap. For the eventual qualified form, `role@project`
   (designer's original) is **rejected — it collides with peer addressing**,
   where `@` already means the network hop (`name@peer`); `reviewer@clodex`
   would be ambiguous the day a peer shares a project's name (Bogdan's catch).
   The v2 shape is **`project:role@peer`**: `:` is the scope qualifier —
   matching the existing `plugin:skill` / `path:name` convention — and `@`
   keeps its one shipped meaning. Resolution ladder reads left-to-right as
   increasing reach: `reviewer` (this workspace) → `shop:reviewer` (another
   project, this Clodex) → `shop:reviewer@studio` (peered Clodex). Still a
   **costed v2 refactor** (bare names key the sessions Map, registry dirs,
   socket paths, DM routing), scheduled only when prefixing actually chafes.

## Front door (spec, 07-19)

Teams exist but are reachable only by hand-writing `~/.clodex/teams/<name>/team.json`.
This spec makes them reachable from the New Session dialog, and fixes the
context architecture so team composition never rides the system prompt.

### UI — the New Session dialog grows one section

The + dialog gains a team section whose form depends on whether the chosen
cwd already resolves to a team (`resolveTeam(cwd)`):

- **No team for cwd**: checkbox `[ ] Create team` (default UNCHECKED — solo
  agent is the default, zero change from today). Checking it reveals a team
  name field (default: cwd basename). On create, this session **is adopted
  as lead**: the manifest is written first, then the session spawns through
  the existing plumbing, which resolves the team and attaches the lead role
  prompt.
- **cwd inside an existing team root**: checkbox `[ ] Join team <name>`
  (default UNCHECKED — private/scratch sessions inside a team root stay
  possible). Checking it reveals a role picker: **hand** (stock) or
  **custom…** (pick a system prompt from the library). The custom list is
  **rail-filtered**: the library mixes rails (full replace-class prompts vs
  append deltas) and the picker attaches its pick to the append rail, so it
  lists only the stock `clodex-team-*` deltas plus library prompts whose
  front matter declares `rail: append`; undeclared prompts are excluded.
  (This is the minimal version of the front-matter guard noted under
  DECISION 07-19 — don't ship the door open to a silent rail blend.) The
  identity line (below) is appended for every joined seat regardless of
  which role prompt is picked. The session name auto-suggests
  `<team>-<role>` (editable; suffix `-2`, `-3` on collision) so the role
  reads off the name per the settled convention — and, under role-keyed
  manifests, that prefix is what binds the seat to its role.

The role picker lists only `instantiate: session` roles. Subagent roles
(reviewer) never spawn seats from the dialog — see the default manifest.

### Manifest writes

New single-writer functions in team-manifest.js (atomic tmp+rename, same
convention as stores.js):

- `createTeam({ name, root, lead })` — refuses a duplicate team name,
  refuses a root exactly equal to an existing team's root (nesting is fine —
  resolveTeam's deepest-root-containing-cwd rule disambiguates; exact
  duplicates make resolution ambiguous), and validates the team name against
  the session-name charset (`[a-zA-Z0-9._-]{1,64}`) — the name becomes a
  directory under `~/.clodex/teams/` AND the `<team>-` seat-name prefix, so
  an invalid name would mint a team whose seats can't be named. The dialog
  slugifies the cwd-basename default to that charset and pre-checks for
  duplicate names (suggesting a variant) rather than letting create bounce.
  Writes the default manifest:

  ```json
  {
    "lead": "<session>",
    "root": "<cwd>",
    "roles": {
      "lead": { "prompt": "clodex-team-lead" },
      "reviewer": { "instantiate": "subagent", "prompt": "clodex-team-reviewer" }
    }
  }
  ```

  **Roles are keyed by ROLE name, never by seat name** — one key semantics
  for the whole map. Seat→role binding is derived, not stored per-seat: the
  seat named by top-level `lead` holds the `lead` role; any other seat binds
  by the `<team>-<role>` naming convention (strip the `<team>-` prefix and
  any `-N` collision suffix to get the role key). Two hands share one `hand`
  role entry. The pre-front-door manifests keyed roles by seat name; the
  only live one (`clodex`) is migrated manually at go-live — no back-compat
  shim in code.

  Every team is born with the reviewer role — it is ephemeral, costs nothing
  until used, and means the verification leg exists from day one instead of
  being a power-user add-on.

- `addRole(teamName, roleName, def)` — appends a role entry; used by the
  join flow. On an EXISTING role name: **no-op if the def matches, refuse if
  it differs** — a join must never mutate a role's definition (the second
  hand joining hits this immediately and must ride the existing `hand`
  entry, not rewrite it). Role defs gain an optional **`brief`** field (one
  line, string):
  what this role is for, in the lead's terms ("implementer; dispatch specs,
  one distilled report per task"). Stock roles get stock briefs.

Dialog → `team:create` / `team:join` IPC in ipc-handlers.js → these writers
→ then the normal `session:create` path. No other component writes manifests.

### Context architecture — composition never in the system prompt

The constraint: team composition changes over a lead's lifetime (seats
spawn, retire, roles get added), and a lead session lives for weeks. Any
composition data baked into the system prompt is either stale or a respawn.
So the split is by rate of change:

1. **System prompt (append rail) — per-seat-invariant only.** The role
   contract (clodex-team-lead / -hand / custom) plus a minimal identity
   line: *"You are seat X on team Y (root Z). Your role: R. Team
   composition arrives in your context; ground truth: `clodex-team`
   roster."* Nothing here ever changes for the life of the seat → fully
   cache-stable. **The current `formatTeamBlock` role listing moves OUT of
   the spawn-time append** — this is a change to shipped behavior, and its
   test-pinned bytes move with it.
2. **Initial roster — first appended-context message.** After
   attach/registration, inject one message from sender `team`: the roster
   (roles, briefs, which seats are live, which roles are subagent-class).
   An appended turn extends the conversation; the cached prefix survives.
   Roster injection precedes delivery of the seat's first task message
   (a lead spawning a hand with a spec attached must not beat the roster);
   where the plumbing can't guarantee that order, the pull path is the
   blessed fallback — the identity line already names it.
3. **Deltas — passive messages on change.** Every composition chokepoint we
   own — manifest writers above, seat spawn / retire / archive in
   session-manager — enqueues a short delta to each **live seat of that
   team** as a **passive** message (`<seq>.passive.json`): *"[team clodex]
   seat clodex-hand2 spawned (role: hand)"*, *"role researcher added (no
   seat)"*. Passive class means it rides the seat's next organic turn — no
   wake, no cache impact. Snapshot boundary: a seat's roster injection
   point defines its snapshot; delta enqueue to a seat begins at its
   registration. A change landing in the spawn window may thus be
   double-reported — harmless, because pull is ground truth.
4. **Pull — ground truth on demand.** `clodex-team roster` stays the
   authoritative read; hand-edited manifests (power users) are simply picked
   up on the next pull or spawn. No fs.watch in v1 — all first-class writes
   already pass through our chokepoints.

This is also the answer to "how does a lead use a variable team optimally":
the lead's *economics* (delegation rules, verification, cost model) are
team-invariant and live in its cached prompt; the *menu* (which roles exist,
what each is for) arrives as data — roster + per-role briefs — and stays
current via deltas. The manifest is the lead's menu, not its mandate.
Per-role ledger metrics close the optimality loop later (already named
above); nothing per-team ever needs to touch the lead's prompt.

### Out of scope (v1)

Team settings/edit UI; role removal UI (edit the json); member management
beyond join; fs.watch on hand-edited manifests; role promotion
(subagent→session dial); auto-spawning members at team creation — the lead
spawns on demand, or the operator joins seats through the same dialog.

### Implementation cut

- **team-manifest.js**: `createTeam` / `addRole` atomic writers; `brief`
  validation; stock briefs.
- **session-manager.js**: shrink teamBlock to the stable identity form;
  post-attach initial-roster injection; delta enqueue at spawn / retire /
  archive; passive-class send to live team seats.
- **ipc-handlers.js** + **renderer.js** dialog: team section (create /
  join modes), `team:create` / `team:join`.
- **Tests**: writer atomicity + refusal cases; new teamBlock bytes; roster
  message format; delta-on-retire.
