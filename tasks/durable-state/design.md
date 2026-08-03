# Durable state: why written state betrays its reader, and the rules that stop it

Design artifact for `tasks/durable-state/brief.md`. Six real instances (five in
the brief, the roster ghost from the dispatch message) are the data. Everything
below is tested against all six. A seventh instance and the lead's decisions on
§8 are folded in as §9 (addendum, post-review).

---

## 0. The theory in one paragraph

Every piece of durable state is a **cache**: it stores the result of some
derivation (a test run, a look at the codebase, a build, a decision, a query of
live processes) so that a future reader doesn't have to re-derive it. A cache
is only sound if it has an **invalidation path**, and there are exactly two:
**the falsifier strikes it** (whoever makes the claim false updates the record,
which requires the record to be in front of them at that moment), or **the
reader validates it** (the record carries a pin — hash, commit, scope — that
the reader can cheaply compare against the present). Every one of the six
instances is a record with *neither* path. The whole design falls out of this:
the general property is read-time decidability, the taxonomy is "which
ingredient is missing," the mechanism/protocol line is "which invalidation
path is computable," and placement is "which store puts the falsifier in view."

---

## 1. The general property

**A record is durable iff a reader holding only the record and the world in
front of them can decide whether it still binds.** Call this **read-time
decidability**. It decomposes into exactly three ingredients, and each of the
six instances is missing at least one:

1. **Outcome.** The claim describes a completed event, so the world cannot
   make it false after the fact. "Suite passed at commit `abc123`" is true
   forever; "suite is running" has a validity interval whose end the writer
   cannot know and the reader cannot detect.
2. **Pin.** The claim's subject is named by an immutable referent — content
   hash, commit SHA, file path + commit, named code path, timestamp of a
   completed event — so the reader can decide whether the claim is *about the
   thing in front of them*. Without a pin, even an eternally true claim is
   unusable: "reviewed the billing changes: approved" never becomes false, but
   nobody can tell whether today's `billing.js` is the bytes it blessed.
3. **Home.** The record lives in the store its reader will actually consult,
   and — this is the part taste gets wrong — in the store its **falsifier**
   will trip over at the moment of falsification.

The practical test for any candidate line of durable state:

> **Could this sentence become false, or become about something else, or fail
> to be seen, without anyone editing it?**

If yes on any of the three, it fails. Note what the test is *not*: it is not
"is this dated?" Instance 1's artifact said "at time of writing" — an honesty
marker. Honesty about fragility is not decidability: the reader knew the claim
was dated and still could not resolve it either way, and paid ~13 minutes plus
a wedge diagnosis. **Timestamps let a reader rank records; only pins let a
reader decide them.** "Always timestamp" is the popular fix and it is
insufficient.

Why instance 5 proves the property is not temporal: the committed bundle was
wrong the moment it was committed. A property phrased as "state decays" would
have to exclude it. Read-time decidability includes it naturally: the bundle
is a cached derivation of the source tree with no pin (no recorded input hash)
and no falsifier-in-view (`git status` clean, so nothing surfaces it). A
born-wrong cache and a rotted cache are *indistinguishable to the reader* and
share the same fix — that they land in the same class is the check that the
property is right. (Answering the brief's pushback directly: instance 5
belongs, and its membership is what forces the property to be non-temporal.)

One more consequence worth stating because it justifies the harshest rule
below: **an undecidable record is worse than silence.** The value of a record
is the re-derivation it saves. An undecidable record forces the re-derivation
anyway *plus* the cost of diagnosing the ambiguity (instance 1: the re-run
*and* the wedge). The reader who re-ran the suite behaved correctly — that is
the point. You cannot fix this class at read time with smarter readers;
conservative re-derivation is already the optimal read strategy and it is
still waste. The fix is entirely on the writer and the store.

---

## 2. Untangling the review log

The review log works because three separable principles coincide in it. They
are genuinely independent — each can be present without the others, and each
absence fails differently. The 2×2 over the first two:

| | **No pin** | **Pin (diff hash)** |
|---|---|---|
| **Status** | "review in progress" — undecidable and unaddressed. Instance 1's shape. | "reviewing hash H" — you know *what*, still can't know *whether it finished*. Content-addressing does not rescue a status. |
| **Outcome** | "reviewed the billing changes: approved" — eternally true, but the reader can't bind it to today's bytes. True-but-unusable. | "hash H: approved" — decidable on both axes. The review log. |

So:

- **Record outcomes, not statuses** buys **truth-permanence**: the claim is a
  historical event, immune to world-change. It answers the reader's first
  question, *"is this still true?"* — with "always, by construction."
- **Content-addressing** buys **relevance-decidability**: identity comes from
  the bytes themselves, so matching is a mechanical comparison and a mismatch
  is *silence*, not error — the record correctly says nothing about bytes it
  never saw. It answers the reader's second question, *"is this about what's
  in front of me?"*
- The third principle is hiding in "written when the verdict lands, never when
  requested": **meaningful absence**. Since intent is never written, *no entry*
  unambiguously means *no completed review* — which correctly collapses
  "abandoned" and "never started" into one reader-visible state, because the
  reader genuinely cannot and need not distinguish them. Strictly this is a
  corollary of outcomes-only (writing "review requested for H" is writing an
  intent, a species of status) — but it deserves separate naming because its
  guarantee is *fragile in a way the other two are not*: one speculative entry
  poisons the semantics of absence for the whole log. Outcomes-only is a
  per-record rule; meaningful absence is the log-wide property you get only if
  the per-record rule is followed without exception.

Generalization of content-addressing: it is the strongest member of the family
**immutable referents**. Commit SHAs and completed-event timestamps also
qualify. Content hash is strongest because it is self-verifying against the
bytes in front of you with no registry to trust; commit SHA requires trusting
git (fine); a timestamp immutably names a moment but gives the reader no cheap
way to compare "the world at T" with now — hence rank-not-decide, above.

The review log's pattern generalizes and should be named, because it is
reusable as-is (a convention file, zero build cost — same as the review log
itself):

> **Outcome log**: an append-only file of `(immutable referent, verdict,
> timestamp)` tuples, written only at completion. No other entry shape exists.

Instance 1 is solved by the identical pattern: a suite-run log with entries
`<commit> <suite> <verdict> <time>`, written when the run *exits*. A restarted
instance reads either a verdict for its commit or nothing — and nothing
correctly means "not known to have passed, run it."

---

## 3. Taxonomy

Keyed by **missing ingredient**, not by how the wrongness arose — because the
reader can't observe how it arose, and the fix tracks the ingredient. Three
classes. Each implies a fix the others don't, which is the test the brief set.

### Class I — No outcome: the record asserts liveness or in-flight state
*Instances: 1 (suite "running"), 6 (roster ghost), and the hold in 3 (partly).*

The claim's truth is a property of a live process. There is **no possible
invalidation path**: the falsifier is the process dying or finishing, which
writes nothing; and there is no comparator a reader can run against prose.
Statuses are not bad caches — they are *uncacheable*. The fix is categorical:

> **Never write in-flight state to a durable store. Write the outcome when it
> lands; until then, absence is the record.** Liveness may only ever be
> *queried*, never read off a page.

Instance 6 fits here with a twist: the roster block rendered a role
*definition* in the same visual shape as live seats — the record blurred two
assertion types ("this role exists" vs. "this process is running"), so the
reader could not tell which claim was even being made. Undecidability of
*assertion type* is undecidability all the same. The twist that matters: this
violation was committed by the **system's own tooling**, not by an agent under
pressure — the roster renderer is a cache of live process state whose format
hides that fact. Its fix is fully mechanical (see §4) and it is a finding on
its own: the infrastructure currently violates the rule the agents are being
asked to keep.

### Class II — No pin: the record is unbound to its subject
*Instances: 2 (stale TODO), 4 (half-true comment), 5 (stale bundle).*

The claim is or was a legitimate outcome — the result of looking, building,
verifying — but nothing binds it to *what exactly* was looked at, so the
reader cannot detect mismatch. Three sub-cases along "what the missing pin
is," which matter only because their enforceability differs (§4), not because
the writing rule differs:

- **Missing temporal pin** (2): "fast-mode 2x table missing from the JS port"
  is a present-tense claim about a moving codebase. Pinned form: "at commit
  `C`, fast-2x absent from `js/`." That form never becomes false; a reader at
  commit `C'` knows exactly what is claimed and that they must re-derive for
  `C'`. The unpinned form silently transitions from true to false and keeps
  the same face.
- **Missing structural pin / unstated scope** (4): "fires for auto-compact
  too" was true on the code path the author was looking at — the claim's real
  scope was narrower than its sentence's scope, and the frame was in the
  author's head, not the record. Pinned form: "fires on path A (verified);
  path B has no steady-state watcher — not checked." Note this comment passed
  the repo's strict comment bar, which tests *usefulness* (names a wrong
  change it prevents) but not *scope-honesty*. The bar needs the amendment:
  **a comment claims only the scope its author verified, and names it.**
- **Missing derivation pin** (5): the bundle implicitly asserts "I am the
  build of this source" and nothing binds the assertion — no recorded input
  hash, and `git status` clean. This is the *pure* form of Class II: no decay
  story required, wrong from birth, invisible to every passive check.

Fix shape for the whole class: **pin the claim to what was actually observed**
(commit, hash, path, named scope) — after which either a comparator can
validate on read (5, mechanical), or the reader at least knows the claim's
frame and when re-derivation is needed (2, 4).

### Class III — No home: the state and its mutations live in different stores
*Instance: 3 (the lost lift).*

The hold traveled on one channel (chat, replayed into the resumed transcript);
the assignment that implicitly lifted it traveled on another; a respawn kept
one and lost the other. Even with perfect delivery this record was fragile,
for two reasons that give two fixes:

- **The lift was implicit.** The assignment nowhere said "this supersedes the
  hold." A reader holding *both* messages must infer supersession. Fix
  (protocol): **standing orders get names, and any write that changes standing
  state names what it changes** ("HOLD-billing: lifted"). You cannot reference
  what has no name.
- **The hold had no lift condition.** "Don't touch `wire/billing.js`" is
  open-ended: its end can only arrive as a *message*, and messages can be
  lost. "Don't touch `wire/billing.js` until diff `H` lands / until ticket #N
  closes" makes the lift **derivable**: the reader checks the condition
  instead of waiting for a delivery. This converts the lift from Class III
  (delivery problem) into Class II mechanics (a pinned, checkable claim) — the
  single highest-leverage move available for orders.

Plus the placement half (§5): behavior-binding state belongs *only* in the one
store that notifies and has a closure lifecycle — the ticket. The hold-as-
ticket dies by being closed; closing *is* the lift; a respawned hand replaying
open tickets gets exactly the standing orders and nothing lapsed.

Class III does not reduce to I+II. A perfectly formed order — outcome-framed,
pinned, lift-condition attached — still fails if it never reaches its reader
or if its supersession lands in a store the reader doesn't replay. Truth (I),
relevance (II), and delivery (III) are three independent properties of the
reader's situation: *is it true? is it about this? did it reach me?*

### Distinctions deliberately not drawn

- "Stale" vs. "wrong from the start" (2 vs. 5): the reader cannot distinguish
  them and the fix (pin + comparator) is identical. Drawing it would be
  taxonomy for its own sake.
- "Unfalsifiable" vs. "stale" as top-level classes (the brief's candidate
  split): unfalsifiable-forever (statuses, Class I) versus
  falsifiable-but-unpinned (Class II) survives, but "stale" as a category does
  not — staleness is a *symptom* that Class II records exhibit over time and
  Class I records exhibit instantly. Classifying by symptom would put 2 and 5
  in different classes with the same fix, and 1 and 2 in the same class with
  different fixes. Wrong both ways.

---

## 4. Where mechanism actually reaches

The line: **mechanism reaches exactly as far as the claim's truth conditions
are computable from artifacts the system holds** — bytes, hashes, commits,
file trees, process tables. Where truth lives in meaning ("is this TODO
done?", "is this comment's scope honest?"), no comparator exists and protocol
must carry it. But there is an underrated middle grade that the review log
itself demonstrates, and it is the main answer to "protocol degrades under
pressure":

**Three grades of enforcement:**

**Grade A — check-mechanism (full).** The truth is computable; a comparator
decides, no discipline involved.
- Instance 5: regenerate-and-compare. It already exists in release preflight
  (it caught the bundle); move it earlier — pre-commit hook or CI — so the
  wrong bundle cannot be *committed*, not merely cannot ship. Alternative with
  the same shape: commit the input-tree hash beside the artifact and compare
  hashes instead of rebuilding. Either way, zero protocol.
- Instance 6: fix the roster renderer — definitions and live seats must be
  visually/structurally disjoint, or liveness must be omitted from static
  rendering entirely and obtained only by the query command. This is a tool
  bug, not an agent-discipline problem; no rule for agents can fix it.
- The review log and any outcome log (§2): hash comparison at read time.

**Grade B — form-mechanism (the schema refuses the wrong write).** The truth
is not computable, but the *shape* of the store can make the undecidable form
inexpressible. An outcome log whose entries are `(referent, verdict, time)`
has no way to say "running" — the wrong entry doesn't fail review, it fails to
*parse*. This is why the review log worked without anyone getting more
disciplined: the entry format has no slot for intent. Form-mechanism degrades
far more slowly than free-recall protocol because an empty slot is visible at
writing time — which is exactly the brief's requirement that the wrong form
*feel* wrong.
- Instance 1: a suite-run outcome log (Grade B store) instead of prose in a
  task artifact. Cost: a convention, not a tool.
- Instance 2: task-artifact template with a mandatory `as of <commit>` slot on
  any claim about codebase state. An unpinned present-tense claim visibly
  doesn't fit the template.

**Grade C — protocol with mechanical tripwires.** The truth lives in meaning;
a rule carries it, and cheap lints raise the cost of violating it silently.
- Instance 4: scope-honesty is judgment — the machine cannot know the claim's
  true scope is narrower than written. Rule: claim only the verified scope,
  name it. Tripwires: universal quantifiers in comments and artifacts
  ("both", "all", "always", "too") demand a named verification scope; present
  progressive and "at time of writing" in durable files are grep-able smells.
  (A cold reviewer caught instance 4 — cold review is itself a protocol that
  demonstrably works and should be counted as part of the system, not
  overhead.)
- Instance 3: naming orders, naming supersession, attaching lift conditions —
  protocol at writing time, though the lift condition, once written, is
  checked mechanically (Grade A at read time). Delivery is mechanizable if
  respawn replays open tickets (see open questions).

**Summary table:**

| Instance | Class | Grade | Fix |
|---|---|---|---|
| 1 suite "running" | I | B | outcome log written at exit; absence = not passed |
| 6 roster ghost | I | A | renderer separates definitions from live seats; liveness query-only |
| 5 stale bundle | II | A | regenerate-and-compare at pre-commit/CI (or input-hash pin) |
| 2 stale TODO | II | B + C | `as of <commit>` slot; falsifier strikes the line (protocol) |
| 4 half-true comment | II | C | verified-scope rule; quantifier tripwire; cold review |
| 3 lost lift | III | C → A | orders as tickets, named, with lift conditions; closure = lift |

The honest bottom line for "where mechanism reaches": **Grade A covers two of
six instances outright (5, 6) plus every future instance of the
already-solved review shape. Grade B covers two more (1, 2) at the cost of
adopting two conventions with zero build. Only 4, and the writing half of 3,
irreducibly need protocol — and both have tripwires.** That is a much larger
mechanical footprint than "hashes match or they don't" suggests, because
form-mechanism counts: a store that cannot express a status is a mechanism,
even though no code runs.

---

## 5. Placement

The principled criterion, replacing feel: **put state where its falsifier will
trip over it.** Rationale: the writer cannot know when a record will go false
— but the *falsifier* always knows, because they are the one doing it. Store
choice is therefore not about where writing is convenient; it is about
maximizing the chance that the person or process making a claim false has the
record in view at that exact moment (write-invalidation), and where that is
impossible, the record must carry a pin so readers can validate instead
(validate-on-read). Every durable record must be covered by at least one of
the two. Records covered by neither are the six instances.

The five stores, by their falsifier-visibility and delivery properties:

| Store | Reader | Falsifier sees it? | Notifies? | Natural death | Therefore holds |
|---|---|---|---|---|---|
| **Code comment** | someone already in the file | yes — the falsifying edit is in the same diff | no | edit of adjacent code | claims falsified **only** by edits to the code the reader is looking at |
| **Task artifact** | whoever picks up the task | yes — the task worker is the usual falsifier | no | task ends | task-scoped outcomes and pinned observations; nothing that outlives the task |
| **Team ticket** | its addressee | yes — the order-giver owns and closes it | **yes (only one)** | closure | anything that must **change someone's behavior**: orders, holds, assignments. Closure = lift |
| **Project memory file** | everyone, at session start | only decision-makers | no | explicit decision | invariants and conventions only — claims falsifiable **only by a decision**, never by the world drifting |
| **Native memory store** | maybe nobody (lexical retrieval, may not surface) | **never** | no | none | only redundant recall hints — conclusions reconstructible from elsewhere. **Never the sole home of anything load-bearing** |

Derived placement laws, each doing real work against an instance:

- **A comment may only assert facts falsified by edits its reader will see.**
  Instance 4's cross-path claim was *misplaced*, not merely wrong: a comment
  on path A claiming behavior of path B protects no one — path B's editor
  never sees it, and path A's reader is misled about B. Cross-cutting claims
  either scope down or move to where readers of either path look.
- **Behavior-binding state goes only in the notifying store.** The hold in
  instance 3 lived in a transcript — a store that is append-only, unowned,
  unaddressed, and replayed by luck. The lead (the hold's falsifier) had no
  way to strike it there. As a ticket, the falsifier owns it and closing it is
  the lift. Corollary worth making official: **transcripts are not a state
  store.** They have the worst properties of all five candidates and agents
  currently rely on them implicitly.
- **A present-tense status has no valid placement.** Not a placement problem —
  a Class I problem. If the placement question feels hard for some piece of
  state, check whether it is a status; the difficulty is usually the state
  trying to be uncacheable.
- **Project memory rejects anything the world can falsify.** A status or
  observation in the session-start broadcast file is stale for *everyone
  simultaneously*.

The complement protocol that placement is designed to enable — the second half
of instance 2's fix, since the shipping instance plausibly had the artifact in
view and didn't strike the line:

> **The falsifier strikes.** When your change makes a written claim false, you
> are the only agent in the system that knows. Update or strike the record in
> the same action as the change.

Placement's entire job is to make this rule cheap: the right store is the one
where the falsifier doesn't have to remember the record exists.

---

## 6. The writing rule

Kernel, four words: **past, pinned, placed — or not written.**

Prompt-ready form (5 lines, each traceable to a class):

> **Durable-state rule.** Whatever you write down will be read by someone who
> cannot ask what you meant.
> 1. Write outcomes: past tense, pinned to what you actually saw — commit,
>    diff-hash, path, named code path. "Suite passed at `abc123`," never
>    "suite is running."
> 2. If it could become false without you editing it, don't write it. **No
>    entry is the record of in-progress.**
> 3. Claim only the scope you verified, and name it: "fires on path A
>    (verified); path B not checked."
> 4. A standing order lives only where it notifies (a ticket), is named, and
>    states what lifts it. Closing it is the lift.
> 5. When your change makes a written claim false, strike the claim in the
>    same action. You are the only one who knows.

Why this survives writing-time pressure where a checklist wouldn't: the tell
is **grammatical**, so it fires while typing, not during an audit. Present
tense about the world — "is running," "is missing," "fires for X too," "don't
touch Y" (open-ended) — is the smell, visible in the sentence itself before it
is even saved. "Running at time of writing" fails rule 1 twice in its own
words: progressive aspect, and a self-confessed unpinned timestamp. The rule
makes it *look* broken, which is what the brief asked for. Rules 1–3 are also
Grade-B enforceable wherever a template or outcome log exists (§4), so under
the worst context pressure the store catches what the rule misses.

---

## 7. Findings and pushback

1. **Instance 5 belongs, and it is the keystone.** The taxonomy keyed on
   missing-ingredient (not decay) is *forced* by including it, and that
   version of the taxonomy is the one where fixes line up cleanly. If it had
   been excluded as "a different problem," the property would have drifted
   toward time and mis-prescribed timestamps as the fix.
2. **None of the six was "actually fine," but two behaviors inside them
   were.** The restarted instance's decision to re-run the suite was the
   correct read of an undecidable record — conservative re-derivation is
   optimal read strategy, which is precisely why the fix must be writer-side.
   And instance 1's "at time of writing" was honest — the finding is that
   honesty markers and timestamps make records *rankable*, not *decidable*,
   so "always date your claims" is a trap fix.
3. **The system's own tooling commits Class I.** The roster renderer wrote a
   liveness-shaped record that blurred definitions with live seats. Before
   asking agents to keep the rule, fix the renderer — mechanism reaches all
   the way here, and an infrastructure that violates the rule trains readers
   to distrust the rule.
4. **The repo's comment bar has a gap.** "Names a wrong change it prevents"
   tests usefulness, not scope-honesty; instance 4 passed it while
   over-quantifying. Amend the bar: a comment states the scope it was
   verified in, and may not assert facts about code its reader isn't looking
   at.
5. **The review log's real lesson is the store shape, not the discipline.**
   It worked because its entry format cannot express intent — form-mechanism.
   Replicating the *discipline* elsewhere will decay; replicating the *entry
   shape* (`referent, verdict, timestamp`, written at completion) will not.
   Suite runs are the immediate second application.
6. **Transcripts should be officially demoted from state-store status.**
   Instance 3 is at root an agent treating a transcript as durable addressed
   storage. It is none of those things.

## 8. Open questions for the lead

*(All four resolved post-review; resolutions recorded in §9.2. Left as
written.)*

1. **Do tickets replay/notify on respawn today?** The Class III fix (orders
   as tickets, closure = lift) is mechanical only if a respawned agent
   reliably sees its open tickets. If not, that replay is the one piece of
   genuinely new mechanism worth building — flagged per the brief's
   constraint, argument as stated in §3/III.
2. **`web-dist` policy:** pre-commit regenerate-and-compare, an input-hash
   pin committed beside the bundle, or stop committing the bundle at all?
   All three are Grade A; the choice is build-cost vs. repo hygiene and is
   the lead's call.
3. **Adopt the outcome-log pattern for suite runs now?** Zero build (a
   convention file like the review log), removes instance 1's whole class.
4. **Where do the writing rule's five lines live?** They fit a system prompt;
   they could also (or instead) go in the project memory file — which, per
   §5, is exactly the right store for them: an invariant, falsifiable only by
   deciding otherwise.

---

## 9. Addendum (post-review): the seventh instance, and resolved questions

### 9.1 Instance 7 — the moot watchdog

Three reminder-watchdogs, armed to guard work in progress, fired *after* the
guarded work had completed — announcing nothing, costing their reader (the
future self) the diagnosis of whether the alarm was real. The lead asks: a
fourth class, or Class I with an unusual reader?

**Neither, quite — and it is not a fourth class.** The test for a new class
is a fix the existing classes don't supply, and the watchdog's repair menu is
exactly the standard two invalidation paths from §0. What it *is*: a record
whose **read is scheduled and unconditional** rather than incidental — a
timer is a cache of the claim "this will still need attention at T+Δ," and
because the read is forced, undecidability doesn't surface as wasted
re-derivation but as **noise the reader must triage**. Same wedge-diagnosis
cost as instance 1, delivered by alarm instead of by page.

It is not plain Class I, because the categorical Class I fix — "write the
outcome instead" — is unavailable: a reminder is legitimately *about* the
future; it has no outcome-form. But the two general invalidation paths both
apply, and they are precisely the two fixes the situation offers:

- **Falsifier-strikes = cancel at completion.** This is a *placement* fix
  (Class III's home rule): the timer must die with the thing it guards. The
  structural problem the lead correctly sensed is that timers are invisible
  to their falsifier by construction — a pending reminder lives outside
  every store the completing agent touches, so "remember to cancel it" is
  pure protocol and will decay. The mechanical version: **arm reminders
  attached to the ticket or task they guard, so closure cancels them** —
  the same lifecycle move as closure-lifts-the-hold. A watchdog is a
  standing order addressed to a future self, and it inherits the standing-
  order rules wholesale: named, homed where lifecycle events reach it,
  dying by the same event that completes the work.
- **Reader-validates = predicate at fire time.** Arm the reminder with the
  condition it guards — "fire iff suite verdict for commit `C` absent from
  the outcome log," "fire iff ticket #N still open" — and have it stay
  **silent when the predicate fails**. This is the review log's
  silence-on-mismatch applied temporally, and it is the same Class II
  conversion that turned the hold's lift from a message into a checkable
  condition. It also degrades gracefully: a predicate reminder that fires is
  *known* real; a bare reminder that fires is a question.

The one genuinely new lesson, worth a line in the rule because it cannot be
retrofitted: **a scheduled record's invalidation path must be chosen at
arming time.** Every other record can in principle be rescued later by a
disciplined falsifier; a timer cannot, because no one sees it again until it
fires. Proposed rule 6, same register as the other five:

> 6. A scheduled message names what cancels it and dies with that thing —
>    or carries a check and stays silent when the check fails. A bare timer
>    is a status with an alarm attached.

Taxonomy placement, for the record: **Class III (no home) at root — the
pending timer is state whose falsifying event lives in a store the timer
doesn't watch — with the Class II predicate-conversion as the alternate fix.**
Same dual-fix structure as the hold in instance 3, which is the strongest
evidence it is the same class: instance 7 is instance 3 with the future self
as the hand.

### 9.2 Resolutions of §8 (lead's decisions, recorded at landing)

1. **Ticket replay does not exist today — verified against
   `session-manager.js:3577` (`_deliverTicketSpec`, one-shot at assign
   time; open tickets surface only as bare IDs at `:3251`).** Instance 3
   would recur. Replay-open-tickets-on-respawn is confirmed as the single
   new mechanism to build; everything else in this design is convention.
   Note it also mechanizes half of instance 7's fix: if reminders attach to
   tickets, replay + closure gives watchdogs their lifecycle for free.
2. **web-dist: pre-commit regenerate-and-compare.** The existing release
   guard moves earlier; the bundle stays committed (packaging depends on
   it).
3. **Suite-run outcome log: adopted.**
4. **Roster/tooling: agreed, ticketed (t151), and the same session produced
   another specimen of finding 3 — `spawnerHint` honored on one code path
   and silently ignored on the rest: Class II, unpinned scope, in the
   infrastructure itself.** Two tooling instances in one night supports the
   stronger reading of finding 3: the infrastructure should be *audited*
   against the taxonomy, not just patched where instances surface.
