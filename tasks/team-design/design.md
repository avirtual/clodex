# Teams: what one team on one project actually proved

Design artifact for `tasks/team-design/brief.md` (committed at 4acdd6d). The
evidence base is the brief's seven instances plus an eighth supplied by the
lead mid-task (the designer seat's own respawn ambiguity). Role prompts were
read from `resources/library/prompts/system/clodex-team-{lead,hand,reviewer}.md`
(123 / 103 / 64 lines as read; line citations below are against those files).
Method and writing rule follow `tasks/durable-state/design.md`; where an
instance was already adjudicated there, this artifact rules only on the team's
share of it.

---

## 0. Thesis

Two sentences carry the whole design:

**The team mechanism's distinctive value — the part a single agent with
throwaway subagents does not already have — is the durable layer: seats that
persist, tickets that outlive contexts, work that survives restarts. And every
observed failure occurred in exactly that layer.**

The lead prompt itself teaches subagent delegation ("a throwaway subagent
returns FILE:LINE pointers and its context dies," lead prompt lines 22-25).
Subagents already deliver the cost arbitrage: cheap-context big reads,
down-tier bulk loops, disposable execution. What a subagent cannot be is
addressed mid-task, woken later, resumed after the lead restarts, seen by the
operator, or the holder of a queue. That remainder — persistence,
addressability, tickets, operator-visible topology, plus the enforced
cold-review ritual — is the team, and it is the part that stalled the hand,
lost the ticket, archived the seat mid-thread, and hid a respawn from both
parties. The design consequence is uniform across every section below:
**shrink what the team claims, and make what it keeps honest.** Smaller shipped
surface (a team of one, one primitive role, prompts cut to contracts), stronger
durable layer (replay, lifecycle events, provenance).

---

## 1. What a team is FOR — including the case against

### 1.1 The two counterfactuals

Any argument for a team must beat both of these, not just the first:

1. **One agent doing everything.** Weakness: every turn re-bills one large
   context; big reads poison it permanently.
2. **One agent using throwaway subagents.** This already captures most of the
   delegation win: reads and bulk loops billed against contexts that die. It
   is the configuration the lead prompt recommends for exactly those cases.

Against counterfactual 2, a persistent team seat adds only: it can be
addressed mid-task; it can initiate; it survives the lead's own restarts and
compacts; the operator can see it; and the ticket store gives work items an
existence independent of any context. Cost arbitrage alone never justifies a
seat — it justifies a subagent.

### 1.2 The discriminator (apply before setup)

A team beyond a team of one pays for itself only when at least one of these
holds:

1. **Work items must outlive any single sitting.** Tasks span restarts and
   compacts of either party; standing orders exist; a queue is needed. This is
   what tickets are for. If every unit of work fits one dispatch-report cycle
   inside one sitting, tickets are bookkeeping overhead.
2. **A worker must be addressable or must initiate.** Mid-task steering, a
   seat that watches something and speaks first, a long-lived specialist whose
   accumulated task context is itself the asset (the designer seat in this
   team's own history). Subagents cannot do any of that.
3. **Judgment output needs a cold verifier.** Independence is a quality
   mechanism, not a cost mechanism, and it is the only team feature that pays
   even at size one: `[agent:team-review]` works for a lead with no workers.
4. **Sustained volume of dispatchable work with cheap verification**, where
   the operator wants the topology visible as seats rather than buried in
   subagent calls.

Conditions under which the shipped claim ("a lead plus a cheap disposable
worker costs less than one agent") is actually true — all three at once:

- **Separability**: the task can be specified in one write, executed without
  mid-flight conversation. Each round-trip re-bills the lead's full context;
  two round-trips usually erase the arbitrage.
- **Cheap verifiability**: the output can be verified without reading the
  inputs — a machine oracle or a distilled report the lead can trust. If
  verification means pulling the worker's material into the lead's context,
  the lead pays twice (this is already in the lead prompt, lines 19-22, and it
  is correct).
- **Amortization**: the task is large enough that worker-context turns saved
  exceed the fixed overhead (dispatch + report + verification is a minimum of
  two to three lead turns, plus the worker's prompt and spawn).

### 1.3 The work for which a team is the wrong choice

This list is half the design, per the brief. Concretely:

- **Exploratory and design work where writing the spec is the work.** If the
  lead cannot state the done-condition before dispatch, dispatch becomes
  conversation, and conversation is the most expensive shape in the system.
  One agent thinking is strictly cheaper than two agents negotiating.
- **Work verified only by re-doing it.** No oracle, no compact report form:
  the lead's verification costs what the work cost. The team moved tokens to a
  cheap tier and then re-spent them at the expensive tier.
- **Small work.** A three-line fix in context the lead already carries never
  amortizes the overhead. (Lead prompt line 29 already says this; keep it.)
- **Operator-in-the-loop work.** When the human is present and steering every
  step, the human is the durable context and the single agent is already the
  hand. A team inserts a middleman who bills for relay.
- **Serial single-thread work with no restart risk.** Nothing for the durable
  layer to protect, nothing for a second seat to parallelize.

A user who recognizes their work in this list and skips the team has used the
feature correctly.

### 1.4 The honest band statement

The economic claim has been measured never. The single sample was maximally
favorable on every axis that matters: a software project (machine oracles make
verification nearly free), tasks pre-shaped for dispatch by the operator who
invented the dispatch format, a lead fluent in every tool because it wrote
them — and the observed team never exceeded two live workers. Even under those
conditions, a single day's ledger of coordination failures (an idle hand, ~20
spurious wakes, three dead watchdog wakes, one re-run suite) was charged
against the team's side of the balance. No claim about the sign of the balance
is supportable from this evidence. What is supportable: every marginal seat
adds fixed coordination cost, so the ratio degrades as tasks shrink, as
verification gets harder, and as specs get blurrier — the band narrows in
exactly the directions most other projects and domains sit.

Consequence: **ship the discriminator, not the assertion.** The hand prompt
currently teaches the claim as identity ("that asymmetry is the point — it is
why the team costs less than one agent doing everything," hand prompt lines
7-9). An unmeasured economic claim stated as fact in a role prompt should be
deleted; the discriminator belongs in the lead's delegation rules, applied
per-task, where it is a decision procedure instead of a creed.

---

## 2. The role vocabulary

### 2.1 What actually distinguishes roles

The properties the mechanism consumes are three, and they are already manifest
keys or code:

1. **Context lifetime** — does the seat's context outlive one task
   (`instantiate: session`) or die with it (`subagent`)? This is the
   load-bearing axis: it determines cost (a durable context re-bills) and
   quality (a cold context enables review).
2. **Mutation rights** — what the seat may touch (`tools`).
3. **Initiative and addressability** — whether anything must reach the seat
   mid-task or the seat must speak first (this is what forces `session`).

Everything else a role "is" — implementer, reviewer, designer, fact-checker —
is the `brief` line and the prompt: domain content the mechanism never reads.
Verified against the brief's own description: dispatch grammar is computed
from the manifest, tickets address roles by name, templates ride per role.
The mechanism is already role-name-agnostic with one exception.

### 2.2 One primitive, one ritual, one default

- **`lead` is the only primitive role.** The mechanism itself depends on it:
  tickets nudge the lead, only the lead closes others' tickets, the operator's
  contact point is the lead, `team:create` adopts the caller as lead. It
  cannot be renamed away without redesigning the mechanism. (Whether a team
  can have two leads is an open unknown — no evidence exists either way; the
  current one-lead assumption is untested, not validated.)
- **`reviewer` is not a role; it is an enforced ritual.** Cold context, capped
  tools, verdict shape, retirement — all enforced in code because the manifest
  is agent-writable. The reservation is correct, but it should be understood
  (and documented) as the mechanism owning an *invariant*, not owning a
  vocabulary word. It needs no row in the user's mental model of "my roles";
  it is an intent the lead can always emit.
- **`hand` is a default worker configuration** — one point in the space, not a
  primitive. Its prompt is mostly a generic worker contract (see section 5).
  Shipping it as a seeded role at create time was the sample-size-one
  artifact: it encodes "this operator usually wants one session-lifetime
  implementer," which is a fact about one operator.

So the answer to the brief's question: the right vocabulary is not a fixed set
and not a coordinate system the user must learn. **The user names roles after
their own work's nouns** — indexer, fact-checker, chapter-drafter, deployer —
and answers the two questions the mechanism consumes: *does it persist between
tasks?* and *what may it touch?* A generic worker contract (the trimmed hand
prompt) is the default prompt for any role that doesn't supply its own. The
shipped vocabulary shrinks to: `lead` (primitive), the review ritual
(invariant), and a worker template (default). Nothing else is ours to name.

---

## 3. Setup

### 3.1 Default: a team of one

`team:create` should yield the lead alone — machinery latent, no seeded
worker roles. Reasons, in strength order:

1. **The lead prompt already declares it**: "Most days the team is just you —
   that is the correct configuration, not a fallback" (lines 6-7). The
   mechanism should match its own doctrine; today it seeds three roles against
   a prompt that says one.
2. **A seeded role the user didn't ask for is a cost they cannot evaluate**
   (the brief's own phrasing, and it is right). A user who adds `indexer`
   because their work needed indexing understands their team; a user handed
   `hand` must reverse-engineer ours.
3. **Latent roles have a demonstrated failure mode**: instance 2, where a role
   *definition* was mistaken for a live seat. Fewer defined-but-uninstantiated
   roles shrink the confusable set at the root, independent of the renderer
   fix.

The review ritual needs no seeded role either — it is reached by intent and
enforced in code; it should simply always be available, including to a team of
one. (If the implementation currently requires the manifest row, keep the row
but stop rendering it as a teammate; it is a capability, not a colleague.)

### 3.2 What the user must understand

The understanding budget — the real setup cost — is four sentences:

1. The team is you until a task earns a second seat.
2. A seat is worth adding when work must outlive a sitting, needs to be
   addressable mid-task, or comes in volume you can specify cheaply and
   verify cheaply (section 1.2); otherwise use a subagent or do it yourself.
3. Tickets are the only channel that survives restarts; direct messages are
   not a store.
4. Cold review is always available by intent and is how judgment-work gets
   verified — including your own.

Everything else can be learned at the moment of use, from the tools themselves
(section 5.3 makes that concrete).

### 3.3 The on-ramp is the first dispatch, not the setup screen

The teachable moment for the discriminator is when the lead has a spec in hand
and must decide who runs it: self, subagent, or seat. That decision procedure
belongs in the lead prompt's delegation rules (where half of it already
lives), not in setup documentation. Adding a role at that moment — name, one
brief line, persist-or-not, tools, prompt optional (worker default) — is the
existing GUI popover flow and is already small enough. Setup needs no wizard;
it needs the default to be one seat and the four sentences.

---

## 4. The eight instances, adjudicated

Legend: **M** mechanism bug (code), **D** design defect (shape), **P**
protocol error (lead/operator), **C** correct behavior misread.

| # | Instance | Ruling | Generalizes? |
|---|---|---|---|
| 1 | Stalled hand | M + P, asymmetric (below) | Fully |
| 2 | Phantom teammate | M (renderer) + D (seeded latent roles) | Fully |
| 3 | Late watchdogs | D at root (prompt duplicates mechanism) + P at arming | Fully |
| 4 | Status firehose | P (rule present, unapplied) + M (self-echo) | Partly |
| 5 | Re-run suite | C; team owes nothing new | n/a |
| 6 | Seat archived mid-thread | M (existing invariant not applied to archival) | Fully |
| 7 | Invisible merge queue | Inherent funnel; the defect is invisibility | Fully |
| 8 | Respawn ambiguity | M/D (seat identity over time unmodeled) | Fully |

### 4.1 Instance 1 — the adjudication the lead asked for

The lead's instinct: one-shot ticket delivery is the bug. The alternative: a
lead who keeps standing orders in one channel and work in another is the bug,
and replay would paper over it. Ruling: **both defects are real, they are not
symmetric, and neither fix alone closes the instance.**

The mechanism bug is the more general one, and the evidence for it is an
asymmetry the framing missed: across the respawn, the channel that is
officially *not a store* (the transcript) kept its state — the hold survived —
while the channel whose entire justification is durability (the ticket store)
lost its delivery. A durable store with one-shot delivery silently demotes
itself to a message for any reader who restarts, and every lead on every
project will restart seats. `tasks/durable-state/design.md` §9.2.1 already
confirmed replay-on-respawn as the one mechanism worth building; reaffirmed.

But the lead's channel discipline was independently a bug that replay does not
fix. Run the counterfactual: with replay, the respawned hand receives both the
hold (via resumed transcript) and the ticket (via replay) — and now holds a
*contradiction* it must resolve by guessing or by a round-trip. Replay
converts a silent stall into a visible conflict: better, not fixed. The
instance closes only with the pair already prescribed in durable-state §3/III:
standing orders live as tickets, named, carrying their lift condition, closure
is the lift — *plus* replay, so a respawned seat receives exactly the true
standing state and nothing lapsed.

Adjudicating the lead's stake directly: the half he suspects himself of is the
half replay cannot cover. The two-channel habit is a P-class error any lead
can commit; the design's job is to make it hard — which it does once orders
have exactly one valid home (the notifying, replayed, closable store) and the
prompt says so in one line instead of leaving channel choice to taste.

### 4.2 The other seven, briefly

**2 — Phantom teammate.** Same event as durable-state instance 6; the renderer
fix (definitions and live seats structurally disjoint; liveness query-only) is
already ticketed (t151). The team-level addition: a message sent to a
non-live addressee must fail loudly or queue explicitly — "no error it
understood" means undeliverable sends currently vanish. And the seeded-role
default enlarged the confusable set (section 3.1). Fully general.

**3 — Watchdogs firing after the fact.** Durable-state §9.1 ruled on the
record shape (a scheduled record names what cancels it or carries a fire-time
predicate). The team-level root is different and worth stating: the lead sets
per-dispatch watchdogs (lead prompt lines 37-40) *because it does not trust
passive delivery and silent worker death* — but the ticket store already has a
stall-window nudge, which is the same watchdog implemented once, in the layer
that can see the falsifier (ticket closure). Liveness monitoring belongs to
the store that owns assignment and closure, not to per-dispatch lead protocol.
Fix: make the stall nudge predicate-guarded (fires iff the ticket is still
open — it already knows), then delete the prompt rule. A prompt rule that
duplicates a mechanism is paid for on every turn and still fired three times
after the fact.

**4 — Status firehose.** Two separable parts. The self-echo (9 of ~20 wakes
were the lead's own words read back) is M: content an agent wrote is never
signal to that agent; suppress by default, and default monitors to
edge-triggered (state changes) rather than level-triggered (output events).
The remainder is P — and it is the most instructive P in the set, because the
governing rule already existed in the always-in-view prompt ("only state
changes that need action should wake you," lead prompt line 123) and its own
author violated it. That is direct evidence for section 5: presence of a rule
in the prompt does not produce application under pressure; attention, not
availability, is the scarce resource. Partly author-specific (the plumbing was
his), but the defaults generalize.

**5 — Re-run suite.** The re-run was the correct read of an undecidable record
(durable-state finding 2), and the fix — suite-run outcome log — was adopted
there. Should the *team* mechanism make "running at time of writing"
unwritable? Ruling: no. The team's only contact with the instance is that
ticket-close reports are outcome-shaped by construction (a `task done` body
reports a completed thing). Adding artifact-template enforcement to the team
layer would be mechanism where a convention already landed. **Finding: not
every failure adjacent to the team is the team's to fix.**

**6 — Seat archived mid-thread.** The design principle already exists in the
mechanism: role removal fails closed "when a live seat or open ticket still
encodes the role." Seat archival is the same class of destructive operation
and skipped the same check. Fix is the existing invariant, extended: archiving
or retiring a seat with open tickets (or, if measurable, an active thread)
notifies the lead and marks the tickets, or refuses without a force flag.
Implementation gap, not new design. Fully general.

**7 — The lead is the merge queue.** The funnel is not a defect — it is the
architecture: verification concentrates where judgment lives, definitionally
the most expensive context. The defect is that the queue is invisible. Reports
close tickets (`task done` with report as body), so "delivered, awaiting lead
verification" exists nowhere but the lead's context — and the lead prompt
(lines 95-98) makes flag-adjudication a duty with no store behind it. Ruling:
at observed team sizes (never above two workers), a rule suffices — the lead
runs no more concurrent workers than it can verify without queueing reports;
that line joins the delegation rules and doubles as the honest answer to "when
does adding a worker cost more than it saves." A ticket state for
closed-with-unadjudicated-flags is the mechanism option; it is named here as
an open choice and deliberately not proposed, because it adds lifecycle
complexity justified by a team size never yet observed.

**8 — Respawn ambiguity (lead's addendum).** The seat was archived and
respawned under the same name; it resumed a ~103KB transcript; neither party
could tell, and the lead established the truth by checking transcript size by
hand. Root, shared with 6: the team models roles and tickets but not **seat
identity over time** — spawn, resume, archive, retire are invisible to the
layer and to the seats themselves. Two rulings:

- The cheap, certain fix: **provenance in the injected context.** The seat
  already receives its name, team, role, and dispatch grammar; add one line —
  "fresh spawn" or "resumed from archive: transcript N KB, last active T."
  Mechanical, tiny, closes the ambiguity for both parties (the roster can
  carry the same fact for the lead's side).
- The doctrinal finding: the mechanism's default (resume the transcript)
  contradicts the doctrine both worker prompts preach ("a dead or compacted
  worker is replaced by a fresh spawn reading the artifact, never resumed from
  mush" — hand prompt lines 89-90, lead prompt lines 105-107). For workers,
  artifact-respawn strictly dominates *once orders live in replayed tickets*;
  for a long-lived specialist seat, resume was genuinely useful (it carried
  this design's predecessor). So respawn policy is per-role, and the bug is
  that it is currently implied by GUI restart behavior instead of chosen and
  visible. Whether deeper identity modeling is needed: unknown — one event;
  do not build for it.

This is the second and third specimen (after durable-state finding 3) of the
same genus: **the infrastructure violating the doctrine the prompts carry.**
An infrastructure that resumes-from-mush while the prompts forbid it, and a
roster that blurs liveness while the rules demand decidability, trains every
reader to distrust the rules.

---

## 5. Prompt economics

### 5.1 The honest arithmetic first

290 lines is roughly 2.5-3.5k tokens. On the lead's 100k+ context that is
1-3% per turn; on a hand's intended 30-40k, similar. The token bill is real
but **second-order** — claiming a token crisis would be false, and a design
built on that claim would cut the wrong lines. The first-order costs are:

1. **Attention dilution.** Rules compete for application. Instance 4 is the
   proof: the wake-discipline rule was in view on every turn and was violated
   by its own author under pressure. A system prompt does not decay with
   context pressure (it is re-sent every turn) — so the failure mode is not
   forgetting but non-application, and every additional line makes every
   other line less salient at its decision moment.
2. **Generality debt.** Tuned constants and harness mechanics are baked into
   role text: "roughly 100k+" (hand line 23), "~8-10 think/act rounds" (hand
   line 64), the wire-cost turn-discipline theory (hand lines 51-65). These
   are facts about one harness and one price sheet, shipped as team doctrine.
3. **Setup legibility.** The 290 lines are the de facto manual; a user must
   absorb them to predict their own team. They are most of the "PhD to set
   up."

One distributional note: the burden is regressive. The overhead lands
proportionally hardest on exactly the cheap disposable seats whose cheapness
justifies the team.

### 5.2 The survival test

A line survives iff it changes behavior at a decision the seat will actually
face, toward something the seat would not do by default, and nothing cheaper
can carry it. Operationally, six questions, applied in order:

1. **Is it contract?** Channels, formats, authority boundaries, closing
   intents (`review-done`, `task done`). Keep — an agent cannot derive its
   half of a protocol. These also pass the brief's checkability constraint:
   an agent can verify it emitted the right shape.
2. **Could form carry it?** If a store, template, or entry shape can refuse
   the wrong write (durable-state Grade B), move it there and shrink the line
   to naming the store.
3. **Could the tool teach it?** Command references and hazard warnings belong
   in tool output and error messages — the tool teaches at the moment of use,
   the only moment that matters, and bills only when used. The lead's ticket
   section (lines 47-69, ~23 lines of command reference) and the NAMING
   HAZARD paragraph (71-75, compensating for a tool-name collision) are the
   clearest cases: the first moves to `task` help/errors, the second's real
   fix is in the mechanism (disambiguate the colliding names), after which
   one line suffices.
4. **Does it depend on being remembered at a specific pressured moment?**
   Then it will fail exactly then (instance 4). Either mechanize it or accept
   it as best-effort — but do not count it as a guarantee.
5. **Can the agent check compliance?** "Verify by machine before you report"
   — checkable, keep. "Keep your context spent on the work" — decoration by
   the brief's own test; delete or demote to a rationale clause.
6. **Is it harness mechanics rather than role contract?** Tier constants,
   wire-cost theory, compact thresholds ride with the spawn template, which
   is already per-role and per-harness. Role prompts state the role's
   contract with the team; templates state how this harness runs cheaply.

Scar-tissue tell, for the lead's specific question: **a rule that names an
incident's shape rather than a class** — a tuned number, a specific tool
collision, a duplicated mechanism (the watchdog rule, deletable per §4.2/3).
Load-bearing tell: a rule that allocates authority or defines a channel — the
hand's ambiguous-vs-wrong-spec ladder (hand lines 34-45), never-commit (47),
flag-don't-take scope (29-33), the reviewer's entire verdict contract. Those
are the lines that make the team a team rather than three agents with vibes.

### 5.3 The law this yields

The reviewer prompt is the shortest (64 lines) and the tightest, and the
reason is not editing skill: it is the role with the most code enforcement
behind it — tools capped in code, verdict channel owned by an intent,
lifecycle owned by the mechanism. **Prompt length is a measure of unenforced
contract.** The path from 290 lines down is therefore not prose editing: it
is (a) enforcement and form absorbing what they can (Grade A/B), (b) tools
teaching their own use, (c) harness mechanics moving to templates, (d)
deleting rules that duplicate mechanism, and (e) deleting unmeasured
economics-as-identity (§1.4). Applying the test across the three files
plausibly leaves a lead contract near 60 lines, a generic *worker* contract
(renamed from hand — it is role-agnostic once the software nouns move out,
§6) near 55, and the reviewer roughly as-is — with the cut half *moved*, not
lost. Those numbers are estimates to steer the edit, not a mandate.

Named unknown, honestly: no measurement exists of whether principle-framing
("the one number you protect") changes agent behavior at all. Instance 4 is
one data point against prompt-presence guaranteeing application; it is zero
data points on whether the framing helps at the margin. Trim by the test
above; treat efficacy claims in either direction as unmeasured.

---

## 6. Versatility

### 6.1 What is actually software-shaped

Audited part by part:

- **The mechanism** — manifest, seats, tickets, roles-by-name, review intent,
  artifacts, write-ahead — contains no software assumption. It bends.
- **The verification lexicon in the prompts** is software all the way down:
  "tests green, build passes, types" (hand line 49, lead lines 88-89),
  "suite green at N," the reviewer's "confirm the test exists and exercises
  the claimed behavior." On a manuscript these sentences are not wrong, they
  are meaningless.
- **The publication rule** — "never commit or push; the lead owns the commit
  train" (hand line 47) — is git-shaped but generalizes cleanly: workers
  produce in draft form; the lead owns publication and integration. Most
  domains have the draft/publish distinction; only the nouns change.
- **EXEC COMMANDS** (lead lines 90-92) is already the right abstraction: "the
  checks the operator granted, returning a bounded digest." The prompts just
  happen to name software instances of it.

### 6.2 The one rewording that buys domain neutrality

**Every dispatch names its own done-check.** The spec carries its oracle: the
command to run, the comparison to make, the criterion a cold reviewer applies.
The worker contract then says "verify by the check the spec names" instead of
"tests, build, types," and the lead's discriminator (§1.2, cheap
verifiability) becomes a per-task question the spec must answer before
dispatch — which is also exactly the discipline that keeps dispatch honest in
software. One rule, no mechanism, and the prompts stop being embarrassing on
a novel.

Behind it sits a domain-general verification ladder, replacing "tests are
green" as the theory of verification:

1. **Machine oracle** — the domain affords a mechanical pass/fail (software;
   data analysis via reproducible runs pinned to data hash + code commit).
2. **Pinned comparison** — no oracle, but claims can be pinned and checked
   (sources cited and checkable, figures recomputed, quotes verified). The
   durable-state rules do the heavy lifting here unchanged.
3. **Cold review** — judgment verified by an independent capped reader. This
   is the team's most enforced ritual, and in weak-oracle domains it is
   promoted from secondary to primary verification.
4. **Lead re-derivation** — the expensive floor; work that lives here fails
   the §1.2 discriminator and should not have been dispatched.

Software's luxury is rung 1. Writing lives at rung 3, research at 2-3, data
analysis at 1-2. The economics degrade as the rung climbs — verification
takes judgment-context instead of machine time — so **the band from §1.4
narrows, and the correct team shrinks** toward lead + review ritual. The
team-of-one default (§3.1) means the mechanism's resting state is precisely
the configuration weak-oracle domains want: the design converges instead of
breaking.

### 6.3 Sketches, one line each

- **Research thread**: the lead holds the thesis; literature sweeps are
  delegation's best case surviving intact (big reads, pointer-shaped
  reports, dead contexts); cold review reads the argument for the unclaimed
  weakness. The team works.
- **Data analysis**: rung 1-2; reproducibility is an oracle; pins are data
  hashes and code commits; hands run pipelines. The team works.
- **Writing project**: weakest case for workers (drafting resists
  compact specs; a chapter's spec approaches the chapter), strongest for the
  ritual — lead drafts, cold reviewer pressure-tests. The correct team is
  small, and the default now says so.

### 6.4 The named unknown

**Decomposability.** Software decomposes into file-scoped, spec-sized tasks
unusually well. Whether a manuscript or a research argument decomposes into
units a disposable context can execute is not answerable from this evidence
base — it is the main thing a second team on a non-software project would
teach. If a domain's work is one long braid of judgment, the honest answer is
that its team is lead + review, and the mechanism should be content to be
exactly that there.

---

## 7. Findings

1. **The team's marginal value over an agent-with-subagents is the durable
   layer, and every observed failure was in that layer.** The feature's
   distinctive promise was its broken part. The fixes are correspondingly
   concentrated: replay, lifecycle events, provenance — not new subsystems.
2. **The economic claim is unmeasured and currently shipped as identity.**
   Replace the assertion (hand prompt lines 7-9) with the §1.2 discriminator
   in the lead's delegation rules. The claim's true band is narrower than the
   shipped framing: it requires separability, cheap verifiability, and
   amortization simultaneously, and it degrades outside software's oracle.
3. **The role vocabulary reduces to one primitive (`lead`), one enforced
   ritual (review), and one default worker contract.** Users name their own
   roles after their work's nouns; the mechanism consumes only lifetime,
   tools, and addressability — which it already does. Seeding `hand` at
   create was the sample-size-one artifact.
4. **The default team is a team of one**, with a four-sentence understanding
   budget (§3.2) and the discriminator taught at the first dispatch, not at
   setup.
5. **Instance 1: both defects are real and neither fix alone suffices.**
   One-shot delivery is the more general bug (any lead restarts seats);
   replay without the standing-order rules converts a silent stall into a
   visible contradiction; the pair from durable-state closes it. The half the
   lead suspected himself of is the half replay cannot cover.
6. **Prompt length measures unenforced contract.** The token cost of 290
   lines is second-order; attention dilution, generality debt, and setup
   legibility are first-order. The reduction path is enforcement, form,
   tool-taught reference, and template-homed harness mechanics — not prose
   editing.
7. **The infrastructure contradicts its own doctrine in three places**
   (roster liveness, resume-vs-artifact respawn, one-shot "durable"
   delivery). Extending durable-state finding 3: audit the team layer against
   the rules its prompts carry; every contradiction trains agents to distrust
   the rules.
8. **Domain neutrality is one rewording away in the prompts and already
   present in the mechanism.** Spec-carries-its-oracle plus the verification
   ladder replaces "tests are green." The genuine unknown is decomposability
   of non-software work, not the tool.

## 8. What must be built, and what must not

Proposed mechanism, each small, each argued above:

1. **Ticket replay on respawn** — reaffirmed from durable-state §9.2.1
   (§4.1). The single most important item.
2. **Archival fails closed** — archiving/retiring a seat with open tickets
   notifies the lead and marks the tickets (§4.2/6). Extension of an
   existing invariant, not a new one.
3. **Provenance line at spawn** — "fresh" vs "resumed: N KB, last active T,"
   injected and roster-visible; respawn policy made per-role and explicit
   (§4.2/8).
4. **Undeliverable sends fail loudly** (§4.2/2).
5. **Monitor defaults: edge-triggered, self-echo suppressed** (§4.2/4).
6. **Roster renderer separation** — already ticketed (t151).
7. **Team-of-one seeding** in `team:create` (§3.1).

Deliberately not built: artifact-template enforcement in the team layer
(§4.2/5), a verification-queue ticket state (§4.2/7, named as an option for a
team size not yet observed), seat-identity modeling beyond provenance
(§4.2/8), multi-lead support (§2.2).

Named unknowns, restated once: prompt-framing efficacy (§5.3); multi-lead
teams (§2.2); verification-queue mechanism threshold (§4.2/7);
decomposability of non-software work (§6.4); and the umbrella unknown —
whether any of this holds for an operator who did not write the tool. That
last one is not answerable by more design. **The marginal value of further
design from this evidence base is near zero; the next unit of evidence is a
second team, on a foreign project, run by someone else.** The shrunk default
(§3) is what makes that experiment cheap to run and honest to read.

---

## 9. Addendum: three late arrivals, adjudicated at landing

Three observations from the lead landed after sections 1-8 were drafted. Per
the durable-state precedent (its §9), they are adjudicated here and referenced
into the sections they touch, not rewoven. None reverses a ruling above; two
sharpen one.

### 9.1 Instance 9 — the stale host

The host process booted from the code on disk at boot time; commits landed
since; the running app therefore executed code that no longer matched the
repo, and nothing anywhere surfaced the gap — the lead established it by
hand-diffing commit timestamps against the process start. Team edge: the
reviewer seat then judging a diff had been spawned by the stale host through
the very code path the diff replaces.

Ruling: **mostly not this design's to fix, and saying so is the adjudication.**
The general defect is durable-state Class II applied to a process: a running
process is an unpinned cache of the repo — no falsifier strikes it (commits
land without touching it) and no comparator exists for its reader (the boot
commit is recorded nowhere). The fix is Grade A mechanical and belongs to the
infrastructure audit that durable-state finding 3 and this artifact's finding
7 already call for: the host records the commit it booted from and exposes it
on query, after which "stale by N commits" is a lookup, not archaeology.
Designing that here would stretch the team design over the whole host.

The team-owned sliver folds into build item 3: the spawn provenance line
gains one field — the boot commit of the host that spawned the seat — which
is nearly free once the host knows its own boot commit, and answers the one
team-layer question the instance exposed ("which version of the orchestrator
made this seat"). Seats outliving the code that made them is by design and
fine, *provided it is decidable* — which is exactly what provenance buys.
Counted as the fourth specimen of finding 7's genus: infrastructure
undecidable about itself.

### 9.2 The watchdog's payload (refines §4.2/3)

A late-firing reminder arrived carrying a status snapshot written at arm time
in the present tense ("nothing pending, tree clean and in sync") — false on
both clauses 45 minutes later. The lead asks whether this is a new class.

Ruling: **same class, not a new one — and the sharpest possible case of it.**
It is durable-state Class I (a status written to a durable store), with the
aggravation that a scheduled message is a durable record whose read is
*guaranteed* delayed: the write-read gap is the mechanism's entire purpose,
so a present-tense body about anything that can move is wrong by
construction, not merely at risk. Durable-state rule 6 governed the timer's
firing (name what cancels it, or carry a fire-time predicate); this adds the
complementary content rule for the body, same register:

> A scheduled message body carries referents, not state: what to check, and
> where the durable artifact lives. Any sentence in it that could be false at
> fire time without anyone editing it does not belong in it.

The lead's own reminder was a clean minimal pair inside one message: the
artifact path and pickup note stayed true; the status sentence rotted. Folded
into §4.2/3's fix list alongside the predicate-guarded stall nudge.

### 9.3 The subordinate-clause rule (evidence for §5; unifies with instance 2)

The lead prompt documents dispatch in one bullet where the backlog case —
omit the assignee and the ticket queues; name one and the spec is delivered
immediately — rides as a trailing subordinate clause. The rule's own author
opened three intended-backlog tickets in the assigning form, delivering them
into a seat mid-task on a tree under active review; one would have edited
files inside the diff being judged. The tool's confirmation lines, not the
prompt, caught it. Three rulings:

1. **This is the deciding principle §5.2 was reaching for, now with
   evidence: a load-bearing distinction gets its own line.** The test for
   prompt text is retrieval under load, not presence: a hurried reader
   retrieves a sentence's main claim and drops the qualifier, so two
   operations with materially different consequences encoded as
   main-clause-plus-subordinate get conflated precisely under pressure. The
   fix costs a line break. Added to the §5.2 survival test as its retrieval
   criterion. This is the third datum that presence does not produce
   application (after instance 4 and the two-channel habit in instance 1),
   and the first that localizes the *why* to sentence shape rather than
   attention alone.
2. **It unifies with instance 2 into one finding, stronger than either:
   category collapse.** Two categories with different consequences rendered
   in one undifferentiated shape — in a renderer (role definitions and live
   seats, one list) and in a prompt (backlog and immediate dispatch, one
   bullet) — are the same defect in different media, and the fix is the same:
   consequence-differing categories get structurally disjoint presentation.
   Durable-state named the roster case "undecidability of assertion type";
   this generalizes it past stores to every surface an agent reads, prompts
   included.
3. **The catch came from confirmation lines** — direct evidence for §5.2
   question 3 (the tool teaches at the moment of use). The Grade B option is
   to put the distinction in the grammar itself: a separate verb for backlog
   (say `task queue …` with `task add <role>` always meaning deliver-now), so
   the wrong form cannot be typed accidentally. Proposed as **build item 8,
   small and optional** — carried past the prefer-rules constraint because
   this near-miss, uniquely in the set, reached toward work product under
   active review, and form-mechanism is the shape durable-state showed
   degrades slowest.

Net changes to section 8: build item 3 gains the host-boot-commit field
(§9.1); item 8 (backlog verb split, optional) is added (§9.3); the
infrastructure-audit call in finding 7 now covers the host's
self-decidability (§9.1). The closing judgment of section 8 stands
unchanged — these arrivals were more evidence for existing rulings, which is
itself weak confirmation that the classes drawn above are the right ones.
