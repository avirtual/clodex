# t381 — a swallowed injection, reproduced against the real CLI

Manual probes, like `scripts/hint-probe.js`: they drive the actual `claude`
binary under a real pty, so they are not part of `node --test` (they spawn a
CLI, take ~10s each to boot, and answer a vendor-behaviour question no fixture
can). Run them by hand when revisiting injection loss.

Every probe mirrors `inject-queue.js` `_drain` byte-for-byte:
`\x15` → 30ms → text → `settleMsFor(text)` → `\r`. A harness that skipped the
Ctrl-U settle gap would measure a different mechanism.

Measured against Claude Code **2.1.232**, 2026-08-14. The numbers below are
vendor-version-specific; re-measure before trusting them.

| probe | question it answers |
|---|---|
| `repro.py <control\|repaint>` | does a forced repaint mid-settle eat the text? |
| `modal-probe.py` | is mode-2004 on while a modal swallows input? |
| `echo-probe.py` | does a spec-sized bracketed paste echo verbatim? |
| `echo-signal.py [N]` | byte counts per state — is echo separable? |
| `bytes-probe.py` | the raw bytes per state, incl. a busy seat |
| `redeliver-probe.py` | does a second delivery land after one is swallowed? |

## What they established

**The repaint mechanism is falsified.** `repro.py repaint` forces a redraw
(SIGWINCH) between the text write and the Enter. The text survives and submits —
the CLI redraws from its own retained buffer. A repaint alone does not discard
injected text.

**A non-composer state does swallow it, silently.** With the CLI sitting in a
modal, the same byte sequence is swallowed whole: never echoed, never submitted,
and the trailing `\r` is consumed as the modal's own keypress.

**Every signal Clodex has reads healthy while it happens.** Mode-2004 is ON in
both states (`[(0.24,'h')]` modal vs `[(0.26,'h')]` healthy), so `_bootReadySeen`
latches, `_pasteModeOn` is true, and the InjectQueue ready-gate is no-op-true.
This is why the loss is silent rather than merely undetected.

**Pre-Enter verification (shape b) is not safely implementable.** Bytes seen in
the settle window:

| arm | bytes |
|---|---|
| idle composer, no write (50ms / 1000ms) | 0 / 0 |
| healthy, short text | 69 |
| healthy, spec via bracketed paste | 145 |
| swallowed by modal (short and spec alike) | 4 |
| **busy seat mid-turn, no write** | **1481** |

Separable while idle, but the discriminator would be a 4-vs-69 byte threshold
over an undocumented vendor redraw, and content matching is unavailable for the
payload that matters: a spec renders as `[Pasted text #1 +16 lines]`, so its text
never appears on screen at all. Mid-turn the signal is swamped outright.

**Redelivery (shape a) does not rescue this failure.** `redeliver-probe.py`
sends the same nudge twice; the second is swallowed too, because dismissing one
modal reveals the next. Redelivery answers "the Enter was eaten", not "the CLI
is not accepting input".

## Caveat on scope

The modal these probes use is first-run onboarding, reached via a fresh
`CLAUDE_CONFIG_DIR`. That is *a* trigger for the swallow, not necessarily *the*
one that hit `clodex-reviewer-377-r1`, which had a normal config. What is
established is the failure CLASS and its silence; the specific trigger there
remains unproven.
