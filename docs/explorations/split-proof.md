# Split proof: composer-anchored live strip (t1122)

This is the spike for ticket 1 of `transcript-view.md` §8. It answers the flip question on Claude Code **2.1.281**.

**Answer: YES, the anchor is safe on the captured matrix** (see "Not exercised" for what was not captured). The anchor matched in all 25 captures where the CLI shows only the composer. It matched in none of the 21 captures where the CLI shows a dialog or a panel. In the live run, the strip never covered a dialog.

One caveat for ticket 3. The row above the rule, which holds the spinner, the in-flight tool status and the API-retry notice, is hidden while the tab is split. The pane's working line has to carry it.

## What was built

- `renderer/lib/live-split.js` is pure. `measureSplit(rows, cursorY, cols)` returns `{mode, top, bottom}`.
  - The anchor is a row made only of U+2500 that is at least `cols - 1` cells wide, **immediately** followed by a row that `composerIsEmpty` or `composerHasDraft` accepts. The scan goes up from the cursor row, then down.
  - `reduceSplit(state, measured, now)` is the hysteresis from §3. It grows at once and shrinks only after the smaller height has held for 250 ms. Split→FULL is immediate. FULL→split needs the anchor held for 250 ms, and returns a `wakeAt` so the caller can look again when the screen goes quiet.
- `renderer/live-split-view.js` is the DOM half.
  - The xterm element gets `translateY` so that the anchor row sits at the strip's top edge, plus a `clip-path` inset that hides the rows above the anchor and below `bottom`.
  - A `<pre class="transcript-pane">` fills the space above the strip.
  - While split, the viewport is pinned to the bottom (`scrollToBottom` on `onScroll`). The view goes FULL on the alternate buffer, and whenever the transcript cannot be read.
  - Nothing is resized. `fitAddon` and the PTY keep the tab's true size.
- `transcript-spike.js` is the naive main-side reader behind the new `transcript:pull` invoke.
  - It follows `run/<name>/transcript.jsonl` through its symlink and drops its cache when the symlink is repointed.
  - It re-reads the whole file only after `fs.watch` fires, and keeps the last 200 entries.
  - Entries are one per user text and assistant text, and one line per `tool_use` with the tool name and the first line of its main input.
- Toggle: Preferences ▸ Appearance ▸ "Transcript pane (experimental)", ui-settings key `transcriptPane`, default off. It takes effect live on save. The view is only built for local desktop seats. Peer tabs and the web build never get one, and it activates only when the sidebar type is `claude`, so Codex and bash seats stay raw.

## Fixture matrix

Captures were made with `scripts/explore/capture-split.js`, which reuses the node-pty + `@xterm/headless` approach of t1120's `capture-cli.js`. The PTY was 40 rows at 60, 100 and 200 columns. The screens are in `test/fixtures/split-states/<state>@<cols>.screen.txt` and are pinned row by row in `test/live-split.test.js`.

- Permission states used `--permission-mode manual --setting-sources project`. This seat's user settings allow `Bash(*)`, so without dropping them no dialog appears.
- `bypass-idle` used `--permission-mode bypassPermissions` with the user settings, so its model line reads Fable.
- `streaming` was captured with `ANTHROPIC_BASE_URL` unset. Through this seat's wirescope route, the reply was filed to spill instead of streamed.

Each cell reads **anchor row / cursor-up excursion / highest row the cursor-up reached**. The excursion is the largest cumulative `CSI A` run between line feeds after the state's triggering input. "—" means no cursor-up happened in that window, because the screen had already settled.

| state | 60 cols | 100 cols | 200 cols | mode |
|---|---|---|---|---|
| idle | row 5 / 0 / — | row 5 / 0 / — | row 5 / 0 / — | split |
| bypass-idle (bypass footer) | row 5 / 0 / — | row 5 / 0 / — | row 5 / 0 / — | split |
| accept-edits-idle | row 26 / 3 / 28 | row 25 / 3 / 26 | row 25 / 3 / 26 | split |
| plan-idle (plan mode on) | row 26 / 0 / — | row 25 / 0 / — | row 25 / 0 / — | split |
| thinking (spinner, no text yet) | row 33 / 12 / 26 | row 30 / 9 / 25 | row 30 / 9 / 25 | split |
| streaming (prose mid-stream) | row 20 / 10 / 5 | row 15 / 8 / 5 | row 12 / 8 / 5 | split |
| tool-running (`sleep 15`) | row 12 / 10 / 5 | row 12 / 9 / 5 | row 12 / 9 / 5 | split |
| api-retry | not captured | row 9 / 7 / 5 | not captured | split |
| slash-menu | row 5 / 22 / 6 | row 5 / 22 / 6 | row 5 / 22 / 6 | split (H 22–23) |
| help (`/help`) | none / 24 / 5 | none / 23 / 5 | none / 23 / 5 | full |
| model (`/model`) | none / 23 / 8 | none / 23 / 8 | none / 23 / 8 | full |
| ctrl-o (detailed transcript) | none / 8 / 10 | none / 8 / 10 | none / 8 / 10 | full |
| trust (folder-trust prompt) | none / 0 / — | none / 0 / — | none / 0 / — | full |
| permission (Bash `touch`) | none / 12 / 11 | none / 10 / 11 | none / 9 / 11 | full |
| edit-diff (Edit permission) | none / 12 / 14 | none / 10 / 14 | none / 10 / 14 | full |
| plan-approve (exit plan mode) | none / 13 / −70 | none / 11 / −36 | none / 9 / −13 | full |

Fixture count: **15 per width at 60 and 200 columns, and 16 at 100** (api-retry). That is 46 in total, with 25 split and 21 full.

What the matrix shows:
- **Every dialog removes the composer.** It does not draw beside it. Permission, Edit diff, plan approval, trust, `/help`, `/model` and Ctrl-O each draw their own full-width rule, followed by a title row (` Bash command`, ` Edit file`, ` Ready to code?`, `  Help`, `  Select model`, `  Showing detailed transcript`) or by nothing. No rule in any of the 21 is followed by a `❯` row. The trust prompt's `❯ No, exit` sits 14 rows below its rule, and the numbered options' `❯ 1. Yes` is indented by one space. Neither reaches the composer rule.
- **The composer row varies**, and the existing rules already accept every variant seen:
  - `❯` + U+00A0 when empty.
  - A placeholder `❯ Try "…"` on a fresh seat.
  - A prompt suggestion `❯⍽Run this exact…`.
  - The interrupted prompt restored with a plain space.
  - `❯⍽/` with the slash menu open.
- **The cursor-up excursion cannot replace the anchor.**
  - Mid-turn, the CLI still repaints 7–12 rows, and the top of that repaint is **above** the rule (reach row 5 against anchor 12–20). The spinner and the live tool block sit there.
  - For the slash menu, the reach is the composer row itself (6), because the menu is drawn below.
  - For dialogs, the excursion (9–24) looks like mid-turn repaints (7–12) or slash menus (22), so it cannot tell a dialog apart.
  - It stays what §3 said it is: a measure of what the CLI is still editing.
- API retry was provoked once, with `ANTHROPIC_BASE_URL=http://127.0.0.1:9`, which shows `Connection refused — … · Retrying in 1s · attempt 2/10`. It was captured at 100 columns only, as the ticket allowed.

## Exit measurement (live session through the split)

`scripts/explore/split-live.js` is an Electron harness.
- It loads a real `@xterm/xterm` with **WebGL on**, fitted to a 1000×720 wrapper (132×48). It uses the repo's `styles.css` and the same `renderer/live-split-view.js` and `transcript-spike.js` that the app uses.
- It drives a real `claude` through node-pty in manual mode. Every keystroke goes in as a DOM input event through `webContents.sendInputEvent`.
- The pane reads the CLI's real transcript through a symlink, which stands in for `run/<name>/transcript.jsonl`.

Run 2 prompt: `Run seq 1 30, then run seq 1 12, then run date, then use the Edit tool to change alpha to beta in notes.txt, then run cat notes.txt.`

- **Lost keystrokes: 0 of 186.** The harness compared the PTY input it received with what it typed, after stripping xterm's own terminal-query replies, and they matched exactly. That covers the trust answer, the 167-character prompt, the Edit permission answer, and a 15-character probe typed after a mouse click **on the translated strip's composer row**. The click focused xterm's textarea, and the probe appeared on the composer row (`❯ Strip check 123`). This confirms that hit-testing and the IME textarea follow the transform with WebGL on.
  - Run 1 lowercased every capital letter. That was the harness: it sent `keyDown` without the shift modifier. It is fixed in run 2 and was not an xterm or strip effect.
- **The strip never hid a dialog.** Mode trace for run 2:
  - `split 10-13 … split 30-33` while the tools ran.
  - **`full`** when the Edit permission dialog was drawn, 16 ms after the last split frame.
  - `split 33-36` 283 ms after the answer: the 250 ms hold, plus the next write.
  - `split 37-40` when idle.
  - Both runs asked exactly one permission, the Edit. In this mode `seq`, `date`, `ls`, `wc` and `cat` ran without one.
- **What the strip did hide** while split: the rows between the transcript and the rule. These were the spinner (`✶ Nucleating… (4s · ↓ 176 tokens)`), the in-flight tool status (`⏺ Reading 2 files… / ⎿ $ wc -l notes.txt`), and at the end of the turn `✻ Churned for 14s`.
  - The naive pane shows each `tool_use` as soon as the transcript has it, but not the spinner or the elapsed time.
  - Nothing there needs an answer: `esc to interrupt` is in the footer, inside the strip.
  - The API-retry notice (`api-retry@100`) lives in the same row. That makes it the one real information loss, and the reason the pane needs the §3 working line.
- **The tab is FULL before the first prompt.** The CLI creates the transcript file only when the first message is sent, so until then the pull returns `unavailable`. That is the §7 behaviour: never an empty pane over a hidden screen.
- **Rows saved, tool-heavy turn (run 2): 13.** The CLI drew **19 rows** for the turn's six tool blocks:

  | block | rows |
  |---|---|
  | `Bash(seq 1 30)` | 5 |
  | `Bash(seq 1 12)` | 5 |
  | `Bash(date)` | 2 |
  | `Read 1 file` | 1 |
  | `Update(notes.txt)` with a 3-row diff | 5 |
  | `Read 1 file` | 1 |

  It also drew 5 blank separator rows. The pane drew **6 rows**, one per `tool_use`. So 19 − 6 = 13, or 18 if the separators count.
  - Run 1, `Run ls, then wc -l …, Edit, cat`, saved only 1 row. The CLI had already folded `ls`, `wc` and `cat` into two `Read … (ctrl+o to expand)` summary rows, so only the Edit block had rows to give back. This matches t1120's finding that the gain comes from Bash output and diffs, not from read-only tools.

## Not exercised

- The app's own wiring was not driven live. That covers the `createTerminal` call site, the preload/IPC path of `transcript:pull`, and the Preferences checkbox. It is covered by the api-contract, settings and free-identifier tests. The harness runs the same view module and reader, but not the app's window.
- `@` file completion, AskUserQuestion, MCP elicitation, a multi-row draft, and the `/tui fullscreen` renderer were not captured. The fullscreen renderer is on the alternate buffer, and the view declines that by buffer type.
- The spike leaks one `fs.watch` per Claude seat: `transcriptSpike` drops a watcher only when a pull finds the session gone or non-Claude, so a closed tab or a toggled-off pane keeps its watcher until the app quits.
