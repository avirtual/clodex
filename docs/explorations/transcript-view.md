# Exploration: a transcript-driven session view

Ticket t1121 · base master 93b5ecae · 2026-09-24 · design only, no code.

## Outcome

**Build a spike first.** The split can be done without resizing the PTY and
without lying to the CLI. The xterm keeps the whole tab at its true size, as it
does today. Clodex paints its own conversation pane over the top part of the
tab. The bottom of the tab is a clipped window onto the xterm's rows, starting
at the composer. One screen fact carries the whole design: the composer's
full-width `─` rule, with the `❯` composer row directly below it. When that pair
is on screen, the pane shows. When it is not (a permission dialog, `/help`,
`/model`, the trust prompt, Ctrl-O's detail view, the alternate screen), the tab
drops back to today's full terminal. That fallback is instant and loses nothing,
because the xterm was never altered.

**The one fact that would flip it:** whether the rule-plus-`❯` anchor is present
and unambiguous in every state where the operator only needs the composer. The
spike's fixture matrix has to establish that on a real CLI. If there is a state
where the anchor matches but hides something the operator must see, such as a
dialog drawn under a composer-like rule, do not build. Every other gap in this
document costs fidelity, not safety.

**Split in two sentences.** A Clodex-rendered pane sits above and shows the
conversation from the Claude transcript, one row per tool call, expandable.
Below it is a strip showing the live xterm from the composer's top rule to the
last painted row, which covers the composer, footer, status line and any slash
menu. The strip grows on its own when a menu opens, and the whole tab returns to
the raw terminal whenever the composer anchor is missing.

**First ticket:** *"Split proof: composer-anchored live strip over a crude
transcript pane (Claude seats, desktop, behind a toggle)"*. Details are in §8.

**Compared with the mirror approach (ticket explore-screen-mirror).** The
transcript view gains more density, because it can collapse a tool call to one
row and the mirror can only re-show the CLI's own layout. It has more fidelity
risk: §1 lists what the pane cannot know, chiefly the spinner, retry banners,
queued prompts and prose while it streams. It is bigger, about 1.7k source lines
against what I expect is a much smaller mirror. It depends on less screen
wording: one anchor, which voice-submit and the inject gate already depend on,
plus the transcript JSON schema. More in §9.

## Evidence base

- Code read: `jsonl-watcher.js`, `renderer/renderer.js` (createSession's
  terminal block), `renderer/intent-highlight.js`, `renderer/lib/prompt-echo.js`,
  `renderer/voice-submit-watcher.js` + `renderer/lib/voice-submit.js` (composer
  rules), the `inject-queue.js` header, `docs/sessions.md` §3,
  `docs/renderer-events.md`. Also, because the question forced it:
  `wire-intents.js` (TranscriptSentinel), `wire/proxy.js` and `wire/sse.js`
  (what the tee emits), `renderer/console-tab.js` (existing DOM tool-block
  prior art), and `claude-env.js` (env scrub).
- **Live probe**, throwaway and not committed. I ran the stock `claude` 2.1.281
  (`--model haiku`) on a Python pty at 100×30, fed the bytes to `pyte`, and
  snapshotted the screen every 400ms through: idle, `/` menu, Esc, a Bash turn
  with a 150-word reply, Ctrl-O on and off, `/help`, and an unknown command. I
  diffed the snapshots against the transcript that session wrote. Findings are
  cited as **[probe]**.
- Not observed: a permission dialog. The probe's config auto-approved `touch`,
  so the spike must capture one.

Probe facts the design relies on:

1. **The default renderer is normal-buffer and cursor-relative.** Across 45KB of
   output there was no `?1049h` (alternate screen), no `?2026h` (synchronized
   output), no mouse tracking (`?1000h`/`?1006h`) and no `2J`/`3J`. The CLI
   repaints with CUU/CUD/CHA (`\e[nA`, `\e[nB`, `\e[nG`), relative to where it
   parks the cursor, which is the composer row. Committed output scrolls into
   xterm scrollback like any printed text. [probe]
2. **Composer shape:**
   ```
   ──────────────── (full width, U+2500)
   ❯ <draft>
   ──────────────── (full width)
     <model> <ctx%>        <right-aligned notices>
     ⏸ manual mode on · ← for agents     (mode/bypass footer)
   ```
   While working, the spinner row (`✻ Thinking… (2s · ↓ 126 tokens)`) and the
   in-flight block sit above the top rule. The composer and its rules stay put.
   [probe]
3. **The slash menu renders below the composer**, replacing the footer. At 30
   rows it took 15 rows, from the row under the bottom rule down. The `❯ /` row
   and the top rule remain. [probe]
4. **`/help` replaces the composer.** A rule is followed by a tabbed panel and
   there is no `❯` row. Afterwards the CLI redraws the whole screen, and the
   header logo is repainted. [probe]
5. **The trust dialog uses `❯` as a selection marker** (`❯ No, exit`) under a
   rule, but the rule and the `❯` row are separated by content. So `❯` alone is
   not a composer. The adjacency is what identifies it. [probe]
6. **Ctrl-O replaces the composer** with `Showing detailed transcript · ctrl+o
   to toggle · ctrl+e to show all` and re-prints the transcript in the normal
   buffer. There is no `❯` row. [probe]
7. **The transcript is written per content block, at block completion.** In the
   150-word turn, the thinking block landed 1.4s after submit, and thinking text
   was already streaming on screen by then. `tool_use` landed 0.5s later and
   `tool_result` 0.2s after that. The reply text block landed at 35.87s, while
   the screen had been streaming it since about 29.2s: **about 6.7s of prose was
   visible on screen before any of it existed in the jsonl.** [probe]
8. **The CLI 2.1.281 screen already collapses some tools.** A read-only `ls`
   rendered as `Thought for 7s, listed 1 directory (ctrl+o to expand)`. A
   `touch` rendered as `⏺ Bash(touch …)` / `⎿ Done`. So the density problem is
   concentrated in Bash output and Edit diffs, not in reads. [probe]
9. **Transcript records seen** in one short session: `user` (prompt text, or
   `tool_result` blocks), `assistant` (one record per content block: `thinking` /
   `tool_use` / `text`), `attachment` (environment, model, skill listing, full
   `prompt_snapshot`; most of the file by bytes), `system` subtypes
   `turn_duration`, `local_command` (`<command-name>/help…` and
   `<local-command-stdout>Help dialog dismissed…`), `informational` (`Unknown
   command: /todos`, level `warning`), plus `mode` / `permission-mode` /
   `last-prompt` / `ai-title` / `file-history-snapshot` bookkeeping. A trivial
   two-turn session was 200KB. [probe]
10. **Transcript saving can be off.** Launched with an inherited
    `CLAUDE_CODE_CHILD_SESSION`, the CLI shows `⚠ Transcript saving is off` in
    the footer and writes nothing. `claude-env.js` scrubs `CLAUDE*` for seats,
    so Clodex seats are safe from that cause, but a user setting can produce the
    same state. [probe]

One code fact reframes the ticket: **JsonlWatcher is not the feed to build on.**
Per `docs/sessions.md` §3 it is the fallback path. Wire-registered Claude seats
run a `TranscriptSentinel` with no steady-state parsing. JsonlWatcher also keeps
only assistant text, deliberately starts at EOF, and groups by requestId for
intent scanning. The pane needs the opposite on every count: every record kind,
from the start of the file, paired tool_use/tool_result. So it needs its own
reader (§8, `transcript-feed.js`). It can share the symlink
(`pathFor(REGISTRY_DIR, name, 'transcript')`) and the repoint semantics, but not
the class.

---

## 1. What the screen shows that the transcript does not

Verdict key: **Live** = must stay visible from the real screen. **Recon** =
reconstructible from the transcript or from signals Clodex already has. **Drop**
= not needed in split mode.

| Screen element | In transcript? | Verdict | Where it lands in this design |
|---|---|---|---|
| Composer + draft | no | **Live** | the strip (anchor) |
| Footer: model, ctx %, notices, mode / **bypass-permissions** line | no | **Live** | the strip; it is below the composer, so it comes along for free |
| Slash menu + completion popup, `@` file completion | no | **Live** | the strip; it renders below the composer, and the strip grows to hold it |
| Permission dialog | no (the decision shows up only as a later tool_result or denial) | **Live** | full terminal; the composer anchor is absent |
| `/help`, `/model`, `/config`, the trust prompt, any panel | invocation + stdout via `system/local_command` | **Live** while open, **Recon** after | full terminal while open; the pane shows the `local_command` row afterwards |
| Spinner / "Thinking… (Ns · ↓ N tokens)" / "esc to interrupt" | no | **Recon** | the pane footer shows Clodex's own working line: activity state (`session-activity`) + elapsed; token count from the wire later. Esc still works, since keys always go to the PTY |
| Collapsed "Thought for Ns" rows | yes (`thinking` blocks, full text) | **Recon** | the pane, collapsed by default |
| `/compact` progress | no | **Live-ish** | the spinner area is hidden, but the working line covers it; the result is **Recon** (compact boundary + `isCompactSummary` record → a "compacted" block with the summary expandable) |
| `/clear` | new transcript (symlink repoints), new sessionId | **Recon** | a divider in the pane |
| Todo widget (ctrl+t) | yes, as the latest TodoWrite / task-tool `tool_use` input | **Recon** | a pinned "tasks" block in the pane footer (v2; drop in v1) |
| Background-task notices | partly (notification attachments / user records) | **Recon, partial** | a pane row where a record exists; otherwise lost (v1 accepts that) |
| Queued prompts (typed while busy, shown above the composer) | not until submitted | **Gap** | hidden in split mode. The operator typed it, so he knows. Listed as a known gap |
| API retry banner ("Retrying in Ns… attempt k/10") | no; the terminal error lands as an assistant record flagged as an API error | **Gap** in v1 | hidden; the wire sees the 529/overload responses and could feed a pane row later |
| Hook error / hook output lines | partly (attachments / system records) | **Recon, partial** | render what is recorded; the rest is a gap |
| In-flight prose while streaming | not until the block completes (fact 7) | **Gap** in v1, **Recon** with a wire feed (§4) | pane placeholder "writing…"; peek key (§3) |
| Ctrl-O detailed transcript | the same data, fully | **Drop** | Ctrl-O is intercepted in split mode and toggles the pane's expand-all (§5) |
| Welcome logo/header | no | **Drop** | — |
| Terminal title (OSC 0, spinner glyph + ai-title) | `ai-title` record | **Drop** / **Recon** | the tab already has its own name and activity dot |
| User prompt echo | yes (`user` text) | **Recon** | pane row; Clodex-injected `[agent:from …]` deliveries can render compactly (a density win of its own) |
| Unknown-command and other warnings | `system/informational` | **Recon** | pane row |
| Subagent (Task) progress rows | sidechain files `…/subagents/*.jsonl` | **Recon** | the parent's pane shows the Task call collapsed; live detail stays in the Activity tab |

The list has one structural property: **everything essential is at or below the
composer, or replaces it.** Everything above the composer is either in the
transcript already or is a status line Clodex can re-derive. That property is
why the split works. It has been true of every screen state observed, but it is
a property of the current CLI and nothing guarantees it (§7).

## 2. What the transcript carries that the screen truncates

- **Full tool output.** The `tool_result` content, where the screen shows `… +N
  lines (ctrl+o to expand)`. It is capped only by the CLI's own result cap.
- **Full tool inputs.** The whole Bash command and its `description`, Edit
  `old_string`/`new_string`, full Write content, Grep/Glob patterns, Task
  prompts. The user record's `toolUseResult` side-car, where present, holds
  structured results (for Edit, the patch), which is enough for a real diff
  without re-reading files.
- **Full thinking**, when the model emits it in plaintext. Haiku did in the
  probe. Redacted/signature-only thinking renders as "thought (redacted)".
- **Timing and cost.** A timestamp on every record gives per-step durations,
  `turn_duration` gives whole-turn time, and `message.usage` gives per-response
  tokens.

**Default (collapsed) rendering, one row each:**

```
› Use the Bash tool to run exactly: ls -la /usr/bin | head -40 …   (user, 1–2 rows)
  ◦ thought 1.4s                                                   (click → full thinking)
  $ ls -la /usr/bin | head -40          41 lines · 0.2s            (click → full output)
  ✎ src/foo.js  +12 −3                                             (click → diff)
  ▤ read 3 files · grep "createSession" 14 hits                    (consecutive read-only calls grouped)
  Pipes in Unix/Linux are a fundamental concept …                  (assistant text, full, markdown-lite)
  ── 8s · 1.2k tokens ──                                           (turn_duration footer)
```

**Expanded (per block, or all via Ctrl-O):** full thinking, full output in a
monospace block (ANSI stripped with the `stripAnsi` rule `bash-console.js`
already has), a unified diff for edits, and full JSON input for unknown tools.
File paths in inputs are links that open Clodex's file viewer, which the screen
cannot offer.

Measured screen cost for comparison: a Bash call with output takes 3–6 rows (the
ticket's figure). The probe's `touch` took 2 rows plus a blank. Assistant prose
costs the same in both views; the gain is in tool traffic only. The spike must
measure rows-per-turn on a real working seat before anyone claims a factor.

## 3. The split

### Layout

```
┌───────────────────────────── tab ─────────────────────────────┐
│ transcript pane (Clodex DOM, scrolls itself)                  │  flex: 1
│   …                                                           │
│   [working · 12s]  ← Clodex working line                      │
├───────────────────────────────────────────────────────────────┤
│ live strip: overflow hidden, height = H rows                  │  height: H*rowPx
│   the SAME full-size xterm, translated up so that its row R   │
│   (the composer's top rule) is at the strip's top edge        │
└───────────────────────────────────────────────────────────────┘
```

- **The xterm is not resized, and neither is the PTY.** `fitAddon` keeps fitting
  the xterm to the whole tab, as it does today, and the PTY gets those true
  dimensions. The strip is a clipping window: the terminal element sits inside
  it with `transform: translateY(-R * rowPx)`. This meets the "never lie about
  size" constraint by construction. The CLI renders for exactly the screen it
  was told about, and the pane covers the part of it that is transcript.
- Why translate rather than overlay the pane on top of the xterm: on a fresh
  seat the composer sits near the top of the screen with blank rows below (fact
  2, rows 5–9 of 30). An overlay would leave a pane of 5 rows and 20 blank rows
  under the composer. Translating keeps the strip docked at the bottom whatever
  row the CLI is on.
- `getBoundingClientRect` includes transforms, so xterm's mouse-to-cell mapping,
  selection and the IME helper textarea follow the translation. The spike must
  confirm this with WebGL on.
- **The xterm viewport is pinned to the bottom** (`scrollToBottom` on any
  `onScroll` while split). If the operator scrolls the xterm's own scrollback,
  translated rows stop meaning "the screen".

### How H is chosen: measured, never fixed

A fixed row count cannot work: the slash menu needs about 15 rows, the idle
composer 5, and the footer's height varies (bypass line, notices). The
measurement runs on the normal buffer's visible screen, rows `baseY … baseY +
rows - 1`, on every `onWriteParsed`:

1. `buf.type !== 'normal'` → **FULL**. Same decline as intent-highlight and
   voice-submit-watcher.
2. Scan upward from the cursor row, then downward if nothing is found above, for
   the nearest **anchor**: a row that is a full-width U+2500 rule (at least
   `cols - 1` cells) **immediately followed** by a row the existing composer
   rules accept. Reuse `composerIsEmpty` / `composerHasDraft` from
   `renderer/lib/voice-submit.js`, which match `❯` + U+00A0 and were measured
   live. Do not write a second copy of them.
3. No anchor → **FULL**.
4. Anchor at row R → `top = R`, `bottom =` last non-blank row on screen (at
   least the cursor row). `H = bottom - top + 1`.
5. **Hysteresis:** grow immediately; shrink only after the new smaller H has
   held for 250ms. Split→FULL is immediate; FULL→split needs the anchor held
   for 250ms. This keeps a repaint mid-frame (the CLI erases and redraws rows)
   from flickering the layout.

The adjacency requirement is what stops fact 5's trust dialog (`❯ No, exit`
several rows below its rule) and a prompt echo in scrollback (`❯ Use the…` with
a blank row above it) from reading as the composer.

**Why not use the cursor-up excursion (a structural, wording-free signal)?** It
is tempting. xterm's `parser.registerCsiHandler({final:'A'})` can record how far
up the CLI moves the cursor per frame. That is the top of the region it still
repaints, and it was 7–11 rows mid-turn and 17 at commit [probe]. It includes
the in-flight message, so it could size a "show live streaming" strip. It is
noisy, though: the full redraw after `/help` repainted from the top. It also
answers a different question, what the CLI is still editing, rather than what
the operator needs. Keep it as the spike's second measurement and as the
candidate guard for a future "dialog without FULL" mode. v1 uses the anchor.

### What happens when a menu or dialog needs more rows

- **Slash menu, `@` completion:** the composer is still anchored and the menu
  paints below it, so H grows and the pane shrinks. There is no mode switch.
- **Permission dialog, `/help`-style panels, trust prompt, Ctrl-O detail:** the
  anchor disappears, so the tab goes **FULL**, which is exactly today's view.
  Dialogs are brief, and showing them in full is the zero-risk choice: nothing a
  dialog draws above its own options can be hidden. The cost is a layout jump
  per permission prompt. On a seat running in manual mode with many prompts that
  could be jarring, so the spike should measure it. Clodex already raises
  `session-attention` from the Notification hook on permission prompts, a
  wording-free corroboration that FULL is right.

### State machine

```
            transcript unreadable / Codex / peer / web / toggle off
   ┌────────────────────────────────────────────────────────────┐
   ▼                                                            │
 RAW ── toggle on + transcript readable ──► FULL ◄──────────────┘
                                             │  ▲
                 anchor found, held 250ms    │  │ anchor lost (immediate)
                                             ▼  │ alt buffer active
                                          SPLIT ─┘ Ctrl-O passthrough
                                          ├─ idle      (activity idle; pane footer blank)
                                          ├─ working   (activity thinking; pane shows working line
                                          │             + "writing…" placeholder after N s with no new block)
                                          └─ menu      (H > idle H; pane shrinks; not a separate mode,
                                                        just a larger H with grow-now/shrink-late)
 PEEK: while held (Option key down, or hover on the working line) SPLIT renders as FULL.
```

`RAW` and `FULL` render identically. They differ only in whether the
measurement runs. The **alternate screen** never occurs with the default
renderer (fact 1). The CLI's opt-in fullscreen renderer (`/tui fullscreen`, see
voice-submit-watcher's note) puts everything on the alternate buffer, and the
seat then stays FULL. That is the correct and only v1 behaviour.

## 4. Latency and ordering

Measured [probe]: thinking, tool_use and tool_result blocks reach the jsonl
within about 0.2–1.5s of appearing on screen. Tool calls are short blocks.
**Prose is the problem**: the 150-word reply streamed on screen for about 6.7s
before its record existed. The 250ms poll and the 1s flush are
JsonlWatcher-specific. A new reader using `fs.watch` plus a 250ms poll backstop
adds at most one tick, so the delay is the CLI's per-block write, not Clodex's.

**Proposal:** the pane is shown during streaming too. Do not swap to the live
screen while the model writes. Tool-heavy stretches are where density matters,
and those land promptly. Swapping to FULL every time the model writes prose
would bring the 3–6-row blocks back exactly when they pile up. During a text
block the pane shows a `writing… 4s` placeholder at the tail, and **peek**
(hold Option) shows the real screen for anyone who wants to watch tokens. I
expect the operator to prefer this: turns are read when they finish, and a
dense, stable pane beats a live but cluttered one. That is a judgement the
spike should test with Bogdan on a real seat. If it is wrong, there is a
cheap alternative mode: grow the strip to the cursor-up excursion top while
`working`, which shows the in-flight block live.

**What the wire could feed (not designed here).** The wire proxy already tees
every Claude response's SSE and parses `content_block_delta` in
`wire/sse.js`. `text_delta` and `thinking_delta` are pulled out there for
intents and receipts, and `input_json_delta` goes to the file-touch collector.
It emits only `stream-start` / `stream-end` / `turn.completed` today, but
publishing throttled per-agent deltas (main-line role only, the same filter
`turn.completed` uses) would give the pane streaming text **earlier than the
screen**, since the CLI renders from the same stream after its own buffering.
The pane would render the in-flight block from deltas and replace it with the
transcript record when the block lands, keyed by the message id and block
index. That also makes the peek key mostly unnecessary. It only works for
wire-registered seats. A seat off the wire keeps the placeholder.

## 5. Interaction parity

| Concern | Design |
|---|---|
| **Keyboard focus** | Every key goes to the PTY, as today. The pane is not focusable (`tabindex=-1`, no inputs). Clicking the pane to select text moves focus to the body. A document-level keydown in split mode then calls `terminal.focus()`, and for anything but Cmd+C / Cmd+A / Cmd+F re-feeds the key with `terminal.input(data, true)` (xterm 5.5 API, fires `onData` so the peer/voice paths in createSession still see it). Result: the first keystroke after a pane click is not lost. The spike must verify dead keys, IME and Enter. |
| **Selection + copy** | Two independent selections: DOM selection in the pane, xterm selection in the strip. Selecting across both is not supported, and nothing needs it (the strip is the composer). Cmd+C copies whichever selection is non-empty, pane first. "Copy block" on an expanded block copies its raw text (full output / full input). |
| **Cmd+F** | `term-search.js` drives the xterm SearchAddon today. In SPLIT it searches the **pane** instead, with the CSS Custom Highlight API over pane text nodes (no DOM mutation, Chromium ≥105). Matches inside collapsed blocks auto-expand them. A "search raw terminal" affordance flips the tab to RAW and runs the old path. Factor term-search around a small `{find, next, prev, clear}` target so both back ends plug in. |
| **Scrollback** | The pane is the scrollback: its own `overflow:auto`, with auto-follow at the bottom that stops when the operator scrolls up (console-tab's `following` idiom). The xterm's scrollback keeps accumulating hidden and is exactly what RAW shows. |
| **Mouse wheel** | Over the pane, it scrolls the pane. Over the strip, it is swallowed in split mode: the CLI's default renderer requests no mouse tracking [probe], so a wheel there would only scroll the xterm viewport, which must stay pinned. If a future CLI enables mouse tracking, pass the wheel through to it. |
| **File paths** | Rendered as links from structured tool inputs (`file_path`, `path`), not screen-scraped. A click opens the same viewer `[agent:file view]` uses. Strictly better than today. |
| **Ctrl-O / Ctrl-E** | Intercepted in SPLIT through xterm's `attachCustomKeyEventHandler` and never sent: they toggle expand-all in the pane. If one reaches the CLI anyway (peek, RAW), its detail view drops the anchor and the tab goes FULL, which is correct. |
| **Intent highlights** | intent-highlight keeps decorating the xterm, which is now hidden. The pane should mark `[agent:…]` lines in assistant text itself, reusing `lib/intent-marks.js` `classifyRows` on the text rows so both views agree on what counts. |
| **Prompt-echo rewrite, voice-submit, inject gating** | Untouched. They all read or rewrite the xterm, which is still complete and at true size. This is the main dividend of not resizing. |

## 6. Peer and web parity

Peer-mirrored tabs receive `peer-data` PTY bytes (peers-ui.js). The web host
serves `pty-data` through `web-host.js` with a replay ring. Neither carries the
transcript. Serving it needs a new `api-contract` invoke (a cursor pull, like
`console-tab`'s) for the web host, and a peer-wire endpoint on the serving box,
because the transcript lives on that box's disk.

**Ship desktop-only first, explicitly.** In v1, peer tabs and every web-host tab
are RAW: they show the terminal as today, with no toggle offered. Nothing
breaks there, because the split is purely renderer-side over an unchanged byte
stream. Remember that a renderer change owes `npm run build:web` if any of it
lands in a web-bundled half. Keeping the pane code out of the web bundle until
the parity ticket avoids that.

## 7. Failure modes

| Failure | Behaviour |
|---|---|
| **`/clear`** (symlink repoints to a new file, new sessionId) | The feed follows the repoint the way JsonlWatcher does (realpath change → reopen). The pane draws a `── cleared ──` divider and continues. Old blocks stay above it, up to the pane's block cap. |
| **`/compact`** (same file; compact boundary + `isCompactSummary` user record) | A collapsed "conversation compacted" block with the summary expandable. The summary record must **not** render as a user prompt. |
| **Resume / restart** | Unlike JsonlWatcher, the feed reads from the **start** of the file, because history is the point. Transcripts are large (200KB for a trivial session, mostly `attachment` records), so the reader parses in main, drops attachments and bookkeeping before anything crosses IPC, and serves the last N blocks with "load earlier" paging. |
| **Transcript unreadable / symlink absent / saving off** (fact 10) | The feed reports `unavailable`, and the tab is RAW with the toggle disabled and a tooltip giving the reason. Never an empty pane over a hidden screen: the operator must never have *less* than today. |
| **Transcript readable but stale** (the CLI stops writing mid-session) | A heuristic guard: if activity went `thinking → idle` with a turn end and no new record arrived in the last 5s, raise a "pane may be behind — peek" hint. Keep it cheap; it is a tripwire, not a feature. |
| **Codex seats** | **Out of scope.** Different TUI (no measured composer anchor), different transcript format (`transcript-readers.js` reads Codex for text only). Codex tabs stay RAW. |
| **Muse / bash sessions** | RAW. |
| **CLI upgrade changes the anchor** | Anchor not found → FULL: the tab looks like today, nothing is hidden. Safe by construction. **Dangerous direction:** the anchor still matches while something the operator needs is drawn *above* the rule, such as a future CLI putting a confirmation above the composer while keeping it. That is why the flip fact is defined around false positives. A cheap tripwire: log a warning when the anchor is found but the rows between the last transcript-committed content and the rule contain text that is neither spinner nor blank for more than N seconds. |
| **Transcript schema change** | Unknown record types render as nothing. Unknown content-block types render as a generic collapsed "‹type›" row with the raw JSON on expand. Unknown tools use the generic tool row. The parser lives in one pure module (`renderer/lib/transcript-blocks.js`) with fixture tests built from real transcripts, so a schema change is one module to fix. |
| **Hidden `[agent:…]` intents** | Intents fire from the wire or the jsonl in main, not from the screen, so hiding the screen changes nothing about delivery. |

## 8. Size and ticket decomposition

**New modules**

| Module | Side | Est. lines (src / test) | Role |
|---|---|---|---|
| `transcript-feed.js` | main, electron-free factory | 300 / 250 | Per-seat reader of `run/<name>/transcript.jsonl` from start: follows repoint, incremental read with a partial-line carry, filters out attachments and bookkeeping, emits raw kept records with a monotonic cursor, caps. Add it to `SCANNED_MODULES` in `test/free-identifier-leaks.test.js`. |
| `renderer/lib/transcript-blocks.js` | pure | 250 / 300 | Records → block view-model: pairs tool_use with tool_result by `tool_use_id`, groups consecutive read-only tools, maps compact / clear / local_command / informational / turn_duration, per-tool summary lines. Tested against fixtures cut from real transcripts. Every table row must carry its distinguishing literal (see the Tests section of CLAUDE.md). |
| `renderer/lib/live-split.js` | pure | 100 / 200 | `(rows[], cursorY, cols) → {mode:'split'|'full', top, bottom}` plus the hysteresis reducer. Fixtures are screens captured by the spike (idle, working, menu, dialog, trust, help, Ctrl-O, widths 60/100/200). Reuses the composer rules from `lib/voice-submit.js`. |
| `renderer/transcript-pane.js` | DOM island | 400 / — | Render, expand/collapse, follow, links, Custom Highlight search, working line, focus forwarding. |

**Changed:** `renderer/renderer.js` createSession (strip wrapper, translate, key
handler, toggle; about 80), `renderer/term-search.js` (search target
abstraction; about 60), `renderer/styles.css` (about 120), `preload.js` +
`ipc-handlers.js` + `api-contract.js` (one `transcript:pull` invoke, and
possibly a `transcript-changed` push that is session-scoped via
`_sendToSession`; about 40), `engine.js` / `session-manager.js` wiring (about
40), and `RENDERER_SCANNED_MODULES` for the new islands.

**Total:** about 1.7k source and about 1k test lines. No prompt text is added,
no CLI flags change, and the PTY geometry is untouched.

**Tickets**

1. **Split proof: composer-anchored live strip over a crude transcript pane
   (Claude seats, desktop, behind a toggle).** `live-split.js` with the anchor
   rule. Strip + translateY + viewport pin + FULL fallback + hysteresis. The
   pane is a `<pre>` fed by a naive main-side reader: re-read the file on
   `fs.watch`, last 200 records, one line per user text / assistant text /
   tool_use. Captures the fixture matrix from a live CLI, including **a real
   permission dialog, an Edit permission with a diff, plan mode, the bypass
   footer, and an API retry if one can be provoked**, at 3 widths. Records
   both measurements (anchor, and cursor-up excursion) per state. Exit: one
   real working session driven through the split for a full task, with no lost
   keystroke, no state where the strip hid a dialog, and a rows-saved number
   for a tool-heavy turn. **This ticket answers the flip question; stop if it
   fails.**
2. **transcript-feed.js + contract.** The real reader: incremental, from start,
   filtering, repoint/compact/clear, caps, `unavailable` reasons, the
   `transcript:pull` invoke. Replaces the spike's reader.
3. **Dense pane rendering.** `transcript-blocks.js` + `transcript-pane.js`:
   collapsed rows, expand, thinking, diffs from `toolUseResult`, read grouping,
   file links, intent marks, working line, `writing…` placeholder, the
   compact/clear dividers.
4. **Interaction parity.** Focus/key forwarding, copy, Cmd+F on the pane via a
   term-search target abstraction, wheel routing, Ctrl-O/Ctrl-E intercept,
   peek, RAW toggle persisted per seat.
5. *(later, optional)* **Wire streaming feed.** Throttled per-agent
   `text_delta` / `thinking_delta` publication from the tee; in-flight block in
   the pane.
6. *(later)* **Peer/web parity.** The contract row served by the web host, and
   the peer-wire endpoint.

## 9. Recommendation

**Build a spike first (ticket 1), then decide.** The mechanism is sound on
paper. Everything that makes it risky is empirical: whether the anchor is
unambiguous across states, whether per-permission FULL jumps are tolerable,
whether the rows saved justify 1.7k lines once CLI 2.1.281's own tool
collapsing (fact 8) is counted.

**Flip fact:** whether the rule-plus-`❯` anchor is present *and never falsely
matches* in every state where the operator needs only the composer. A missing
anchor is safe (FULL). A false match can hide a dialog, and that kills the
design.

**Against the mirror approach:**

| Axis | Transcript view | Mirror (hidden terminal) |
|---|---|---|
| Density gained | Highest: one row per tool call, grouping, thinking hidden, full output one click away. Tool traffic only; prose costs the same. | Bounded by the CLI's own layout. It can show more of it, but cannot shrink a 5-row tool block. |
| Fidelity risk | Real, and listed in §1: spinner, retry banners, queued prompts, hook lines, streaming prose (until a wire feed). Mitigated by FULL on any doubt and by peek. | Low: what you see is what the CLI drew. |
| Implementation size | About 1.7k source + about 1k tests over 4 core tickets. | Likely smaller; depends on how the taller-PTY question resolves. |
| Dependence on CLI screen wording | One anchor (rule + `❯`), already depended upon by voice-submit and the inject draft gate, so a break would surface there too. Everything else comes from the transcript JSON. Missing anchor fails safe. | Depends on whatever markers the mirror uses to decide what to re-show; unknown from here. |

One more consideration favours the transcript view long-term: it is the only
approach that also gives the phone and web views a readable conversation, since
a transcript is cheap to ship and a terminal is not. That is out of scope for
v1, but it is a reason not to discard it if the mirror wins on the desktop.
