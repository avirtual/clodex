# t69 — do dynamic system-prompt sections churn between spawns?

Ticket: `~/.clodex/messages/clodex-hand/msg-81580-25.txt`. Measurement only —
clodex was explicit: do not enable the flag on a hypothesis.

## VERDICT: they do not churn, because they are NOT IN THE SYSTEM PROMPT AT ALL

`--exclude-dynamic-system-prompt-sections` would move per-machine sections out
of the system prompt and into the first user message. **Claude Code already
puts them in the first user message.** The flag has nothing to move.

Recommendation: **close t69, do not enable the flag.** Per the ticket's own
terms — "a flag that fixes nothing is not worth the argv byte or the risk."

## The three questions, answered

**(1) Are these sections present in the system block at all? NO.**

Measured across 1299 captured parent requests in session
`57394bdf-9b64-4cba-84ce-a5d49495fa4a` (my own seat):

    WHERE THE ENVIRONMENT BLOCK LIVES:
       messages[0].content[1]:  1299
       SYSTEM:                     0

Not once in the system block. Confirmed in two further sessions
(`9abb069f…` 779+17, `2c96fbf3…` 22+22 — all `messages[0]`, index varies with
what else is prepended).

The block is the `<system-reminder># Environment` one: primary working
directory, additional working directories, platform, shell, OS version, model
identity, knowledge cutoff.

**GIT STATUS — the section the ticket was most worried about — IS NOT PRESENT
ANYWHERE.** Grepped `gitStatus|Current branch:|Recent commits:` across all
three sessions: zero hits. Only "Is a git repository: true" appears, which is
a boolean that does not change as the agent commits. So the feared mechanism —
every commit arming the next spawn's bust — **does not exist on this setup.**

**(2) Do they differ across spawns? Only by model identity, and it doesn't
matter where they live.**

Two distinct Environment-block versions across 1299 requests. The entire diff:

    - You are powered by the model named Fable 5. The exact model ID is claude-fable-5[1m].
    + You are powered by the model named Opus 4.8 (1M context). The exact model ID is claude-opus-4-8[1m].

A model switch. Not per-machine data, not git state, and not something the
flag would help with — a model switch busts the cache regardless, since the
cache is per-model.

**(3) How many busts are attributable? ONE, and not to these sections.**

`.warmth.json` carries a `bust_class` field — direct attribution, no
hand-rolled inference needed. Over the full session:

    BUST CLASS      n      cache-creation tokens
    conversation    60         1,991,047
    preamble        13           341,560
    tools            3           222,367
    lapse            2           128,282
    system           1            31,506
    (none)        1257

**One system bust in 1333 requests.** Diffed against the previous parent
request, it is:

    seg[0] CHANGED  x-anthropic-billing-header: cc_version=2.1.207.6dd
                 →  x-anthropic-billing-header: cc_version=2.1.209.e2b
    seg[2] CHANGED  12441 → 12800 bytes   (CLI's own system prompt text)
    seg[1] SAME, seg[3] SAME (ours)

**A Claude Code version upgrade** — the CLI's billing header and its own
system prompt body. Nothing per-machine, nothing the flag touches. The other
three system-signature changes in the session are the same thing (version
bumps 207.6a9 → 207.6dd → 209.e2b → 210.7da) plus a model switch.

Zero of the busts are attributable to dynamic per-machine sections, so zero of
the 7 known-avoidable busts can be recovered by this flag.

## Where the money actually went

`conversation` busts dominate: 60 occurrences, ~1.99M cache-creation tokens —
**85% of all bust cost in this session.** That is the real target, and it is a
different mechanism from anything t68/t69/t70 address. Not in scope here;
flagged for clodex as the place a cache ticket would actually pay.

## Consequences for the other tickets

- **t69: close.** The flag is a no-op on this setup.
- **t70 (replace the CLI system prompt): the blocker is measured away, AND SO
  IS THE CACHE JUSTIFICATION.** The worry was that `--system-prompt` forfeits
  this flag's benefit; there is no benefit to forfeit. I initially added that
  replacing seg[2] would make the system block more stable across CLI
  upgrades, and offered it as a point in t70's favour. **clodex overruled that
  and is right:** the entire prize is 31,506 tokens, once, on a CLI upgrade.
  That is noise. t70 goes back to standing on **instruction hygiene alone**,
  which is where it was filed and explicitly not a cost argument. Recorded here
  so that if anyone later revives t70 as a token win, it is pre-refuted.
- **t68:** not folded by this result; unaffected either way.

## Priors that were wrong, recorded deliberately

- **clodex's**, at their own instruction: t69 was ranked above t70 on the
  theory that git status in the system block armed a bust on every commit. It
  is not there. The mechanism they were most worried about does not exist on
  what we ship.
- **Mine**: I took "the blocker is gone" and argued it as a point *for* t70.
  Wrong axis — a removed objection is not a reason to act, and the number I
  cited to support it (31.5k, once) refutes rather than supports.

The ticket asked "do these sections churn." The real answer was "they were
never there" — one level earlier than the question assumed, which is the
second time this week the answer sat upstream of the question.

**Independently confirmed from a second seat**: clodex checked their own
context window and found the same — `# Environment` attached to the first user
message, git state as the `Is a git repository: true` boolean. So the "this
seat, this machine" caveat above is narrower than I stated it.

## THE ACTUAL TARGET (buried here originally — it is the real deliverable)

`conversation` busts: **60 occurrences, 1,991,047 cache-creation tokens — 85%
of all bust cost, roughly 63x everything t68/t69/t70 touch combined.** Three
tickets went to the 15%; the 85% had never had one. clodex has now opened it,
superseding the prompt-hygiene cluster in priority.

## Method (reproducible)

Captures: `/Users/bogdan/projects/proxy-lab/logs_main/<session-uuid>/`
`NNNN-<team>-<seat>-<hash>-<model>-<HHMMSS>.{request,response,warmth}.json`.

- `body.system` is an array of 4 text segments; `cache_control` marks
  breakpoints (segments 1 and 3 carry `ephemeral/1h`).
- `body.messages[0].content[*]` is where the Environment reminder lives.
- `warmth.json.bust_class` attributes each bust; `segments.system.hash` tracks
  system-block identity across requests.

Sessions used: `57394bdf…` (1396 reqs), `9abb069f…` (854), `2c96fbf3…` (24).

## Caveat, stated rather than buried

This measures MY seat on THIS machine with the current Claude Code build. The
`--help` text lists git status as a section the flag moves, so some
configuration must render it — possibly a different CLI version, or a repo
state that triggers it. What I can say is that across 2200+ captured requests
in three sessions it is absent, so on the setup we actually ship and run, the
flag has nothing to do.
