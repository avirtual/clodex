# Design: the transcript pane as an app view, not a denser terminal

Ticket t1134 · base master e2c5fb2b · 2026-09-24 · design only, no code.

Read `transcript-view.md` (t1121) and `split-proof.md` (t1122) first. This
document builds on the split they proved. It does not change the split. The
anchor rule, the strip, the FULL fallback and the frame gate all stay as they
are. What changes is everything above the strip, plus one new window-level
surface: a right-side pane that the file viewer moves into, per Bogdan's ruling
on question 3.

## Outcome

**Stop sending display strings. Send typed records.** Today the reader in main
turns each transcript record into a pre-rendered line (`❯ …`, `⏺ …`,
`  → Bash(…)`), and the renderer paints those lines into one `<pre>`. Every idea
in Bogdan's brief needs data that this string model has already thrown away:
which tool call a result belongs to, its exit code, the files an edit changed,
where a turn begins. So the first move is a record model. Each tool call is
paired with its result by `tool_use_id`, and each record carries a small
**summary** computed in main. The heavy parts (full output, full input, patch)
stay in main and cross IPC only when a row is opened.

**Recommendations, one per question:**

1. **Row model.** Twelve record kinds, listed in §1. A tool call and its result
   are one record. `thinking`, attachments and bookkeeping are dropped. A
   record's summary crosses IPC on every pull. Its detail crosses only on
   demand, through a new `transcript:detail` invoke.
2. **Visual language.** Prose (prompts and assistant text) uses the UI font.
   Anything machine-shaped (tool rows, command output, diffs, intent heads) uses
   the monospace font. Each turn is a block that opens with its prompt and
   closes with a footer. A tool call is **one row**: a status mark, the tool
   name, the main argument, and a right-aligned result summary. Intents render
   as cards. Completed runs of 3 or more error-free tool calls fold into one
   chip row. That takes t1122's tool-heavy turn from 6 rows to 1, so it saves 18
   rows where the terminal saved 13.
3. **Detail surface: one side pane on the right, per Bogdan's ruling.**
   - It is editor-like and full height, and **it replaces the file-peek
     modal** for every caller. File tabs and tool-call tabs share its one tab
     strip.
   - A single click opens a **preview tab**, which replaces the previous
     preview. A double-click or an edit makes the tab permanent. A file that is
     already open is focused, not duplicated.
   - When the agent edits an open file, the tab reloads in place and flashes
     the changed lines. **An unsaved operator edit is never overwritten.**
   - The pane is resizable and closable, and remembers its width.
   - The terminal refits to the remaining width, once per open, close or
     drag-end.
4. **Strip.** The strip keeps the composer, the footer, menus and dialogs. It is
   joined by a one-row **live tail** that is pinned between the pane and the
   strip. While the seat works, the tail mirrors the CLI's own status row (the
   spinner, the running tool, the API-retry notice). That row is on the xterm
   but clipped away today. A pending Bash row streams its output from the
   existing `console:live` service.
5. **Navigation.** Scrolling follows new records only while the view is at the
   bottom; otherwise a "N new" pill appears. The current turn's prompt sticks to
   the top of the pane as you scroll. Cmd+↑/↓ jump between turns, and Cmd+F
   searches the pane through the CSS Custom Highlight API. One chord flips the
   tab to the raw terminal.
6. **Sequencing.** Five tickets, in §6, plus the reader hardening already
   scoped by t1121.
   - T1 is the first thing Bogdan sees: typed records, turn blocks, one-row
     tool rows with result summaries, and the raw-terminal chord.
   - T2 moves the file peek into the side pane. T3 adds tool tabs.
   - T4 is the live tail, folding and intent cards. T5 is navigation.

---

## 0. Structural decisions that hold the rest up

### 0.1 Records are built in main; summaries cross IPC; detail is lazy

A tool result can be large. On this repo's working seats, Bash stdout runs to
tens of KB before the CLI persists it to a file. An Edit result carries
`originalFile`, which is **the whole file before the edit**, and a Read result
carries the whole range it read. The spike's reader re-sends all of its lines
on every change. The record model must not do the same with outputs.

- `transcript:pull(name)` returns `{ ok, rev, records }`. Each record carries
  only its summary fields (§1), and the whole payload for 400 records stays in
  the tens of KB.
- The new `transcript:detail(name, id)` returns the full view of one record
  (§3.5). Main keeps a bounded `id → raw` index built during the parse. The
  index holds only what `detailOf` needs, never the whole raw record.
- **`originalFile` never leaves main.** Neither does Read's `file.content`,
  because the file tab reads the file itself. Both are dropped when the index
  entry is built, so a later change to `detailOf` cannot leak them by accident.

The record builder is a pure, electron-free module at the repo root,
`transcript-records.js`. It has no fs and no timers:
`recordsOf(jsonlText) → { records, index }` and `detailOf(indexEntry) → detail`.
The reader (`transcript-spike.js` today) owns the fs side. The builder is pure
because its whole correctness is a table of real-transcript fixtures (§6 T1).
It lives on the main side because the heavy data does.

### 0.2 The renderer is keyed, not replaced

`renderTranscript` does `paneEl.replaceChildren(frag)` on every rev. That was
fine for a `<pre>`. It breaks an app view in three ways:

- The row whose tab is open in the side pane loses its highlight.
- A DOM selection the operator is dragging is destroyed mid-copy.
- A pending tool row cannot turn into a finished one without the whole pane
  repainting.

The new pane keeps `Map<id, { sig, el }>`, where `sig` is the record's summary
serialised. On each rev it walks the records in order:

- Same `sig`: keep the element.
- Changed `sig`: replace that element only.
- New record: append it.
- Record gone: remove the element. That happens only when the cap window moves
  or on a `/clear` repoint.

The turn blocks are keyed the same way, by the id of the turn's first record.
The follow rule stays as it is (at the bottom within 4 px → re-pin after the
render).

### 0.3 The pane stops being a `<pre>`

`paneEl` becomes a `<div class="transcript-pane">` with its own scroller. The
`<pre>` semantics move to the elements that are genuinely preformatted: command
output, diffs and side-pane bodies. The no-innerHTML pin moves with it. The
fake-document `innerHTML` setter in `test/live-split-view.test.js` throws, and
every new DOM module must be tested with the same fake document. All transcript
text is agent-authored and the renderer runs with `nodeIntegration: true`. So
`textContent` plus `scanLinks` anchors are the whole defence, as
`inbox-drawer.js` already states for its own notes.

---

## 1. Row model

### 1.1 Common fields

Every record carries these fields:

| field | meaning |
|---|---|
| `id` | Stable across pulls. For a tool: the `tool_use` id. Otherwise: the transcript record's `uuid`, suffixed with the block index when one assistant record yields several. A reader-synthesised boundary gets `clear:<n>`. |
| `kind` | One of the kinds below. |
| `ts` | Epoch ms from the record's `timestamp`, or `null`. |
| `turn` | An integer. It increments at every record that **starts** a turn: `prompt`, `inbound`, `notification` and `command`. Tool results and assistant blocks inherit the current one. |

### 1.2 Kinds

| kind | built from | carries (summary, over IPC every pull) | detail (on demand) |
|---|---|---|---|
| `prompt` | `user`, string content, not `isMeta`, not `isCompactSummary`, not starting with `<`, not an inbound | `text` (capped at 4 KB with `truncated: true`), `source`: `typed` \| `queued` (from `promptSource`) | full text |
| `inbound` | the same `user` records whose text starts with `[agent:from SENDER]` | `from`, `text` (first 4 KB), `attached: { path, bytes }` when the delivery reads `Message (N bytes) attached: @path` | full text; the attachment opens as a file tab |
| `notification` | `user` with `origin.kind === 'task-notification'` | `text` (first line, 300 chars) | full text |
| `assistant` | each `text` block of an `assistant` record | `text` in full, capped at 64 KB (prose is the content), and `apiError: true` when the record has `isApiErrorMessage` | — |
| `tool` | each `tool_use` block, **paired** with the later `tool_result` whose `tool_use_id` matches | `name`, `arg` (today's `toolInputLine`), `state`: `pending` \| `ok` \| `error` \| `denied` \| `interrupted`, and `sum` (see 1.3) | full input, full output, patch (see §3.5) |
| `command` | `system/local_command` with `<command-name>` | `name`, `args` | — |
| `command-output` | `system/local_command` with `<local-command-stdout>` | `text` (ANSI kept, 400-line cap as today) | — |
| `notice` | `system/informational`, and `user` text `[Request interrupted by user…]` | `level` (`info` \| `warning` \| `error`), `text` | — |
| `boundary` | `system/compact_boundary`; a realpath repoint (`/clear`, synthesised by the reader during reader hardening) | `what`: `compact` \| `clear`, plus for compact `trigger`, `preTokens`, `postTokens` | compact: the `isCompactSummary` record's text |
| `turn-end` | `system/turn_duration` | `durationMs`, `messageCount` | — |
| `queued` | `queue-operation` with `operation: 'enqueue'` whose text has not yet appeared as a `prompt` with `source: 'queued'` | `text` | — |
| `thinking` | `thinking` blocks | `chars` only | full text |

Notes on the table:

- **Tool pairing across the cap window.** The pairing runs over the whole parse,
  before the window is cut to the newest records, so a result whose call fell
  off the window is simply dropped. A `tool_use` with no result yet is
  `pending`. That is the live state, and the renderer depends on it (§4).
- **`queued` closes a gap `transcript-view.md` §1 listed.** Prompts typed while
  the seat was busy were hidden in split mode. The transcript does record them,
  as `queue-operation` enqueues (64 in the lead's current transcript). So the
  pane can show them as pending, dimmed prompt rows until the real `prompt`
  lands.
  - Match by exact text. Stop showing a queued row when a later `dequeue` or
    `remove` operation carries the same text, or when a queued-source prompt
    with the same text lands.
  - The implementing ticket must check the `operation` values against a real
    transcript before relying on anything but `enqueue`.
- **Inbound deliveries are a kind of their own**, not prompts. On a team seat
  they are most of the "user" turns. They render as a compact card: sender,
  ticket id if present, byte size, and the attached file as a link. The `❯`
  line they get today spells out the whole protocol wrapper.
- **`thinking` is in the model, but no row is rendered by default.** The
  summary carries only `chars`, so the text never crosses IPC unless the
  record is opened. See §2.6.

### 1.3 Tool summaries (`sum`)

The summaries are computed in main from `tool_result.is_error`, the result
content and the `toolUseResult` side-car. The shapes below were checked against
the 25 newest transcripts of this repo's seats, which had 7,100+ tool results.

| tool | `sum` | source |
|---|---|---|
| Bash | `{ exit, lines, interrupted, background, persisted, only }` | Success: `toolUseResult` is an object `{stdout, stderr, interrupted, …}` and `exit` is 0. Failure: `is_error: true`, the content starts `Exit code N`, and `toolUseResult` is a **string** `Error: …`. `exit` is parsed from that first line. `lines` = the line count of stdout + stderr. `persisted` = `persistedOutputSize` when the CLI wrote the output to a file. `background` = `backgroundTaskId` is present. `only` = the single output line when `lines === 1` and it is 80 characters or fewer. |
| Edit, MultiEdit | `{ file, add, del }` | `structuredPatch[].lines`: count the lines starting `+` and `-`. |
| Write | `{ file, created, add, del }` | `type === 'create'`; `structuredPatch` |
| Read | `{ file, from, to, total }` | `file.startLine`, `numLines`, `totalLines` |
| Grep | `{ files, lines }` | `numFiles`, `numLines` |
| Glob | `{ files, truncated }` | `numFiles`, `truncated` |
| WebFetch | `{ code, bytes }` | `code`, `bytes` |
| WebSearch | `{ results }` | `searchCount` |
| Agent, Task | `{ description, model, status }` | `description`, `resolvedModel`, `status` |
| TodoWrite and the task tools | `{ done, total }` | the input's todo list |
| anything else | `{ lines }` | the line count of the result text |

The `state` values are decided like this:

- `error`: `is_error` is true.
- `denied`: `error`, plus the content is the CLI's permission-rejection text.
  This matches the CLI's wording, so it is display-only. If the wording
  changes, the row degrades to `error`, and nothing hides.
- A content starting `<tool_use_error>` is also `error`, with its first line as
  the message. The CLI's "Blocked: sleep …" refusals take this path.
- `interrupted`: `toolUseResult.interrupted`.

### 1.4 What is dropped, and why

- **`attachment`** is the bulk of the file by bytes (975 KB of the lead's 3 MB).
  It holds environment, skill listings and prompt snapshots, and none of it is
  conversation.
- **Bookkeeping** carries no conversation content: `mode`, `permission-mode`,
  `last-prompt`, `ai-title`, `file-history-snapshot`, `cost-state` and
  `atis-latch`. `ai-title` is a candidate for the tab title, but that is not
  this ticket's business.
- **`isMeta` user records** are hook and harness scaffolding.
- **The `isCompactSummary` user record** is not a row. It is the detail of its
  `boundary`. Rendering it as a prompt would put a 3 KB summary where the
  operator reads prompts.
- **Standalone `tool_result` rows.** Every result is paired into its `tool`
  record. An orphan result is one whose call fell off the cap window, and it is
  dropped.
- **Sidechain records** (`isSidechain`) belong to subagents. The Activity tab
  shows them. The parent's `Agent` tool row is the pane's representation.

---

## 2. Visual language

All values below are existing tokens from `renderer/styles.css` `:root`. No
emojis. Status marks are CSS shapes or plain typographic characters that the
UI already uses (`·`, `→`, `+`, `−`).

### 2.1 Fonts per row type

| row | font | size / line-height | colour |
|---|---|---|---|
| prompt, inbound text, assistant prose | `--font-ui` | `--fs-md` / 1.45 | `--text-primary` |
| tool row, command, command-output, diff, intent head | `--font-mono` | `--fs-sm` / 1.5 | name `--text-primary`, argument `--text-secondary`, summary `--text-tertiary` |
| turn footer, notices, chip counts, queued prompts | `--font-ui` | `--fs-xs` | `--text-tertiary` |
| code fences inside prose | `--font-mono` | `--fs-sm` | on `--surface-input` |

Prose in the UI font is the single largest "not a terminal" signal. It also
**raises** density for prose: a proportional 13 px face fits about 30% more
characters per line than 12 px monospace at the same width. So the switch costs
no rows.

### 2.2 Turns

```
┃ Run seq 1 30, then run seq 1 12, then run date, then use the Edit tool…     10:42
  I'll run those in order.
  ● Bash    seq 1 30                                             30 lines
  ● Bash    seq 1 12                                             12 lines
  ● Bash    date                                  Wed Sep 24 10:42:13 2026
  ● Read    notes.txt                                            1–3 of 3
  ● Edit    notes.txt                                              +1 −1
  ● Bash    cat notes.txt                                         3 lines
  Done: alpha is now beta.
  14s · 6 tools · notes.txt +1 −1
─────────────────────────────────────────────────────────────────────────
```

- **Prompt header.**
  - A 2 px `--accent` bar on the left and a `--surface-raised` background, with
    padding `--sp-1 --sp-2`.
  - The time sits at the right in `--text-tertiary`.
  - The text is clamped to 3 lines. A click on the header opens the full
    prompt in a side-pane tab.
  - An `inbound` header takes the same shape, with an `--info` bar and a
    leading `from clodex-team` label.
- **The body** is indented `--sp-3` from the header's text column.
- **Turn footer** (from `turn-end` plus the turn's records), in `--fs-xs`
  tertiary:
  - the duration and the tool count;
  - `n errors` in `--error`, when there are any;
  - the files changed, each a link that opens a file tab;
  - `compacted 209k → 8k` on a turn that contains a boundary.
- **Between turns:** `--sp-4` of space and a 1 px `--border` rule. There is no
  box around a turn, because boxes cost two rows per turn.
- **The pane's text column starts at the same x as the composer's `❯`** in the
  strip below. The pane uses the xterm wrapper's left padding plus one cell, so
  the eye reads down one column from the conversation into the composer.
- **The pane's `border-bottom` goes.** The CLI's own rule, which is the first
  row of the strip, is the boundary. A second line right above it reads as two
  widgets.

### 2.3 Tool rows

There is one row per tool call, fixed at 20 px:

`[mark] [Name, fixed 6ch] [arg, ellipsised] ······ [summary, right-aligned]`

- **The mark** is a 6 px circle.
  - `pending`: `--info`, with a pulsing opacity animation.
  - `ok`: `--text-tertiary` at 50% opacity.
  - `error` and `denied`: `--error`.
  - `interrupted`: `--warn`.
- **The argument** is monospace in `--text-secondary`, with
  `text-overflow: ellipsis`. File paths are `scanLinks` anchors, as today.
  Paths inside the repo are shown repo-relative. The full path is in the
  `title` and in the link's `data-path`.
- **The summary**, right-aligned in tabular numerals:

| tool | summary text |
|---|---|
| Bash ok | `30 lines`, or the single output line itself (`sum.only`), or `no output` |
| Bash error | `exit 1 · 4 lines` in `--error` |
| Bash denied | `denied` in `--error` |
| Bash background | `background` |
| Bash persisted | `46.7 KB` |
| Edit, Write | `+12 −3` (+ in `--ok`, − in `--error`); a Write that created the file reads `new · 120 lines` |
| Read | `1–40 of 428` |
| Grep | `14 lines in 3 files` |
| Glob | `9 files` |
| Agent | the `description`, then `model` in tertiary |
| pending | the elapsed time since `ts`, ticking once a second, from the same timer as the live tail (§4); for Bash, `running · 42 lines` once live output exists (§3.6) |

- **Showing `sum.only` in place of a count** is what makes the `date` row
  useful at zero cost. The operator sees the answer without opening anything,
  and it adds no row.
- **Hover** gives `--surface-hover` and `cursor: pointer`. A click opens the
  call in the side pane (§3). Clicking a path link inside the row opens that
  file's tab instead.

### 2.4 Density, and what folding adds

Measured baseline (t1122, run 2): the CLI drew 19 rows for six tool blocks,
plus 5 blank separators. The naive pane drew 6.

| rendering | rows for that turn's tool traffic | saved against the CLI's 19 |
|---|---|---|
| naive pane (today) | 6 | 13 |
| T1 tool rows | 6: still one row per call, now with summaries | 13, and the rows now carry the exit code and line counts |
| T4 folded chip | 1 | **18** (23 counting separators) |

**The folded chip** is one row that stands for a run of consecutive tool calls:

`[▸] 6 tools · Bash 4 · Read · Edit · notes.txt +1 −1 · 3.1s`

When it applies:

- It folds a run of **3 or more** tool calls with no assistant text between
  them, **in a completed turn only**. A turn is complete once its `turn-end`
  has landed, or once a later turn has started.
- **A run that contains an `error` or a `denied` call is never folded.** An
  error is exactly what the operator scrolls back to find.
- **The live turn is never folded.** Watching the calls land one by one is how
  the operator follows progress.
- The folded rows **stay in the DOM** with the `hidden` attribute. Search (§5)
  and copy therefore still see them, and a click on the chip toggles them in
  place.

What folding adds: on a tool-heavy seat, a finished turn becomes three lines
(prompt, chip, prose). That lets scrollback work as a table of contents. What
it costs: at the moment a turn ends, its rows change height, and a reader in
the middle of it loses their place. For that reason the fold is applied only to
turns **above** the viewport or when the view is following. A turn the
operator is currently looking at is never collapsed under them.

### 2.5 Intent cards

t1129 marks intent spans with the terminal's marks: `fire`, `inert` and
`filed`. The card form keeps those three states and gives the intent a
structure instead of a highlight.

```
╭ dm → clodex ─────────────────────────────────── fired ╮
│ Hi, the design is at docs/explorations/pane-app-view… │
│ + 14 more lines                                       │
╰───────────────────────────────────────────────────────╯
```

- **Head.** Monospace: verb, arrow, target, and on the right the state word.
  - `fired` in `--ok`.
  - `not fired` in `--warn`, with the parse failure as the tooltip.
  - `filed` in `--info`, with the spill path as a link.
- **Body.** The prose font, clamped to 2 lines, with `+ N more lines`. A click
  expands it inline. Intent bodies are short and in-context, so a side-pane
  tab would be overkill.
- The card uses `--surface-raised`, a 1 px `--border`, `--radius-md`, and a
  2 px left bar in the state colour. It is drawn with CSS borders; the box
  characters above are only for the illustration.
- **Segmentation.** The assistant text is split into `prose` segments and
  `intent` segments **before** any markdown rendering. The split runs line by
  line with `intent-scanner`'s `parseIntent` and `fencedLines`, so an intent
  inside a fence is prose, the same rule `classifyRows` already follows.
  - The body extent must match the real scan in `session-manager.js`
    (`bodyModeFor` and the turn scanner's greedy body loop): up to a bare
    `[agent:end]` or the next column-1 intent line, and JSON bodies for the
    `exec` family.
  - **Extract that loop into a pure helper and call it from both places.** Do
    not copy it. `intent-marks.js` states the reason: a mark that disagrees
    with the real scan is worse than no mark.
  - If the extraction proves too tangled for T4, ship the cards with the head
    row only and keep the t1129 inline mark for the body. Log that as the gap.
- Prose segments go through `renderer/lib/render-markdown.js`, which is already
  a DOM builder (it takes `doc` and does not use innerHTML). That gives
  headings, lists, fences and inline code, with `safeHref` for links. Markdown
  arrives with the cards in T4. T1 renders prose as pre-wrap text, so the two
  changes are reviewed apart.

### 2.6 Everything else

- **`command` and `command-output`.** A `❯ /context` row in monospace, then
  the output in a `--surface-input` block with its ANSI colours, exactly as
  t1123 renders it now. Outputs longer than 12 lines are clamped with a
  "show all" toggle. `/context` alone is about 40 rows.
- **`notice`.** One `--fs-xs` row: an `--warn` or `--error` mark, then the
  text. An `apiError` assistant record renders as an error notice, not as
  prose.
- **`boundary`.** A full-width divider with the label centred:
  `compacted · 209k → 8k tokens · manual`, or `cleared`. A click on the
  compact label opens the summary in a side-pane tab.
- **`thinking`.** Nothing by default. The pane settings menu (§5) has a
  "Show thinking" option. When it is on, a thinking block renders as one
  tertiary row, `thought · 1.2k chars`, that opens in a side-pane tab.
- **`queued`.** A dimmed prompt header (the `--text-tertiary` bar) with the
  label `queued`. The real prompt replaces it when it lands.

---

## 3. Detail surface: the side pane

Bogdan's ruling: drop the popover-on-top model for files. The file viewer
(today's file peek, `openFilePeek`) moves into a classic right-side pane, the
way an editor has one. The tool-call detail shares that pane.

### 3.1 Shape and placement

```
┌──────────────────────── #main ───────────────────────────────────────┐
│ #terminal-container (narrower)        ┃ #side-pane                   │
│ ┌ session tab ───────────────────────┐┃ [live-split-view.js] [Bash: seq…] ✕ │
│ │ transcript pane                    │┃ ─────────────────────────────│
│ │   ● Bash  seq 1 30      30 lines ◀─┼┃ Bash · exit 0 · 0.2s  Copy   │
│ │   ● Edit  notes.txt       +1 −1    │┃ seq 1 30                     │
│ │ live tail: ✶ Nucleating… (4s)      │┃ 1                            │
│ ├────────────────────────────────────┤┃ 2 …                          │
│ │ strip: ── rule ──  ❯ composer      │┃                              │
│ └────────────────────────────────────┘┃                              │
└──────────────────────────────────────────────────────────────────────┘
```

**Decision: one full-height column per window, beside `#terminal-container`,
and the terminal refits to the remaining width.**

- `#main` gains a row wrapper, `#work-row`, with `display: flex`. It holds
  `#terminal-container` (`flex: 1`), a 5 px drag handle, and `#side-pane`. The
  search bar, the peer bar and the proxy bar stay where they are.
  - `#terminal-container` is selected by id everywhere, so wrapping it moves no
    selector. The implementer greps for `terminalContainer.parentElement` and
    for layout CSS on `#main > *` before moving it.
- **Width:**
  - `clamp(320px, 40vw, 60vw)`, set by dragging the handle.
  - It is remembered in ui-settings under `sidePaneWidth`, one global value,
    like an editor's.
  - The side pane closes when the window is narrower than 700 px: the
    terminal must keep at least about 60 columns.
- **Open and closed state is per seat.** A seat that has tabs open shows the
  pane when you switch to it. A seat without tabs does not, and switching to it
  hides the pane.
  - The per-seat tab sets are held by the side-pane island. They are not
    persisted across a restart in v1.
  - The pane shows the **active seat's** tabs, because file paths resolve
    against that seat's cwd and worktree. Two seats' `src/foo.js` are
    different files.

**Why the pane is full height and the terminal refits** (and does not sit only
above the strip):

- **The split flips to FULL on every permission prompt.** A side pane that
  lived only in the pane region would have to vanish on each of those flips,
  or it would cover the dialog's right half. A full-height column is
  untouched by split/FULL flips, by raw mode, by Codex seats and by bash tabs.
  It behaves the same everywhere.
- **The side pane is not a peek any more. It is an editor surface**, and it
  applies to every seat type, not just to split Claude seats.
- **A width change on open is a real, honest resize.** It is the same thing a
  window resize or the bottom drawer's toggle does today, through
  `refitActiveTerminal`. The split's "never resize" rule was about never
  shrinking the PTY to the strip's height, and that still holds.

The resize rules:

- The refit goes through the existing `ResizeObserver(refitActiveTerminal)` on
  `#terminal-container`. That observer already handles peer tabs correctly
  (read-only peers never send dimensions), so the side pane needs no resize
  code of its own.
- **During a drag**, only the CSS width changes. The terminal refits once, on
  mouseup, and no more often than every 150 ms while the drag is held. Each
  refit is a SIGWINCH and a full CLI repaint, and a repaint per mouse move
  would storm.
- On open and close there is exactly one refit. The split view's own
  `onResize` → `evaluate()` → `layout()` path re-measures the anchor
  afterwards, as it does for a window resize.

### 3.2 Tabs: preview, permanent, dedupe

This is a tab strip, not a stack. The operator moves between a file and the
tool call that changed it by clicking a tab, and never has to unwind a stack
with Back.

| action | result |
|---|---|
| single click on a file link (pane, terminal, inbox, IPC log, files popover), a tool row, a prompt header, a boundary or a thinking row | opens in the **preview tab**: an italic title, one per seat. It **replaces** the current preview tab. Clicking through ten tool rows leaves one tab, not ten. |
| the target is already open in a permanent tab | that tab is focused. There is no duplicate. The identity is `file:<seat>:<realpath>` for a file and `tool:<seat>:<tool_use id>` for a record. |
| double-click on the same source, double-click on the preview tab's title, the pin button, or switching a file tab to Edit | the preview becomes **permanent** (upright title). The next single click opens a new preview beside it. |
| `[agent:file view PATH]` pushed by an agent | opens in the preview tab with a `pushed by <name>` badge. It never replaces a permanent tab. So an agent can show you a file, but cannot close something you pinned. |
| more than 12 tabs on a seat | the least recently used permanent tab that is clean (no unsaved edit) closes. A dirty tab never closes automatically. |
| ✕ on a tab | closes it. Closing the last tab closes the pane. A dirty tab asks first (Save / Discard / Cancel). |
| ✕ on the pane | closes the pane, and the seat's tabs are kept. The next open restores them. |

**Answering the ruling's question:** opening a file from the pane **replaces
the current preview tab**, or **focuses** its existing tab if it is already
open. It **adds** a tab only when the operator makes it permanent. Without the
preview rule, a few minutes of clicking through tool rows buries the one file
the operator actually cares about.

**Tab kinds:**

- **File.** Today's peek, re-hosted. It has three views in a segmented control
  inside the tab: `Diff` (git against HEAD), `File`, and `Edit` (local seats
  only, and only for content that is not truncated, exactly as
  `peekEditable()` rules today).
  - The line-anchored open (`line`) scrolls there and marks the line.
  - Peer seats keep reading through `popoverApi(name).peek/.diff`, and stay
    read-only.
- **Tool.** The tool-call body, §3.5.
- **Text.** A prompt, an inbound message, a compact summary or a thinking
  block: plain or markdown text in the prose font.

**Closing and keys.** Everything is click-driven: ✕ on a tab, ✕ on the pane,
or clicking an open row again to close its preview. **Esc does nothing here.**
Keys go to the PTY, and Esc interrupts the agent. The only exception is while
a file tab's editor has focus, which is the one place in the side pane that
takes keyboard input. There, Esc returns focus to the terminal and does not
close anything. Cmd+W keeps meaning archive the session. It must not be
repurposed to close a side tab, because a muscle-memory Cmd+W would kill an
agent.

### 3.3 When the agent edits a file that is already open

**Signals.**

- For a transcript-pane seat, a `tool` record turns `ok` with `name` Edit,
  MultiEdit, Write or NotebookEdit, and its `sum.file` resolves to an open
  tab's path.
- For every seat, including Codex and raw tabs, the `onSessionFiles` push that
  `files-popover.js` already consumes names the file.
- Neither signal covers `sed -i` or a script writing the file. So a file tab
  also **revalidates when it becomes visible**: `file:peek` returns the mtime,
  and the tab re-fetches if the mtime moved. This fetch is triggered by
  becoming visible, not by a timer, so it costs nothing while hidden.

**Behaviour:**

| tab state | what happens |
|---|---|
| File or Diff view, the tab visible | Re-fetch and re-render. Keep the scroll anchored on the top visible line number, not on pixels, because the edit may have changed line counts above it. Flash the changed lines with `--accent-soft` for 1.5 s. The ranges come from the tool record's `structuredPatch` (`newStart`, `newLines`), fetched via `transcript:detail` when the signal came from the transcript. The file-touch push carries no ranges, so it gets no flash. |
| File or Diff view, the tab not visible | Mark the tab with a `--info` dot, "changed by the agent since you looked". Re-fetch when it becomes visible, and clear the dot. |
| Edit view, **no** unsaved changes | Reload silently, as in the File view. The operator has typed nothing, so nothing is lost. |
| Edit view, **unsaved changes** | **Never touch the buffer.** Show a banner in the tab: `<seat> changed this file at 10:52 — Reload (discard yours) · Show their change · Keep editing`. "Show their change" opens the tool record's patch as a tool tab. The operator's Save still goes through `file:write` with `expectMtime`. That precondition already exists, so a save over the agent's change is refused rather than silently clobbering it. The banner is the explanation for that refusal, not a new safety mechanism. |
| the file no longer exists | The tab stays open with `deleted` in the title. File and Diff show "no longer on disk". Edit keeps the buffer, so the operator can still copy it. |

### 3.4 Why this shape, against the alternatives

| option | verdict |
|---|---|
| **Popover or modal** (today's peek) | Ruled out by Bogdan. The reasons also stand on their own. A popover is transient and dismisses on an outside click, and **every** click on the transcript pane hands focus back to the terminal. It covers the conversation it annotates, and a 400-line output does not fit one. |
| **Inline expand** under a row | Rejected as a detail surface. One expanded Bash output pushes the rest of the turn off screen, it fights follow-scroll, and it makes each keyed element's height depend on UI state. It survives only for intent bodies (§2.5) and folded chips (§2.4). |
| **Side pane only above the strip** (no terminal refit) | Rejected in §3.1. It would vanish on every permission prompt's FULL flip, and it would be a split-only feature, while the file viewer serves every seat type. |
| **The existing left drawers** (`library-drawers.js`, `inbox-drawer.js`) | Precedent for the island pattern, not for the placement. They are `position: fixed` overlays that open from the sidebar edge over the session, and they allow one at a time. The side pane follows their construction rules: an island factory, DOM built with `textContent`, and `openFilePeek` and `showToast` injected rather than copied. |
| **The bottom drawer host** (`drawer-host.js`) | Rejected. It is shared by the whole window and hosts the Console, Activity and IPC log tabs, which are not per-record detail. Its layout contract, however, is the model for the side pane's own: never `display:none` on anything that could hold content, and refit through the injected `refitActiveTerminal` only. |

### 3.5 Tool tab bodies

- **Header.** The tool name, the state, `exit N`, the duration (the result
  record's `ts` minus the call's), and actions:
  - `Copy output` / `Copy input`: raw text, ANSI stripped.
  - `Open file`: a file tab, at the hunk's line.
  - `Open full output`: when the CLI persisted the output, open
    `persistedOutputPath` as a file tab.
- **Body by tool:**

| tool | body |
|---|---|
| Bash | the command in full, monospace, wrapped, with the description above it in tertiary; then stdout; then stderr under a `stderr` label in `--error`. ANSI through `ansiRuns` with the theme echo palette, and links through `scanLinks`, exactly as `appendOutput` does now. |
| Bash, pending | live output (§3.6), a `running · 12s` line, and a note that the finished output replaces it |
| Edit, MultiEdit, Write | the **per-call patch** from `structuredPatch`: hunks with old and new line numbers, `+` lines on `--ok-soft`, `-` lines on `--error-soft`. A hunk header click opens the file tab at `newStart`. |
| Read | the file and range, and a button that opens the file tab at `startLine`. The content itself is not shipped (§0.1). |
| Agent, Task | the prompt, the model and the status. `Open in Activity` selects the subagent in the Activity tab when `agentId` matches one. |
| other | the input as pretty JSON, then the result text |

**The tool tab's diff is not the file tab's Diff.** The file tab's Diff view is
`git diff` against HEAD: everything uncommitted in the file. The tool tab shows
what **this call** changed. Both are one click apart.

**DOM, not HTML strings.** `renderDiffHtml` (`lib/render-html.js`) returns an
HTML string, and today's peek assigns `innerHTML`. For the per-call patch, add
`renderPatchDom(doc, structuredPatch)` in a new pure `renderer/lib/patch-dom.js`.

**Hunk rendering.** Re-hosting the peek (T2) is move-first. Its existing
`innerHTML` paths render git and file text through `esc()`, and they are
converted to DOM builders within the same ticket only where that is a
mechanical change. A file tab is agent-adjacent content, and the same
nodeIntegration argument applies. If a conversion is not mechanical, list it as
a follow-up, and do not block the move on it.

### 3.6 Size limits and live output

**Size limits.**

- **The detail body cap is 256 KB**, the same number as `intent-spill.js`'s
  `SPILL_MAX_BYTES`. Import that constant, and do not redefine it. It is the
  size Clodex already treats as the largest body worth carrying whole.
- **Over the cap**, `detailOf` returns the head 128 KB and the tail 64 KB with
  `elided: <bytes>`. The tab shows a divider row, `… 1.4 MB elided — Copy
  output fetches it whole`. Copy calls `transcript:detail` with
  `{ full: true }`, which skips the cap for the clipboard only and never for
  the DOM.
- **In practice the CLI caps first.** It persists large Bash output to a file
  and puts only a 2 KB preview in the result (`persistedOutputPath` and
  `persistedOutputSize`, seen 17 times in the sample). For those calls the tab
  shows the preview plus `Open full output`.
- **Above 2,000 lines**, a body renders the first 2,000 and a
  `render the rest` row.

**Live output for a running Bash call.** Bash output is in the transcript only
after the command finishes. However, `bash-live.js` already tails a running
command's output, keyed by `tool_use_id`, and serves it on `console:live` for
the Console tab.

- A tool tab showing a pending Bash call polls `consoleLive(seat)` every
  500 ms, the Console tab's own rate, and renders the row whose `id` matches.
- While no tab shows it, the pending row polls the same data, but only for its
  line count.
- Polling stops when the record turns `ok` or `error`.
- `console:live` is behind the host's `enableConsole` flag. It is on by
  default in `engine.js` and on in `web-host.js`. Without it, the pending row
  shows the elapsed time only.

### 3.7 Web and peers

`files-popover.js` and the peek run in the web build too (`renderer.js` checks
`__CLODEX_WEB__`). So T2 owes `npm run build:web`, and `web-dist/index.html`
**will** change in T2. That is correct for T2, unlike the pane tickets.

- On a narrow web viewport (below 700 px) the side pane renders as a
  full-screen sheet with a close button, because there is no room for a
  column.
- Peer seats read through `popoverApi` and never get the Edit view, as today.
- The transcript-pane parts (tool tabs, text tabs) stay desktop-only, because
  their data comes from `transcript:detail`, which peers and the web host do
  not serve.

---

## 4. What stays in the strip, and the live tail

**The strip keeps what it has now:** the composer, the footer, slash and `@`
menus, and (by going FULL) every dialog. Nothing about the anchor rule, the
hysteresis or the frame gate changes.

**The pane gains a live tail.** It is one fixed row, 22 px, a sibling of the
scroller: it sits below the pane's scroll area and directly above the strip's
rule. It is always present, so the strip never jumps when the seat starts or
stops working. It is part of the pane's height calculation in `layout()`.

| seat state | tail shows |
|---|---|
| working (activity `thinking`) | **the CLI's own status row, mirrored** as plain monospace text in `--text-secondary`, with a pulsing `--accent` mark on the left. For example `✶ Nucleating… (4s · ↓ 176 tokens)` or `Connection refused · Retrying in 1s · attempt 2/10`. If no status row can be found, Clodex's fallback: `working · 12s`. |
| working, and no record has landed for 1.5 s, and no tool is pending | the same, plus a ghost row appended to the live turn in the pane: `writing…` in tertiary italic. It is removed when the next `assistant` record lands. |
| idle | `idle · last turn 14s · 6 tools` in tertiary. On the right, a `raw terminal` text button that does the §5 chord for mouse users, and the `⋯` pane settings. |

**The mirror is why the two surfaces read as one.** `split-proof.md` names one
real loss of the split: the row above the rule, which holds the spinner, the
in-flight tool status and the API-retry notice, is clipped away. That row
still exists on the xterm, which is at full size.

- `evaluate()` already reads `screenRows()`. Extend `measureSplit` to also
  return `status`: the text of the nearest non-blank row within 3 rows above
  `top`.
- The tail shows `status` **only while the seat's activity is `thinking`**.
  When idle, that row is committed conversation, not status.
- This is pure, and it is fixture-testable today. The 46 captured screens in
  `test/fixtures/split-states/` include `thinking`, `streaming`,
  `tool-running` and `api-retry` at three widths. **Each row in the new test
  table must carry the expected status text as a literal**, per the Tests
  section of CLAUDE.md.
- If a capture shows that the nearest non-blank row is **not** the spinner in
  some working state (for example prose streaming right above the rule), the
  rule must become "the nearest row matching the spinner shape". That decision
  belongs to T4's fixture pass, not to this document.

**Activity reaches the view** through the existing `onSessionActivity(name,
state, turnEnd)` push. `renderer.js` already fans it out to `voiceSubmit`, and
it gains `entry.liveSplit.noteActivity(state)` beside that call. There is no
new IPC.

**The rejected alternative: grow the strip upward while working** to include
the in-flight block. That is the cursor-up-excursion mode from
`transcript-view.md` §4. It shows streaming prose live, but it brings back the
3–6-row tool blocks exactly while they pile up, and the strip's height would
change on every frame. The tail keeps a constant height and carries the one
line that matters. Streaming prose token by token remains the wire-feed ticket
(`transcript-view.md` §8 ticket 5), and nothing here blocks it: an in-flight
`assistant` record keyed `msgId:blockIndex` would replace the `writing…` ghost.

---

## 5. Navigation

- **Scroll.**
  - Follow stays as it is: at the bottom within 4 px, re-pin after the render.
  - When the operator has scrolled up and records arrive, a pill appears at the
    bottom-right of the scroller: `↓ 3 new`. Clicking it scrolls to the bottom
    and follow resumes.
  - Keyed rendering (§0.2) means that when the view is not following, the
    scroll position does not move while records land below it.
  - The one exception is a fold (§2.4). It is applied only to turns above the
    viewport, and the view compensates `scrollTop` by the height it removed.
- **Sticky turn header.** Each turn's prompt header gets `position: sticky;
  top: 0` inside its turn block. While the operator reads the middle of a long
  turn, its prompt stays pinned at the top, and the next turn's header pushes
  it out. This is CSS only and costs no row.
  - The "now doing" line is the **live tail**, which sits outside the scroller
    and is always visible.
  - A second "now doing" bar at the top would repeat the tail. So the top edge
    shows *which turn am I reading*, and the bottom edge shows *what is the
    agent doing now*.
- **Jump to turn.** In split mode, Cmd+↑ and Cmd+↓ jump to the previous and
  next turn header. They are caught in the xterm's
  `attachCustomKeyEventHandler`. The CLI never sees a Cmd chord, so nothing is
  stolen from it.
  - T5 also adds a thin turn rail: marks down the scroller's right edge, one
    per turn, `--error` for a turn with errors and `--accent` for the current
    one. Hovering a mark shows the prompt's first line, and clicking scrolls to
    that turn.
- **Search.** In split mode, Cmd+F searches the pane.
  - `term-search.js` gains a small target interface, `{ find, next, prev,
    clear }`, and one back end for xterm's SearchAddon (today's) and one for
    the pane.
  - The pane back end walks the pane's text nodes, including rows in folded
    chips, which are `hidden` but present. It highlights with the CSS Custom
    Highlight API (`CSS.highlights`), so no search mutates the DOM. A match in
    a folded run unfolds that run.
  - **Side-pane tabs and unopened details are not searched.** The search bar
    says `pane only`, and a `search raw terminal` link flips the tab to raw and
    reruns the query on the xterm. Search inside a file tab is that tab's own
    concern and out of scope here.
- **Raw terminal, one keystroke away.** A chord toggles the active tab between
  split and raw.
  - The proposal is **Cmd+Shift+T**. It is not bound in `app-menus.js` or in
    the renderer's keydown handlers as of e2c5fb2b. The implementer re-checks
    both before binding it, and adds a View-menu item for it.
  - Raw lasts until it is toggled back. It is per seat and held in memory, not
    persisted, so a restart never leaves a seat stuck on raw with the pane
    forgotten.
  - The toggle overrides `isEligible()`: `raw` is simply one more ineligible
    reason, and FULL renders exactly today's terminal.
  - The side pane is unaffected by raw, because it is a window column (§3.1).
  - This chord ships in **T1**, because the constraint applies from the first
    step that makes the pane look less like the terminal.
- **Pane settings.** The `⋯` in the tail opens: "Show thinking", "Fold
  finished tool runs" (default on), and "Side pane follows the newest tool
  call". When the last one is on, the preview tab tracks the newest tool call,
  as a live console. These are stored under the ui-settings keys
  `transcriptShowThinking`, `transcriptFold` and `sidePaneFollow`, and they
  arrive with the tickets that need them.

---

## 6. Sequencing

Every ticket must satisfy these:

- A new module goes into `SCANNED_MODULES` or `RENDERER_SCANNED_MODULES` in
  `test/free-identifier-leaks.test.js`.
- `docs/architecture.md` names the new module.
- New source files ship with zero comments (the comment ratchet).
- `CHANGELOG.md` `## Unreleased` gains one line.
- The transcript-pane tickets (T1, T3, T4, T5) keep the pane out of the web
  bundle, so `web-dist/index.html` must **not** change in them. T2 changes the
  file viewer, which the web build serves, so T2 owes `npm run build:web`
  (§3.7).

### T1: Typed rows (the first visible step)

*"Transcript pane: typed records, turn blocks, one-row tool calls with result
summaries; raw-terminal chord."*

- **New `transcript-records.js`** (root, pure):
  - `recordsOf(text) → { records }`, covering the §1.2 kinds except `queued`
    and `thinking` (both T4), plus the §1.3 summaries.
  - A record cap of 400, cut on a turn boundary so the first turn shown is
    never headless.
- **`transcript-spike.js`**: `parseTranscript` calls `recordsOf`. The
  `MAX_ENTRIES` semantics become a record cap.
- **New `renderer/transcript-rows.js`**: DOM builders per kind and the keyed
  reconcile (§0.2). `renderTranscript` in `live-split-view.js` delegates to it,
  and the `<pre>` becomes a `<div>`. Intent spans keep t1129's `classifyRows`
  mark inside prose rows. Clicks do nothing new yet, apart from the existing
  path links.
- **`renderer/live-split-view.js`**: `setRaw(bool)` and `raw()`, folded into
  `evaluate()`'s eligibility.
- **`renderer/renderer.js`** and **`app-menus.js`**: the chord and the
  View-menu item.
- **`renderer/styles.css`**: §2.1–2.3 and §2.6, and the removal of the pane's
  `border-bottom`.
- **Tests:**
  - New `test/transcript-records.test.js`. Its fixtures are cut from real
    transcripts, with the text sanitised: a Bash success, a Bash `Exit code 1`
    with a string `toolUseResult`, a `<tool_use_error>` block, a persisted
    output, an Edit with `structuredPatch`, a Write create, a Read, a pending
    `tool_use`, an inbound delivery, a task notification, a compact boundary,
    and a `turn_duration`. **Each row asserts the whole record with
    `deepStrictEqual`**, carries its own literal expectation, and checks that
    `originalFile` is absent.
  - New `test/transcript-rows.test.js`, on the fake document that throws on
    innerHTML: that a changed `sig` replaces only its own element, that an
    unchanged record keeps its node identity, and that the text lands as text.
  - Update `test/transcript-spike.test.js` and `test/live-split-view.test.js`.
- **What Bogdan sees:**
  - prompts as headed turn blocks, and prose in the UI font;
  - each tool call on one row, with `exit 1` in red, line counts, `+3 −1`, and
    `date`'s answer inline;
  - pending calls pulsing;
  - inbound deliveries as sender cards;
  - a turn footer with duration and files changed;
  - Cmd+Shift+T for the raw terminal.
- **Size:** about 450 source lines and 400 test lines.

### T2: The side pane, with file tabs

*"Side pane: the file peek moves from a modal into a right-side, tabbed,
resizable pane (every seat type)."*

This ticket is independent of the transcript pane. It can run in parallel with
T1, and it is visible even with the pane toggle off.

- **`renderer/index.html`**: the `#work-row` wrapper, `#side-pane` and the
  handle. The peek modal's markup is removed.
- **New `renderer/side-pane.js`** (island factory): tab model (preview,
  permanent, dedupe, the LRU cap), per-seat tab sets, width persistence,
  drag-to-resize with the refit throttle, and the agent-edit refresh rules
  (§3.3).
  - Its inputs are the `onSessionFiles` push, `file:peek` mtime and
    `setActiveSession`.
  - It exposes `open(seat, target, { preview, line, pushedBy })` and
    `noteToolRecord(seat, record)`. The second is a no-op until T3 wires it.
- **`renderer/popovers/files-popover.js`**: the peek half (`openFilePeek`,
  `renderFilePeek`, the Diff/File/Edit logic) moves into a file-tab renderer
  used by `side-pane.js`. `openFilePeek` keeps its exported signature
  `(name, filePath, forceTab, line, keepHistory, pushedBy)`. Every caller
  (terminal links, inbox, IPC log, the files popover rows, the
  `onSessionFileView` push) is unchanged and lands in the side pane. The back
  stack (`peekBack`) is retired, because tabs replace it.
  - The touched-files popover itself stays a popover.
- **`renderer/renderer.js`**: construct the island, and call
  `sidePane.showSeat(name)` on a session switch.
- **`stores.js`**: `sidePaneWidth`.
- **`renderer/styles.css`**.
- **`web-dist/index.html`**, through `npm run build:web`.
- **Tests:**
  - A pure `renderer/lib/side-pane-tabs.js` holds the tab reducer. Its test
    table has one row per §3.2 action, plus the §3.3 matrix (edit view
    dirty/clean × visible/hidden × deleted), each with its literal outcome.
  - The DOM island stays untested per the R1 rule. The reducer carries the
    logic so that the island is thin.
- **Size:** about 550 source lines and 300 test lines. **Read
  `files-popover.js`'s peek block in full before starting**: the move has to
  keep `peekEditable()`'s truncation guard and `expectMtime` on save.

### T3: Tool tabs

*"Side pane: tool-call, prompt and compact-summary tabs from the transcript
pane, with per-call patches and live Bash output."*

- **`transcript-records.js`**: `index` (trimmed, §0.1) and `detailOf(entry,
  { full })`, with the cap from `intent-spill.js`.
- **`transcript-spike.js`**: keeps the index, and adds `detail()`.
- **`ipc-handlers.js`, `preload.js`, `api-contract.js`**: the
  `transcript:detail` invoke. It is gated like `transcript:pull`, and the reply
  is `{ ok, detail }` or `{ ok: false, reason }`.
- **New `renderer/lib/patch-dom.js`**.
- **New `renderer/tool-tab.js`**: the tool, text and pending-Bash bodies. It
  polls `consoleLive`.
- **`renderer/transcript-rows.js`**: row click → `sidePane.open`, the inspected
  row's accent bar, and the flash ranges fed to `noteToolRecord`.
- **`renderer/renderer.js`**: the wiring.
- **Tests:** `detailOf` per tool (with the cap and `elided`, and `originalFile`
  absent), `patch-dom` per hunk shape, and the api-contract parity test.
- **Size:** about 450 source lines and 350 test lines.

### T4: Live tail, folding, intent cards

*"Transcript pane: a live tail mirroring the CLI status row, folded tool runs in
finished turns, intent cards, markdown prose, queued prompts, thinking rows."*

- **`renderer/lib/live-split.js`**: `measureSplit` returns `status`, with a new
  fixture table.
- **`renderer/live-split-view.js`**: the tail and its height in `layout()`,
  plus `noteActivity`.
- **`renderer/renderer.js`**: the `onSessionActivity` fan-out.
- **`renderer/transcript-rows.js`**: the fold policy with scroll compensation,
  intent cards, render-markdown, and the `writing…` ghost.
- **`transcript-records.js`**: `queued` and `thinking` kinds, and prose/intent
  segmentation.
- **`session-manager.js`**: extract the greedy-body loop into a shared pure
  helper (§2.5). That is a move-only change inside session-manager, so its
  existing intent tests are the guard. Grep for pins on the scanner loop
  first.
- **`stores.js`**: `transcriptShowThinking` and `transcriptFold`.
- **`renderer/styles.css`**.
- **Size:** about 450 source lines and 400 test lines. **This is the riskiest
  ticket**, because of the extraction. Split the cards into their own ticket,
  T4b, if review wants it smaller.

### T5: Navigation

*"Transcript pane: search, sticky turn headers, jump to turn, new-records pill,
turn rail."*

- **`renderer/term-search.js`**: the target abstraction.
- **New `renderer/transcript-search.js`**: the Custom Highlight back end.
- **`renderer/transcript-rows.js`**: sticky headers, the pill and the rail.
- **`renderer/live-split-view.js`**: Cmd+↑/↓ in the custom key handler, and
  exposing the search target.
- **`renderer/styles.css`**.
- **Tests:** the pure part of the search (text-node walk → ranges, including
  hidden fold rows) on the fake document.
- **Size:** about 350 source lines and 200 test lines.

### Carried over: reader hardening (t1121 §8 ticket 2, re-scoped)

This is not new design, so it is not counted in the five.

- `transcript-spike.js` is renamed `transcript-feed.js`. It reads by byte
  offset with a partial-line carry, and resets on a shrink or a realpath
  change.
- On a realpath change it emits a `boundary: clear` record and keeps the
  previous file's records above it, up to the cap.
- It keeps tool pairing across reads: a `tool_use` waits in a map until its
  result arrives.
- It closes the watcher on tab close and on a toggle-off, which fixes the
  leak `split-proof.md` notes.
- `transcript:pull` gains `before: <id>` for "load earlier".

It touches only the main side of the reply shape that T1 fixes, so it can run
at any point after T1. The whole-file reparse is correct, only slower (tens of
milliseconds for a 3 MB transcript, behind a 100 ms debounce and a 1 s pull
throttle). So this has to land before the toggle loses "(experimental)", not
before Bogdan sees anything.

---

## 7. Risks and things the implementer must not get wrong

- **The xterm resizes only through the side pane's width change, and only via
  `refitActiveTerminal`.** It never resizes for the tail, the pill or the
  split. It never resizes per mouse move during a drag (§3.1).
- **Keys stay with the PTY.** The transcript pane and the side pane are not
  focusable, except for a file tab's editor. Nothing binds Esc to closing, and
  Cmd+W is not repurposed. The only chords the pane takes are Cmd chords,
  caught in `attachCustomKeyEventHandler` in split mode only: Cmd+Shift+T,
  Cmd+↑/↓, and Cmd+F (already routed through term-search).
- **An operator's unsaved edit is never overwritten by an agent's change**
  (§3.3). `expectMtime` on `file:write` stays the backstop.
- **An agent push never replaces a permanent tab** (§3.2).
- **No innerHTML in the transcript pane's subtree or in tool tabs.**
  `renderDiffHtml` and `console-tab.js`'s HTML-string builders are not
  reusable there. The file tab's inherited `esc()`-based paths are the one
  known exception, and T2 lists them.
- **`originalFile` and Read content never cross IPC** (§0.1). Assert their
  absence in the record and detail tests, not merely their non-use.
- **Display-only CLI wording.** Three things match CLI text: the
  permission-denial text (`denied`), `Exit code N`, and the status-row mirror.
  If the wording changes, each must degrade to something that is still true:
  `error`, `exit ?`, and `working · Ns`. None may hide anything.
- **The intent card's body extent must be the real scan's**, through one
  shared helper (§2.5), or the card must not claim a body.
- **Fold only turns off screen**, with scroll compensation (§2.4).
- **The transcript pane stays desktop-only.** `createLiveSplitView` is already
  skipped for peer tabs and `__CLODEX_WEB__`, and tool tabs depend on
  `transcript:detail`. Only the side pane's file tabs reach the web build
  (§3.7).

## 8. Open questions for Bogdan

1. **Folding by default.** It saves the most rows (18 of 19), but it changes a
   finished turn's shape. The recommendation is on by default, with errors
   never folded. Say if you would rather opt in.
2. **Side-pane tabs across a restart.** In v1 they are memory-only per seat.
   Persisting them per seat is cheap. It is not in v1 because a restored tab
   whose file is gone needs its own state. Should v1 persist them?
3. **The raw chord.** Cmd+Shift+T is proposed. Say if you want a different
   key, or a hold-to-peek (hold Option → raw while held) instead of a toggle.
   Peek suits a quick glance at streaming text. The toggle suits working in the
   raw terminal for a while. Both are cheap, and T1 ships one.
4. **Streaming prose.** The tail mirror and the `writing…` ghost cover
   "something is happening". Watching the words stream needs the wire feed
   (`transcript-view.md` ticket 5). Is that wanted next, or is the raw chord
   enough?
