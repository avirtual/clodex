# t465 — enforcing the `verifyHold.recovery` reader agreement

Written for someone with **zero context** who has the branch
`t465-the-four-reader-agreement-on-verifyhold` (@ `9e489cb`) and nothing else.
Four rework rounds of reasoning live here; the commit messages are the only
other record.

Everything below was **measured on the branch**, not reasoned about. Where I
say a shape passes or flags, I ran it.

---

## 1. The problem in one paragraph

t345 fixed a defect where several readers of one record field each formatted
their own sentence about it and drifted: the sweep alarm told the lead to close
a ticket again where re-closing could not terminate, while that arm's own
evidence two lines above said the opposite. The fix stamps a recovery **class**
(`hand` / `spec` / `infra`) on `verifyHold` and renders it through one table,
`HOLD_RECOVERY` + `holdRecoveryText` (`team-tickets.js:203-232`). Five source
call sites route through it. **Nothing structural stopped a sixth from
formatting its own sentence** — that is what t465 was filed to fix.

## 2. Q1/Q2/Q3, one line each

- **Q1 — can this be structural rather than a test?** No. Stamping *rendered
  text* instead of the class is ruled out because `_taskRespec` (`:6137`)
  branches on `recovery !== 'spec'` to pick a **route**, and rendered prose
  cannot be branched on. Making the field unreadable means wrapping every
  `ticketsStore.load` site — blast radius is the whole board. **So a test is
  the right tool, chosen deliberately, not by default.**
- **Q2 — how many readers?** 17 non-comment *lines*, 23 non-comment
  *occurrences* — the spec's conflicting "17" and "22" were the same tree
  counted two ways. Of the 17: 4 read `.recovery`, 6 are writes/deletes, 7 are
  presence/step reads. `holdRecoveryText` call sites in **source** = 5 (not 6;
  the 6th was in a test). **No reader that needed the helper lacked it** — the
  predicted present-tense defect did not exist.
- **Q3 — do `mergeError`/`mergeWaiting` generalise?** No. Both are
  **write-only** (`:1216-1217`, `:1244`): zero source reads outside their own
  stamp helpers, zero renderer reads. Many writers, no readers — no agreement
  to enforce.

## 3. The rule as it now stands

Implemented in `test/hold-recovery-single-source.test.js`, function
`scanHoldRecovery(src)`. **29 subjects.**

**Premise: both rules fire on the RENDER, never on the read.**

- **Rule A** — a `recovery` **class** that reaches prose must call the helper.
- **Rule B** — the **stamp**, or any field narrowed off it, reaching prose must
  call the helper.

They are one premise at two extraction depths.

**Binding classification** (pre-pass, because a binding may be rendered 150
lines from its declaration):

| kind | example | on render |
|---|---|---|
| PRESENCE | `!!ticket.verifyHold` | pass — carries no text |
| HELPER | `= …holdRecoveryText(…)` | pass — already rendered |
| STAMP | `= ticket.verifyHold`, or any field off it | **flag** |
| RECOVERY | `.recovery` under any name | **flag on render** |
| class-derived | a local **comparing** the class, or carrying a **literal** | **flag on render** |

**Three render shapes** are recognised — all three were needed, each found by a
distinct failure:
1. interpolation `${x}`
2. concatenation `` `…` + x `` ← **the historical sweep sentence is written
   this way**; missing it left an earlier fix half-done
3. prose selection `x ? 'a' : 'b'` ← the name never enters a template

**The one escape**: a `prescribes-nothing` marker in the contiguous comment run
**immediately above** the render. A subject **counts** them (exactly 1 today),
so a forged one fails the count rather than passing rule B. It must be directly
above — scoping it to the whole statement let one marker silently cover a
sibling ternary branch.

## 4. The measured map — what it catches, what it passes

**This is the section nobody else has.** All verified by running the scanner.

### Catches
- direct render of the stamp or a field (`${t.verifyHold.step}` + advice)
- whole-object alias (`const h = t.verifyHold` → `${h.step}`)
- narrowed fact (`const s = t.verifyHold.step` → advice)
- destructure, incl. rename (`const { recovery: cls }`)
- `let` / `var` as well as `const`
- class → sentence local → render (one hop)
- **destructured or bound** boolean selecting advice literals
- concatenated renders, not just interpolated

### Passes — **known holes, listed so they are not rediscovered**
1. **The dotted one-liner (level 5, still open):**
   ```js
   const isSpec = ticket.verifyHold.recovery === 'spec';
   reply(isSpec ? 'reject and refile' : 'close again');   // → []
   ```
   The bound and destructured forms of this **do** flag; the dotted form is a
   distinct shape the pre-pass does not reach. **This is a live defect.**
2. `switch (cls) { case 'spec': reply('reject'); … }`
3. `const M = { spec: 'reject', hand: 'close again' }; reply(M[cls])` — **this
   is `HOLD_RECOVERY`'s own shape**, so an author copying the correct construct
   into a local table writes the defect while imitating the fix. If a violation
   ever lands, look for a second table before a stray sentence.
4. two-hop prose (`b = a`), if/else-assigned advice, advice from a function call
5. alias-of-alias, nested destructure, stamp passed as an argument
6. presence boolean + unconditioned advice (deliberate: the stamp contributes
   no text, so nothing can drift from the record)
7. helper render with prose appended (deliberate: policing that is the brittle
   prose-matching rule rejected below)

None of 1–5 occurs in `team-tickets.js` today (checked: both `switch`
statements key on `intent.sub`; the only class-keyed table is `HOLD_RECOVERY`;
all five real advice sites call the helper inline).

## 5. What I would do instead — **invert the axis**

**Recommendation: replace the taint scan with a phrase scan. I prototyped it
and it wins on every axis I could measure.**

The current approach asks *"did a class-derived value reach prose?"* — that
requires following values through JS, which is dataflow analysis done with
regex. **Five rounds produced five levels of the same composition**, each patch
closing one instance and the shape reappearing one level up. The blind spot
**grows with every JS idiom**.

Inverting it asks *"does any canonical advice phrase appear outside
`HOLD_RECOVERY`?"* — derive n-grams from the table's own literals, scan the
rest of the file. **No taint tracking at all.** Measured on this branch:

| shape | taint scan | phrase scan |
|---|---|---|
| direct render | flag | **catch** |
| dotted boolean (hole #1) | **miss** | **catch** |
| destructured boolean | flag | **catch** |
| `switch` arm (hole #2) | **miss** | **catch** |
| object map (hole #3) | **miss** | **catch** |
| false positives on real file | 0 | **0** |
| paraphrase of the advice | flag | **miss** |

It is **indifferent to extraction depth** — all five levels collapse to one
shape, because it never asks how the value got there.

**Its blind spot is paraphrase, and that blind spot is CONSTANT** where the
taint scan's grows. It is also the *lesser* failure: the t345 defect was
**copied wording that later went stale** — a copy matches today's table, so the
phrase scan catches exactly the drift this ticket exists to prevent. A fresh
paraphrase is wrong immediately and visibly, not silently divergent.

Prototype (~15 lines) is in the r4 shell history; re-derivable from §5 of this
file. Exclude the `${ticketCloseVerb(id)}` fragment — it appears in 13
legitimate places.

**If you keep the taint scan**, close hole #1 first: it is a real defect, three
lines long, and its siblings already flag.

## 6. Things a fresh hand would otherwise re-derive

- **`:4618` (`re-verifying (was held at "${heldAt}")`) cannot be restructured.**
  Its step-naming is pinned by the accepted subject *"t345 r2: the re-entry
  reply still NAMES the check"* (`test/ticket-loop-verify.test.js:3661`), and
  routing it through `holdRecoveryText` would prescribe a recovery to the seat
  that **just performed it**. It is a receipt, not advice — hence the single
  audited `prescribes-nothing` marker.
- **`holdRecoveryText` is NOT exported** (`module.exports` at `:7582` carries
  `ticketCloseLine`, `ticketCloseVerb`, `ticketTaskDirLine`). A reader added in
  another file therefore *cannot* call it. A subject asserts `verifyHold`
  appears in **no non-test source file but `team-tickets.js`**, so that goes red
  when one lands and forces the export decision deliberately.
- **`_escalateTicket`'s `recovery` parameter** (`:5813`, rendered `:5831`)
  legitimately holds **helper output** — a mutant using the bare name
  `recovery` collides with it. Use a non-colliding name when falsifying.
- **The one-hop boundary is deliberate.** Arbitrary-depth prose taint needs
  dataflow; each hop bought by a regex costs false-positive surface on a rule
  whose entire value is that authors trust it.
- **Tracking must discriminate on what a local CARRIES.** Tracking any local
  whose statement *mentions* the class swept up
  `const id = recovery ? ticket.id : null` and made every later render of `id` a
  violation — **45 on the real file**. Comparison-against-class = advice-shaped;
  a field off another object = data.
- **Two folded nit fixes are in `team-tickets.js` and are accepted:** the
  re-entry broadcast reads `re-verifying` (not a second `done`), and the
  done-at-verify bounce says *"its checks have not reported yet … (or the
  watchdog's stall alarm)"* — hedged because a process dying mid-verify leaves
  the identical state (`:4569-4572`), so asserting a live check would tell that
  seat to wait for a result never coming.
- **Not taken, by the lead's recorded decision:** the `done` + `review` bounce
  has the same wording gap one step later; out of scope for the mechanism.

## 7. Verification state at `9e489cb`

- Suite **6249 total**, matching prediction exactly (6216 baseline + 33).
- The one red in the last digest — `term-exec-keymap.test.js:184`,
  *"bash in emacs mode…"*, `exec accepted: busy` — is **an unrelated real-PTY
  timing flake**: that file is not in this branch's diff and re-runs 9/9 green.
- Syntax OK; branch is 10 commits, clean, **not pushed, not merged**.
- Environment-gated subjects (`skip: !gitAvailable()`, the `node_modules/electron`
  one) change the reported green **total** with nothing failing — a count
  reconciliation can look wrong on a healthy tree.

## 8. The methodological finding

The same composition recurred **five times**: alias defeats a line-local rule →
narrowing defeats an object-only rule → binding defeats a token-based rule →
a type carve-out defeats a use-based rule → a dotted form defeats the binding
pre-pass. Twice the new hole was **inside the exemption written in the same
commit that fixed the previous one**.

Two rules earned the hard way:

1. **Exemptions are where the next defect lives** — not blind spots. Every
   exemption needs an adversarial case **before it ships**; stating the lesson
   does not prevent repeating it, running it does.
2. **When a rule keeps missing one level up, the premise is wrong, not the
   pattern.** Adding an arm moves where authors land. What broke the cycle in
   r3 was fixing a premise (fire on the render, not the read) — and the reason
   it worked is that the false positive and the blind spot were **one defect**:
   the rule punished correct usage, so the quietest escape was the shape it
   could not see.
