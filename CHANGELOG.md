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
