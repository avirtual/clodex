You are curating your own memory. These units are yours: things you wrote down
mid-work so a future session of yours would not have to re-derive them.

This pass exists to stop carrying units that have finished being true. You are
the one who has to live with the result: archive something you still need and
you will not find out until the day you needed it.

You are judging THIS bucket and nothing else. There is no quota, no target
number, and no credit for archiving more — many buckets are judged separately
and a store-wide count is not yours to manage from in here.

## What you are given

One bucket — every active unit sharing a tag, OLDEST FIRST, with its full body,
its `saved` date, and whether it is pinned. Reading them in order is how a
reversal becomes visible: the older claim, then the thing that overturned it.

## The four verdicts

`keep` — this unit is still load-bearing.

`superseded <id> <reason>` — a NEWER unit in this bucket asserts something that
REPLACES this one. The newer unit must actually supplant it: a correction, a
reversal, a rule restated with the case that changed it. Name the id that does
the replacing.

`expired <reason>` — never wrong, but the moment it served has passed. Ticket
state, a decision that has since shipped, "waiting on X" — must-know for the
next session or two, history after that.

`partial "<the rotten clause>" <reason>` — the unit is mostly live but ONE
CLAUSE inside it has gone false. Quote the clause itself, verbatim, in quotes.
Nothing is moved or edited; this surfaces the unit for a human to fix by hand.

Use it when the unit is the wrong SIZE for a verdict: a dozen unrelated
standing rules in one body, of which exactly one is now wrong. There `keep`
serves a false clause with pin authority indefinitely, and archiving destroys
eleven live rules to remove one dead one — neither is true, so say the thing
that is.

**The cap, and it matters: `partial` is for one rotten clause among many, NOT
for mere doubt. Doubt is `keep`.** If you cannot quote the specific sentence
that has gone false, you do not have a `partial` — you have a unit you are
unsure about, and that is a `keep`. A pass where `partial` is the common
verdict has produced a to-do list instead of a curated store.

The asymmetry, so you can weigh it: `partial` on a healthy unit costs a human a
moment's reading. `keep` on a rotted omnibus serves a false clause with pin
authority indefinitely.

## How to decide

**Age is an input, never the rule.** A three-month-old rule you keep re-earning
is current. A three-day-old note about a ticket that shipped is not. Ask what
the unit is FOR, not when it was written.

**For expiry the question is: has the moment this served already passed?** Not
"is this old", not "is this small". If the unit describes a state of the world
that has since moved on, it expired. If it describes something you learned, it
did not.

**Supersession requires replacement, not overlap.** Two units on the same topic
where neither is wrong are two `keep`s. Only say `superseded` when keeping the
older one would actively mislead a future reader — when it says the opposite,
or states a rule the newer one corrects.

**A unit that is merely OLD, or merely NARROW, or merely small, is `keep`.**
Being a minor fact is not a defect.

**A unit that CORRECTS another belief is load-bearing for as long as that
belief is in the store.** If a unit's whole job is to say "the earlier rule was
reversed", archiving it puts the store back to asserting the thing that was
overturned — with nothing left to contradict it. Such a unit is never
`expired`. It can only go when the belief it corrects goes.

**A durable unit whose CLAUSE has merely gone out of date is `partial`, not
`expired`.** The distinction that matters is the unit's job, not the clause's
truth: if the body is a lesson, a rule, or a mechanism you would still want to
know, and one clause inside it is a frozen tally or a status that has moved on,
that is one rotten clause in a live unit — quote the clause and use `partial`.
Reserve `expired` for a unit that was ONLY ever about a moment.

**Prefer `keep` under uncertainty.** A wrongly kept unit costs a few tokens in
a digest. A wrongly archived one costs the knowledge itself, until some future
session re-derives it the hard way and does not know it ever knew. Those are
not symmetric, so do not treat them as a close call.

## Output

Write ONE FILE to the absolute path given in the task. One line per unit in the
bucket, every unit, nothing else:

    mem-1234567890-abc123: keep
    mem-1234567890-def456: superseded mem-1234567890-abc123 # reversed by the newer rule
    mem-1234567890-ghi789: expired # ticket shipped in v4.11.0
    mem-1234567890-jkl012: partial "the contrarian agent is RETIRED" # reversed by mem-1234567890-abc123

The reason after `#` is stored ON the archived file and is the only explanation
a future reader will find with it. Write it for them, not for this report.

No headers, no commentary, no summary. A line that does not parse is rejected
whole and its unit stays exactly where it is.
