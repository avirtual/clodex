# t45 — make the strict-mcp-config fallback observable

Branch `mcp-visibility` off master `b66f618`. Baseline 2753 pass / ESCAPES: 0.
This is (b)'s small fix from the t44 decision document — **not** tier (b) itself.
**No MCP config file is read or parsed in this ticket.**

## The sentence that motivated it

clodex found what I had not named. The old hint text (`renderer/index.html:925`):

> *"When a session is routed through a strip-capable proxy, the proxy already
> removes just those tools and keeps your real MCPs — nothing to do here. This
> fallback is for unrouted sessions only…"*

Technically true, practically misleading: it rests entirely on **"strip-capable"**,
a distinction the user has no way to observe. My t44 paths 3 and 4 are both
**routed** sessions where strict gets pushed anyway. So a routed user reads
"nothing to do here" and in those two cases is wrong.

That framing changed what this ticket is. It is not a new feature — it is what
makes the **existing warning honest**.

## Part 1 — observability

### The shape: one function owns both the decision and the reason

`proxy-util.js` gains `strictMcpReason(proxyBase, probe)` (pure, no I/O — the
caller still owns the `probe()` call and its try/catch) plus
`STRICT_MCP_EXPLANATION`, a reason→remedy map.

**Why one function rather than a log line beside the existing check.** The old
code computed a boolean `wireStripsDesign` and branched on it. A log line added
next to that branch would be a *second* derivation of the same fact, free to
drift from the argv it claims to describe. With one function returning either
`null` (wire strips → no flag, no line) or the reason, **the log cannot disagree
with what actually happened** — same value drives both.

The three reasons, kept apart because their remedies differ:

| reason | when | remedy |
|---|---|---|
| `unrouted` | no `proxyBase` | none — this is the documented, expected case |
| `wire-no-strip` | routed, wire advertises no `claude_design` strip (too old, or a strip-off / kill-switch port) | deploy a newer wirescope, or use a stripping port |
| `probe-failed` | routed, `/_identity` did not answer as a recognized wirescope at the spawn instant | restart the session |

Collapsing these into one "strict was pushed" line would be **this ticket's own
bug one level up**: a true statement that leaves the user unable to act on it.

`probe-failed` also covers "something else is listening on that port", which
wants the same look — noted in the header comment rather than given a fourth
reason, since the remedy is identical.

### The call site

`session-manager.js` — the gate now reads:

```js
let probe = null;
if (proxyBase) {
  try { probe = await ProxyClient.probe(proxyBase); } catch {}
}
const reason = strictMcpReason(proxyBase, probe);
if (reason) {
  args.push('--strict-mcp-config');
  this._broadcast('ipc-message', { type: 'system', from: name, to: name, body: … });
}
```

**No change to WHEN the flag is pushed.** `strictMcpReason` returns non-null in
exactly the cases the old `wireStripsDesign` returned false:

| old | new |
|---|---|
| `proxyBase` falsy → never probed → `wireStripsDesign = false` → push | `!proxyBase` → `'unrouted'` → push |
| probe threw / returned null → `servers` undefined → false → push | `!probe` → `'probe-failed'` → push |
| `servers` not an array or lacks `claude_design` → false → push | same test → `'wire-no-strip'` → push |
| `servers` includes `claude_design` → true → no push | → `null` → no push |

The `Array.isArray(servers) && servers.includes('claude_design')` test moved
verbatim. Nothing else in the surrounding condition (`disableClaudeDesignMcp`,
the two `args.includes` guards) was touched.

**No log on the healthy path**, per the ticket: a line that fires on every
correctly-configured spawn trains people to scroll past it — and then the three
that mean something go unread along with it.

## Part 2 — hint text

Corrected in place, kept terse (the paragraph was already dense, and the ticket
asked for accurate-and-short over complete). The mechanism is not restated:

> *"A routed session is usually handled by the proxy, which removes just those
> tools and keeps your real MCPs. But it falls back if the proxy is too old to
> strip or is unreachable at spawn — so **routed is not a guarantee**. The
> fallback uses `--strict-mcp-config`, which is all-or-nothing: it disables
> **every** MCP server, including project/user ones. The IPC log says whenever
> it is used, and why."*

The last sentence is what ties the two parts together — the warning now points
at where the answer lives. `npm run build:web` re-run (`web-dist/index.html`
bundles the renderer).

## Tests — `test/strict-mcp-reason.test.js`, 6 tests

Windows, each stated separately from the revert proof:

1. **`unrouted`** — including that it is decided by the ABSENCE of a base and
   never by the probe, so a stale probe value cannot talk an unrouted session
   out of the flag.
2. **`wire-no-strip`** — four sub-cases: no `strip_mcp` at all (old wire), empty
   server set (kill-switch port), a set stripping something else, and malformed
   non-array `servers` (must not throw, must not read as a hit). The
   "stripping something else" case is the one that keeps a strip-off port from
   silently regressing to "we assumed routed meant handled".
3. **`probe-failed`** — both `null` and `undefined`, because the call site
   catches a throw into the same null as an unreachable probe.
4. **The reasons ↔ explanations agree** — every returnable reason has a
   non-empty explanation (a new reason without one would render as `undefined`
   in the log line), no explanation exists for a reason the function cannot
   return, and the three texts are distinct rather than three labels on one
   sentence.
5. **THE HEALTHY PATH IS SILENT** — the assertion clodex weighted most, and the
   one I'd defend hardest. Routed + a wire advertising `claude_design` →
   `null`, in any server order (membership, never position). It also pins that
   **`null` is the only falsy return**: the call site branches on `if (reason)`,
   so a reason that were ever `''` or `0` would take the healthy path while
   meaning the opposite.
6. **The call site uses it that way** — see the honesty note below.

### Test 6 is a WEAKER statement and I want that on the record

Tests 1-5 are a pure function. None of them proves `session-manager.js`
broadcasts only on a non-null reason. The Claude argv path inside `create()` is
**not drivable in this suite** — it spawns a real PTY, and the existing
`create()` tests only reach the early rejections and the bash path. So test 6
reads the SOURCE and pins the *shape* of the call site: both effects inside the
`if (reason)` block, and nothing emitting between the call and the guard.

That catches the regression that matters (a broadcast moved outside the guard,
or a second ungated one added) and would **not** catch a subtler logic change.
Saying so in the test's own comment rather than letting it read as a behavioural
guarantee.

### Revert proof — three reverts, all fail BY MESSAGE, none by crash

1. **Collapse the three reasons into one `'strict'`** → tests 1-3 fail, each
   reporting `actual: 'strict'` against its own expected reason.
2. **Healthy path returns `'wire-no-strip'` instead of `null`** (i.e. the log
   would fire on every healthy spawn) → test 5 fails, `actual: 'wire-no-strip',
   expected: null`.
3. **Move the broadcast outside the guard** → test 6 fails with
   `a broadcast sits between the reason and its guard — it would fire on the
   healthy path`. Verified as a named assertion, not a crash.

Restored and green after each.

## Constraint check

The ticket said: if I find myself changing the condition, stop and report. **I
did not.** The gate's condition is preserved exactly — see the four-row table
above. The only behavioural addition is the broadcast.

## Verification

`TOTALS: 2759 pass, 0 fail` / `ESCAPES: 0`, from the test-runner digest.
2753 → 2759 = +6. No existing test edited.

`npm run build:web` run — `renderer/index.html` changed.

`proxy-util.js` is **not** in `free-identifier-leaks.test.js`'s SCANNED_MODULES
and was not added: it is a pure dependency-free leaf that was never carved out
of main.js, so the forward scan could only catch it accidentally. Checked rather
than assumed.

## Progress

- [x] `strictMcpReason` + `STRICT_MCP_EXPLANATION` in proxy-util.js
- [x] call site rewired, condition provably unchanged
- [x] one IPC-log line per fallback, reason + remedy, none on the healthy path
- [x] hint text corrected, terse, `build:web` re-run
- [x] 6 tests; healthy-path window stated separately; 3 reverts by message
- [x] suite green at 2759, ESCAPES: 0
