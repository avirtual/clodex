# t381 — a swallowed injection, reproduced against the real CLI

Manual probes, like `scripts/hint-probe.js`: they drive the actual `claude`
binary under a real pty, so they are not part of `node --test` (they spawn a
CLI, take ~10s each to boot, and answer a vendor-behaviour question no fixture
can). Run them by hand when revisiting injection loss.

Every probe mirrors `inject-queue.js` `_drain` byte-for-byte:
`\x15` → 30ms → text → `settleMsFor(text)` → `\r`, with the Enter at exactly
`settleMsFor` and not a millisecond later. Each drops the inherited `CLAUDE_*`
environment (these run from inside a seat) while exempting `CLAUDE_CONFIG_DIR`,
which is how the modal arms select a fresh config. Each prints a derived
`FINDING`/`PASS` line — a conclusion that needs a human to re-read a 4000-char
tail is not re-runnable.

Measured against Claude Code **2.1.232**, 2026-08-14. The numbers below are
vendor-version-specific; re-measure before trusting them.

| probe | question it answers |
|---|---|
| `repro.py <control\|repaint>` | does a repaint mid-settle eat the text? |
| `modal-probe.py` | is mode-2004 on while a modal swallows input? |
| `echo-probe.py` | does a spec-sized bracketed paste echo verbatim? |
| `echo-signal.py [N]` | byte counts per state — is echo separable? |
| `bytes-probe.py` | the raw bytes per state, incl. a busy seat |
| `redeliver-probe.py` | does a retry land after a CHAINED modal? |
| `single-modal-probe.py` | does a retry land after a SINGLE modal? |

## What they established

**The repaint mechanism is falsified.** `repro.py repaint` forces a redraw
(SIGWINCH) inside the settle window. Positive control, without which the arm
would be indistinguishable from `control`: the resize→Enter window carries
**1857 bytes** (a full banner re-render) versus **131** for control's text echo
alone. The redraw demonstrably fired — and the text still submitted, 3/3. A
repaint alone does not discard injected text; the CLI redraws from its own
retained buffer.

**A non-composer state does swallow it, silently.** With the CLI in a modal, the
same byte sequence is swallowed whole: never echoed, never submitted, and the
trailing `\r` consumed as the modal's own keypress.

**Every signal Clodex has reads healthy while it happens.** Mode-2004 is ON in
both states (`[(0.24,'h')]` modal vs `[(0.26,'h')]` healthy), so
`_bootReadySeen` latches, `_pasteModeOn` is true, and the InjectQueue ready-gate
is no-op-true. This is why the loss is silent rather than merely undetected.

**Redelivery DOES rescue a single modal — this is the fix t381 shipped.**
`single-modal-probe.py` calibrates the onboarding chain, then replays it stopping
one modal short so exactly one modal is up. Result, 3/3: delivery 1 is swallowed
(not echoed, not answered), **delivery 2 lands and is answered**. That is the
operator's one-poke rescue of `clodex-reviewer-377-r1`, reproduced.
`redeliver-probe.py` shows the opposite for first-run onboarding only, because
its modals chain by construction — dismissing one reveals the next. **A chained
wizard is a boot-time shape and stays unrescued; the mid-session single modal is
the case that matters and it recovers.**

**Pre-Enter verification (shape b) remains unimplementable.** Bytes seen in the
settle window:

| arm | bytes |
|---|---|
| idle composer, no write (50ms / 1000ms) | 0 / 0 |
| healthy, short text | 70 |
| healthy, spec via bracketed paste | 144 |
| swallowed by modal (short and spec alike) | **0** |
| **busy seat mid-turn, no write** | **1140** (worst of 24 samples) |

Separable while idle, but content matching is unavailable for the payload that
matters: a spec renders as `[Pasted text #1 +16 lines]`, so its text never
reaches the screen. Mid-turn the signal is swamped outright by ordinary
streaming noise.

## What detection does and does not cover

A swallowed injection produces no turn, so the watchers that alarm on "no first
turn" catch it — but only where the lost text was what would have STARTED the
work. That boundary is worth stating precisely, because it is easy to read the
result above as "detection has this covered" and it does not.

`_armSpecConfirm` is armed at one site (`session-manager.js`, the ticket-spec
dispatch), for disposition `injected` and only while the seat is idle.
`_armReviewStartCheck` is armed at one site (reviewer spawn). There are 17
`_gatedDeliver` call sites; one arms a confirm watcher. The watchdog site passes
an `onWrite`, but it stamps `nudgedAt` — bookkeeping, not delivery confirmation.

Uncovered:

- **A plain dm** (the `[agent:dm]` intent path) has no watcher of any kind. A
  swallowed dm is gone silently. This is the fully exposed path, and a blind
  retry there is unsafe: there is no latch, so a delivery cannot be known to be
  unconsumed, and the content is arbitrary rather than contentless.
- **Ticket control traffic to a seat** — rejected, more-must-fixes, reassigned,
  cancelled — arms nothing. The ticket stays in flight, so the watchdog does
  eventually alarm, but on staleness: it reports a stalled seat and so
  misattributes the cause.
- **The done-report to the lead** is delivered and then the ticket closes;
  `ticketInFlight` (`tickets-store.js`) is false for a done ticket with no
  `loopStep`, so the watchdog cannot see it. Mitigated rather than covered —
  `ticket.report` is persisted to the board, so the report survives on disk and
  only the lead's notification is lost.

Narrowing all of this: `shouldHoldDm` takes `attention: needsAttention.kind`, so
a seat on a KNOWN permission dialog holds or parks instead of injecting. The
commonest mid-session non-composer state is avoided, not injected into.

What remains is a non-composer state Clodex does not know about — the state these
probes produce, where mode-2004 stays on and every signal reads healthy.
**Whether such a state arises mid-session is UNPROVEN.** It was reproduced at
boot/onboarding only. Do not cite this directory as evidence that it does.

## Caveat on scope

The modal these probes use is first-run onboarding, reached via a fresh
`CLAUDE_CONFIG_DIR`. That is *a* trigger for the swallow, not necessarily *the*
one that hit `clodex-reviewer-377-r1`, which had a normal config. A permission
dialog would be the better subject and was attempted; it is unreachable on a box
whose settings auto-approve (measured: both `echo` and `curl` ran with no
prompt). What is established is the failure CLASS, its silence, and that a single
redelivery recovers it; the specific trigger there remains unproven.
