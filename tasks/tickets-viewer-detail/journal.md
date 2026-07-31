# t121 — tickets-viewer: show the ticket spec in the board

Scope: the spec body only. Reading `journal.md` off `taskDir` is a separate
ticket and nothing here reaches into the team root.

## Engine

`shape()` carries `spec: str(t.spec)` alongside every other string field —
one line, same treatment. Deliberately UNCAPPED: a JS-side length limit drops
the tail of a spec with nothing on screen to say so, and the reader cannot
tell a short spec from a truncated one. The display limit is a `max-height` in
CSS, where the rest of the body is a scroll away rather than gone.

Carried inline on the existing board payload rather than a second on-demand
IPC method. The open board is ~22 rows and the closed list is already capped,
so the payload cost is trivial — and the renderer already runs a
`selectSeq`/`reloadSeq` token dance because async results land out of order.
A per-row fetch would add a third race for nothing.

## Renderer

The row's HEAD is the click target; the body is built lazily on first expand
and removed on the second click, so a collapsed board allocates no spec nodes
at all. Collapsed by default because scan-density is this board's strength —
twenty-two rows each opening with a couple of KB of spec is a different,
worse surface.

The body goes through `el()`, i.e. `textContent`. Spec bodies are
agent-authored and are the strongest untrusted-input case on this surface;
markup in one renders as the characters it is. `<pre class="tv-spec">` with
`white-space: pre-wrap` preserves the blank lines and list indentation specs
carry meaning in.

An empty spec renders `no spec recorded for this ticket` in `.tv-no-spec`,
following the rule the artifact path already follows: a blank body reads as a
rendering gap, and "there is nothing recorded" is the actionable half.

## Tests, red-first

Four new cases (engine 26→27, renderer 18→21), all four failing BY MESSAGE
against the unmodified product before a line of it was written.

The renderer's vacuity trap, stated in the spec and real: asserting the spec
text appears is satisfied by an `innerHTML` implementation too. The fake DOM
had `set innerHTML` as a bare `children.length = 0`, so an innerHTML mutant
would have passed a text assertion AND left `querySelector('img')` null — the
harness could not distinguish its two outcomes. Fixed by modelling a
NON-EMPTY innerHTML assignment as what a browser does with it (markup becomes
child elements) while an empty one stays a plain clear, which is how the
renderer wipes a pane. `querySelector` (bare tag selectors only) and
`removeChild` added for the same reason.

Mutation-proved, seven mutants, all reddening; product restored
byte-identical after each (`diff` against pristine copies).

| # | mutant | result |
|---|---|---|
| M-1 | engine drops `spec` (revert) | 1 fail |
| M-2 | engine truncates at 200 chars (**wrong-fix**) | 1 fail |
| M-3 | renderer uses `innerHTML` for the body (**wrong-fix**) | 1 fail — the `querySelector('img')` half |
| M-4 | spec expanded by default | 3 fail |
| M-5 | toggle only opens, never closes | 1 fail |
| M-6 | empty spec renders a blank body | 1 fail |
| M-7 | click listener never wired (revert) | 3 fail |

## t123 — cold review applied (ACCEPT, no must-fixes)

Seven nits taken, one refused by the lead, one left as documentation.

1. **Whitespace-only spec** (`renderer.js`) — `t.spec ?` is truthy for `"\n\n"`,
   so the guard skipped the `.tv-no-spec` branch and opened a blank `<pre>`:
   the rendering gap that branch exists to prevent. Now `t.spec && t.spec.trim()`
   — tested TRIMMED, rendered WHOLE, so nothing is dropped.
2. **Affordance** (`style.css`) — `.tv-ticket-head` gets `.tv-team-row`'s
   `cursor: pointer` + hover background. It carried a toggle discoverable only
   through a tooltip that takes a second to appear.
3. **Ellipsized title** (`renderer.js`) — `head.title` is the click hint, so a
   long title had lost its only route back. `titleSpan.title = t.title` as well;
   the nearer element wins, the same treatment `art.title` already had.
4. **`innerHTML = ''` now clears `_text`** (harness) — didn't bite today, but a
   pane the renderer wiped would have kept reporting content through `textOf`.
   The false-green direction.
6. **`/tv-spec/` matched `tv-no-spec` too** — anchored. Note that anchoring
   ALONE is not enough here: `classesOf` splits className into tokens, so the
   no-spec branch contributes both names and an anchored `/tv-spec/` still
   matches it. The added `doesNotMatch(/tv-no-spec/)` is what separates the
   branches, and M-10 below is the proof.
8. Comment at the spec branch trimmed to the cap half; it repeated `el()`'s own.
9. **`removeChild` throws on a non-child**, as the real DOM does.

**Nit 5 refused by the lead** (stripping tags from `_text` for browser parity).
The harness comment now says the raw string is deliberate and names the three
`doesNotMatch` assertions that stay sensitive because of it, so the next reader
does not "fix" it.

Nit 7 left as-is: documentation value, no churn.

Three more mutants, all reddening, renderer restored identical after each:

| # | mutant | result |
|---|---|---|
| M-8 | whitespace guard reverted to bare truthiness | 1 fail |
| M-9 | title span loses its own `title` | 1 fail |
| M-10 | spec body rendered with the no-spec class | 1 fail |
