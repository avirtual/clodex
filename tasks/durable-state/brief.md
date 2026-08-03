# Brief: the durable-state protocol

Design task. Reason, do not implement. No file sweeping — everything needed
is below, written by the lead who lived the instances.

## The system

Clodex runs several CLI agents side by side. An agent's context does not
survive: it is compacted, cleared, or the process is restarted, and a fresh
instance resumes the work. Anything not written down is gone. So agents write
state to disk — task artifacts (`tasks/<name>/*.md`), a project memory file,
a native memory store, team tickets, and code comments.

The problem is not that they fail to write. It is that what they write stops
being true, and the next reader cannot tell.

## Five instances, all from one session (2026-08-04)

**1. The re-run suite.** A task artifact said "Full-suite confirmation —
running at time of writing." A restarted instance read it and could not
distinguish *finished green* from *died with its process*. It re-ran a suite
that had already passed. Cost: ~13 min plus a wedge that had to be diagnosed.

**2. The stale TODO.** The same artifact listed "fast-mode 2x table missing
from the JS port" as open work. It had shipped a day earlier — landed by an
earlier instance of the same agent, after the artifact was written. The lead
repeated the claim to a teammate, who had to correct it.

**3. The lost lift.** The lead told a hand "nothing to start right now, don't
touch wire/billing.js" (a hold, during a conflicting edit). Later it assigned
that hand a ticket — a *different* channel. A GUI restart respawned the hand
in between. The hold survived, in the resumed transcript. The assignment did
not. The hand sat idle, correctly obeying an order nobody had lifted.

**4. The half-true comment.** A code comment said a refresh "fires for the
CLI's own auto-compact too, because the watcher reads the transcript." True
on one of two code paths; on the other there is no steady-state watcher, so
it never fires. A cold reviewer caught it. It had been true when written for
the path its author was looking at.

**5. The stale bundle.** A committed build artifact (`web-dist/index.html`)
did not contain a feature merged days earlier. Invisible to `git status` —
the file was committed and unmodified. Only regenerating and comparing
revealed it. A release preflight caught it minutes before it shipped.

## The one fix invented that worked

A review log, `.claude/review-log.md`. Entries are keyed by
`git diff -- <files> | shasum -a 256 | cut -c1-12`, and written **when the
verdict lands**, never when the review is requested. A matching hash means
those exact bytes were reviewed. A non-matching hash means the entry
describes bytes that no longer exist and is silent about what is there now.
An abandoned review leaves no entry at all — which is correct, because a
reader cannot tell a finished review from one that died.

Two principles are tangled in there and the lead cannot cleanly separate
them: *content-addressing* (identity from the thing itself) and *record
outcomes, not statuses* (only write what stays true).

## What to produce

An artifact at `tasks/durable-state/design.md`.

1. **The general property.** What makes written state survive a reader who
   does not know when it was written? Instance 5 suggests the property is not
   only about time — that file was wrong the moment it was committed. Name
   the property precisely enough to test a candidate piece of state against
   it.

2. **A taxonomy of the failure.** The five instances are not obviously one
   thing. Some are *unfalsifiable* (nothing available to the reader decides
   truth), some are *stale* (was true, silently isn't), some are *partial*
   (true in a scope the writing does not name), one is *channel loss* (never
   arrived). Are these one class or several? A distinction is only worth
   drawing if it implies a different fix.

3. **Which are mechanically preventable.** A hash either matches or does not
   — no discipline required. Instance 5's guard is the same shape: regenerate
   and compare. Instance 3 seems to need protocol, not mechanism. Draw the
   line and justify it. Mechanism beats protocol wherever it reaches, because
   protocol degrades under context pressure and mechanism does not.

4. **Placement.** State currently lands in five places: task artifact,
   project memory file, native memory store, team ticket, code comment. The
   lead placed things in four of them last session largely by feel. What
   belongs where, decided by a property of the state rather than by taste?
   Relevant: memory units are retrieved lexically and may not surface;
   comments are read only by someone already in the file; artifacts are read
   by whoever picks up the task; tickets are the only channel that notifies.

5. **The writing rule.** Something an agent can apply while writing, not a
   checklist to audit afterwards. It must be short enough to survive being
   carried in a system prompt, and it must make the wrong form feel wrong at
   writing time — "running at time of writing" has to look obviously broken
   to whoever types it.

## Constraints

- Do not propose new infrastructure that needs building unless the argument
  is strong and stated as such. Prefer rules over tools.
- Existing repo conventions on comments are in CLAUDE.md and are already
  strict — a comment earns its place only by naming a wrong change it
  prevents. Instance 4 is a comment that passed that bar and was still wrong,
  which is the interesting part.
- Every claim in this brief is a real event, not a hypothetical. If the
  design implies one of them was actually fine, say so — that is a finding.
