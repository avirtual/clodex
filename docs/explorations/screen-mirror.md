# Exploration: a hidden mirror terminal for a denser Claude CLI screen

Ticket t1120, 2026-09-24. CLI under test: `claude` 2.1.281 (`/Users/bogdan/.local/bin/claude`), classic (non-fullscreen) renderer.
Nothing in the app changed. Evidence lives in `test/fixtures/cli-captures/`, produced and read by three scripts in `scripts/explore/`.

## Verdict

**GO-WITH-LIMITS** for a same-size mirror. **NO-GO** for the taller hidden PTY.

The three facts that decide it:

1. **The byte stream is safe to model.** Across 11 captures the CLI never enters the alternate screen, never uses synchronized output, never
   sets a scroll region (DECSTBM only as a reset, at start and exit), never clears the display (`ED 2`/`ED 3`: 0), and never scrolls except by
   plain line feeds at the bottom. It redraws a bounded bottom region with relative cursor moves. No row above the cursor's reach ever
   changed (`rewritesAboveCursorReach` = 0 in every capture). So a headless xterm fed the same bytes is a faithful model, and a view rebuilt
   from that buffer on every frame had **0 consistency violations** over 14 replays: no duplicated rows, no out-of-order rows, no stale rows.
2. **The gain is real but bounded.** Each Bash block with truncated output gives back **4 rows** (header kept; `⎿` row, 2 preview rows and the
   `… +N lines` footer dropped). An untruncated 3-line block gives back 3. The CLI already folds read-only tools into one summary row
   (`Read 1 file, listed 1 directory (ctrl+o to expand)`, scenario e), so those give back nothing. The rows only become visible transcript once
   the session is longer than the view: g gained 4 rows of reach from 2 blocks. The short captures a–f gained 0, because nothing had scrolled off yet.
3. **The CLI's own scrollback is not clean after Ctrl-O, and the mirror promotes that damage onto the main screen.** In an overflowed session
   (g), Ctrl-O repaints the whole screen from `CUP 1;1`. The expanded transcript is taller than the screen, so partly-drawn rows scroll into
   scrollback, and the CLI never fixes them. A native terminal hides that damage in scrollback. A mirror that "walks further up the scrollback"
   pulls it into the main view: frame 78 of `g-overflow-ctrl-o.view40.frames` shows `31 32 33 34 35 22 23 …`, duplicated transcript.
   Fixing this needs the mirror to keep its own transcript log and stop taking in rows while verbose mode is on. It cannot just read xterm scrollback.

The mirror is worth building only with those limits: same size as the visible pane, the dynamic region worked out per frame, collapsing turned
off in verbose mode, and a mirror-owned transcript that ignores rows scrolled off during verbose mode. A taller PTY buys no transcript density.
The CLI does not grow its streaming region (it stays 9–10 rows), but it does size its menus to the hidden height: at 80 rows the slash
menu is 42 rows, and the composer row falls outside a 40-row view.

## Setup and capture method

- `npm install --no-save @xterm/headless`, then `node build/fix-pty-helper.js` (node-pty failed with `posix_spawnp` until the helper was chmodded).
- `scripts/explore/capture-cli.js [a b c … | a@80]` spawns the CLI with node-pty at 120x40, or at the height given after `@`. It runs in a scratch dir
  under the task dir with `--allowedTools "Bash(ls:*)" "Bash(wc:*)" "Bash(seq:*)"`. It watches the screen through its own headless
  xterm for the `❯` composer, types each prompt, then sends Enter 400 ms later. A step is done once the PTY has been quiet for 4 s after a prompt,
  or 2 s after a key. Each scenario is killed with SIGTERM. Output files:
  - `<scenario>.raw`: every PTY byte.
  - `<scenario>.events.jsonl`: `{t, bytes(base64)}` chunks, with `t` in ms since spawn, plus `{t, mark}` rows for each step (`spawn:WxH`,
    `prompt-ready`, `type:…`, `key:…`, `idle`, `resize:WxH`, `sigterm`). Replays use the marks to apply resizes at the right point.
  - `<scenario>.screen.txt`: the final screen.
- Environment: `process.env` plus `TERM=xterm-256color`, minus the variables that mark this seat's own session (`CLAUDECODE`, `CLAUDE_CODE_CHILD_SESSION`,
  `CLAUDE_CODE_SESSION_ID`, messaging socket/token, …). With `CLAUDE_CODE_CHILD_SESSION` inherited, the CLI shows a "transcript saving is off"
  warning row that an operator's session never shows. `CLAUDE_CONFIG_DIR` and `ANTHROPIC_BASE_URL` were kept so the CLI could authenticate.
- Startup screens the capture script handles itself:
  - Folder-trust dialog. In 2.1.281 the default choice is **"No, exit"**, so the script sends Down then Enter.
  - A one-time **"Try the new fullscreen renderer?"** offer. The script dismisses it with Esc, and it did not come back in later runs.
- By default the capture's headless xterm does **not** answer terminal queries (DA1 `CSI c`, XTVERSION `CSI >0q`, kitty `CSI ?u`).
  `CAPTURE_REPLIES=1` connects the headless terminal's replies back to the PTY. `a-seq-truncated-replies` shows the renderer behaves the same
  either way: only the kitty-keyboard counts differ (4 vs 1).

| file | scenario | size | bytes |
|---|---|---|---|
| a-seq-truncated | `run seq 1 30 and tell me the last number` | 120x40 | 10622 |
| a-seq-truncated-replies | same, terminal queries answered | 120x40 | 11018 |
| a-seq-truncated-rows60 / -rows80 | same, CLI spawned taller | 120x60 / 120x80 | 10996 / 11400 |
| b-ctrl-o-expand | a, then Ctrl-O, Ctrl-O | 120x40 | 14378 |
| c-slash-menu / -rows80 | `/`, then Esc | 120x40 / 120x80 | 4960 / 7448 |
| d-help | `/help`, then Esc | 120x40 | 5735 |
| e-three-tools | `run ls, then wc -l on package.json, then seq 1 5` | 120x40 | 18332 |
| f-resize-40-to-60 | a, resize to 120x60, `now run seq 1 3` | 120x40→60 | 28821 |
| g-overflow-ctrl-o | 40-line reply, then a second tool prompt, then Ctrl-O, Ctrl-O | 120x40 | 24078 |

Scenario g was added beyond the spec. None of a–f overflows the screen, so without g neither scrollback behaviour nor Ctrl-O on
scrolled-off content would have been exercised. Every scenario captured; none needed login.

## Byte analysis

Reproduce with `node scripts/explore/analyze-capture.js` (`--json` gives the full CSI/ESC/OSC histograms). The table is its output verbatim:

```
metric	a	aR	a60	a80	b	c	c80	d	e	f	g
size	120x40	120x40	120x60	120x80	120x40	120x40	120x80	120x40	120x40	120x40	120x40
bytes	10622	11018	10996	11400	14378	4960	7448	5735	18332	28821	24078
altScreen1049h	0	0	0	0	0	0	0	0	0	0	0
altScreen47h	0	0	0	0	0	0	0	0	0	0	0
sync2026h	0	0	0	0	0	0	0	0	0	0	0
cursorUp	81	89	89	97	89	26	46	26	183	375	161
maxCursorUpParam	10	10	10	10	11	22	42	22	10	10	39
maxCumulativeUpRun	10	10	10	10	11	22	42	22	10	10	39
cup	0	0	0	0	2	0	0	0	0	0	2
eraseLineK	19	19	18	19	66	38	78	36	28	36	101
eraseDisplayJ	0	0	0	0	0	0	0	0	0	0	0
ed2	0	0	0	0	0	0	0	0	0	0	0
ed3	0	0	0	0	0	0	0	0	0	0	0
decstbm	2	2	2	2	2	2	2	2	2	2	2
scrollUpS	0	0	0	0	0	0	0	0	0	0	0
escIndexD	0	0	0	0	0	0	0	0	0	0	0
escReverseIndexM	0	0	0	0	0	0	0	0	0	0	0
lineFeeds	556	595	596	634	753	274	470	247	1166	2066	1362
mouseOn	0	0	0	0	0	0	0	0	0	0	0
mouseOff	9	9	9	9	9	9	9	9	9	9	9
bracketedPasteOn	2	2	2	2	2	2	2	2	2	2	2
focusOn	2	2	2	2	2	2	2	2	2	2	2
kittyKbd	4	1	4	4	4	4	4	4	4	4	4
chunks	64	70	69	74	74	18	20	21	123	237	121
maxUpDepthFromBottom	9	9	9	9	39	21	41	18	9	9	39
maxRewriteDepthFromBottom	8	9	9	8	39	19	39	18	9	9	39
rewritesAboveCursorReach	0	0	0	0	0	0	0	0	0	0	0
finalScrollback	0	0	0	0	7	0	0	0	2	0	78
fullClears	0	0	0	0	0	0	0	0	0	0	0
maxCursorUp (deepest row any cursor-up reached, from the bottom of drawn content, across captures): 41
```

What the table shows:

- **Alternate screen:** never entered (`?1049h` / `?47h` / `?1047h` are all 0). The transcript lives in the normal buffer and its scrollback.
- **Synchronized output (`?2026h`):** never used, with or without query replies. Instead, each frame is bracketed by `?25l` … `?25h`
  (cursor hidden while drawing). The one exception is verbose mode, where the frame ends with the cursor still hidden. Frames get split across
  PTY chunks: 4–12 chunks per capture end in the middle of a frame (column `mid` in the mirror table).
- **How it redraws:** it is neither Ink's `eraseLines` pattern nor a full clear. It is a cell-diff renderer: it moves up by
  `CSI n A` (one move, n ≤ 10 while streaming), then walks the region with `CSI n B/C/D/G`, rewrites only changed text, and ends lines with `EL`.
  New transcript rows are written as `\r\r\n`. The only absolute positioning is `CSI H` (b and g, 2 each), when Ctrl-O toggles verbose mode off:
  home, then `EL`+`CUD` down all 40 rows, then home again and a full repaint of the screen.
- **Largest cursor-up (`maxCursorUp`):**
  - Streaming, tool calls and resize (a, e, f, at any PTY height): **9–10** rows. This is the spinner/status row, the composer box, and the
    in-progress block.
  - Slash menu and `/help`: **21–22** at 40 rows, **41–42** at 80 rows. The menu grows with the PTY height.
  - Ctrl-O verbose toggle: **39**, the full screen (`rows − 1`).
  - Across all captures: **41**.
- **Append-only above that reach: yes.** `rewritesAboveCursorReach` = 0. No row the cursor could not reach in that chunk ever changed.
  Scrollback is never rewritten, because the CLI has no way to reach it. The flip side is the Ctrl-O case: rows that scroll off during an
  expanded repaint are left as they are, torn (g, rows 13–39 of the final buffer).
- **How scrollback grows:** only by plain line feeds at the bottom row. `CSI S/T`, `ESC D/E/M` and scroll regions are all 0.
  DECSTBM appears twice per capture, both times as the reset `ESC 7 ESC [r ESC 8` (at start and on exit).
- **Other modes:**
  - Mouse tracking: never enabled. At exit the CLI sends 9 disables (`?1000l ?1002l ?1003l ?1006l ?1016l …`).
  - Bracketed paste `?2004h` and focus reporting `?1004h`: enabled.
  - Colour-scheme notifications: `?2031h`.
  - Keyboard: modifyOtherKeys reset `CSI >4m`, a kitty keyboard query and push/pop (`?u`, `<u`).
  - Queries: DA1 `CSI c` and XTVERSION `CSI >0q`.
  - OSC 0 window-title updates with a spinner glyph, several per turn.
- **Glyph:** the tool bullet is **U+23FA `⏺`**, not `●`. The `●` in the status row is the effort indicator.
- **Height-only resize (f, 40→60):** the CLI emits **nothing** in response. There is no redraw. It keeps drawing relative to where the cursor is.
  A width change was not captured.

## Mirror prototype

`node scripts/explore/mirror-view.js <capture> [--view V] [--rows R] [--dynamic N|auto] [--floor 10]` replays a capture with its timing marks
into `@xterm/headless` at the captured size. With `--rows` it uses a fixed height instead and ignores resize marks. It writes
`<capture>.view<V>[.rows<R>].frames` next to the capture. It rebuilds the view only at a frame boundary: when the cursor is visible again, or
when the next chunk is more than 8 ms away.

How the view is built:

- **Dynamic region `D`.** This is the bottom `D` rows of drawn content, passed through as they are.
  - `--dynamic auto` (the default) sets `D` = max(10, bottom − the highest row any `CUU`/`CUP` reached in the last 1.5 s + 1).
  - `D` is always at least large enough to include the cursor row.
  - A fixed `D` = 41 (the global `maxCursorUp`) would leave only 0 rows to collapse, so a per-frame `D` is required.
- **Above `D`, tool blocks collapse to their header row.** A tool block is `^⏺ Name(` or `^⏺ server - tool`, plus any wrapped header rows. The
  dropped rows are every following row that starts with `  ⎿` or five spaces, or is a wrapped continuation. The freed rows are filled by
  walking further up the buffer.
- **Collapsing turns off entirely** while the screen shows `Showing detailed transcript` (verbose mode).

Results: the table is regenerated by running the script per capture. In it, `mid` = chunks ending mid-frame, which were skipped; `viol` = frames
where a view row was duplicated, out of order, or differed from its buffer row; `gain` = how many more transcript rows the view reaches than
the native bottom-40 window.

| capture | headless | chunks | mid | frames | verbose frames | blocks | rows freed | gain | viol |
|---|---|---|---|---|---|---|---|---|---|
| a-seq-truncated | 120x40 | 64 | 4 | 42 | 0 | 1 | 4 | 0 | 0 |
| b-ctrl-o-expand | 120x40 | 74 | 7 | 47 | 1 | 1 | 4 | 0 | 0 |
| c-slash-menu | 120x40 | 18 | 5 | 6 | 0 | 0 | 0 | 0 | 0 |
| d-help | 120x40 | 21 | 6 | 8 | 0 | 0 | 0 | 0 | 0 |
| e-three-tools | 120x40 | 123 | 7 | 86 | 0 | 1 | 4 | 2 | 0 |
| f-resize-40-to-60 | 120x40→60 | 237 | 7 | 164 | 0 | 2 | 7 | 0 | 0 |
| g-overflow-ctrl-o | 120x40 | 121 | 12 | 81 | 1 | 2 | 8 | 4 | 0 |

- **Frame-to-frame consistency:** there were no torn rows, but only because of the frame gate. Without it, 4–12 chunks per capture would render
  a half-painted region (the CLI does not use `?2026`). The view never duplicates a buffer row. It **does** duplicate transcript when the buffer
  itself holds duplicates: g after the Ctrl-O round trip (fact 3). A buffer-level consistency check cannot catch that, and it is the main open problem.
- **Ctrl-O (b):** the expanded frame (frame 42) shows all 30 `seq` rows plus the `Showing detailed transcript` footer, not collapsed, because
  the verbose flag is detected. Toggling back gives a normal collapsed frame. Without verbose detection, the auto window would collapse the
  expanded block again 1.5 s after the toggle, and pressing Ctrl-O would appear to do nothing.
- **Menus (c, d):** the slash menu and `/help` fall inside the dynamic region (`D` = 22 while open) and show exactly as the CLI drew them. Their
  rows never match the tool-header pattern, so they would be safe even outside `D`.
- **Rows gained per tool block:**
  - a: 4 (`⎿ 1`, `2`, `3`, `… +27 lines`).
  - e: 4 for `Bash(seq 1 5)`. The CLI had already folded `ls` + `wc -l` into one summary row, so they gave nothing.
  - f: 4 + 3.
  - g: 4 + 4, which moved the top of the view 4 rows further back into the transcript.

## Taller hidden PTY

What was tested:

- The spec's replay: a and f replayed into headless terminals fixed at 120x60 and 120x80, building a 40-row view.
- Additionally, real captures with the CLI told the taller size (`a@60`, `a@80`, `c@80`). The replay alone cannot show what the CLI does with more rows, because the bytes were produced for 40.

| capture | headless | chunks | mid | frames | blocks | rows freed | gain | viol |
|---|---|---|---|---|---|---|---|---|
| a-seq-truncated (replay) | 120x60 fixed | 64 | 4 | 42 | 1 | 4 | 0 | 0 |
| a-seq-truncated (replay) | 120x80 fixed | 64 | 4 | 42 | 1 | 4 | 0 | 0 |
| f-resize-40-to-60 (replay) | 120x60 fixed | 237 | 7 | 164 | 2 | 7 | 0 | 0 |
| f-resize-40-to-60 (replay) | 120x80 fixed | 237 | 7 | 164 | 2 | 7 | 0 | 0 |
| a-seq-truncated-rows60 | 120x60 | 69 | 5 | 46 | 1 | 4 | 0 | 0 |
| a-seq-truncated-rows80 | 120x80 | 74 | 6 | 48 | 1 | 4 | 0 | 0 |
| c-slash-menu-rows80 | 120x80 | 20 | 7 | 6 | 0 | 0 | 0 | 0 |

- **Transcript or dynamic region?** In normal operation the extra rows go to the transcript only. The streaming reach stays at 9 rows at 40, 60 and 80.
  **Menus take them:** the slash menu is 22 rows at 40 and 42 rows at 80 (`c80`, `maxCursorUp` 41).
- **What breaks:** in `c-slash-menu-rows80.view40.frames` frame 3, the 42-row menu fills `D` = 42 > 40. The view keeps the bottom 40 rows,
  which cuts off the `❯ /` composer row and its rule. The operator cannot see what they are typing. Showing it would take a view that
  understands the menu's extent. That is CLI-layout knowledge the mirror should not depend on.
- **Resize (f):** a height-only resize triggered no redraw at all, and the mirror kept going with 0 violations. Replaying the 40-row stream into
  60 or 80 rows gives identical frames: the stream is relative-only apart from the Ctrl-O `CUP` home. With a taller PTY, fewer
  rows scroll off before Ctrl-O repaints, which would shrink the fact-3 damage. It is the only benefit found, and the menu clipping outweighs it.
- **Density:** none gained. The view is 40 rows either way, and the collapse gain is identical (same blocks, same rows freed).

## Cost (scenario e, 120x40, 40-row view, 123 chunks, 18 332 bytes)

| measure | mean | p50 | p95 | max |
|---|---|---|---|---|
| headless parse, awaited per chunk (`write` callback latency, dominated by xterm's async write scheduling) | 1.31 ms | 1.31 ms | 1.45 ms | 1.76 ms |
| headless parse, bulk (all chunks queued, one callback) | 0.024 ms/chunk (2.8 ms total) | | | |
| view build (collapse + slice, whole buffer walk) | 0.054 ms | 0.047 ms | 0.088 ms | 0.286 ms |

Parsing and building the view cost next to nothing at this size. The prototype's `collapse` walks the whole buffer from row 0 on every frame,
so its cost grows with scrollback. It was not measured on a 10k-row buffer. A real implementation should walk upward from the dynamic region
only until the view is full.

## CLI behaviours the approach depends on (pin each)

Each of these is read from a fixture by `analyze-capture.js` or `mirror-view.js`. A frozen fixture cannot notice a CLI upgrade, so the pin has
two parts:
- a unit test that asserts these numbers against the committed fixtures, which guards the analyser itself;
- an opt-in re-capture job (`capture-cli.js`, needs a logged-in CLI) whose output is asserted the same way on every CLI version bump.

| behaviour | fixture | expected |
|---|---|---|
| no alternate screen | all | `altScreen1049h` = 0, `altScreen47h` = 0 |
| no display clears | all | `ed2` = `ed3` = 0 |
| no scroll regions / scroll commands | all | `decstbm` = 2 (resets only), `scrollUpS` = `escIndexD` = `escReverseIndexM` = 0 |
| no row above cursor reach is rewritten | all | `rewritesAboveCursorReach` = 0 |
| streaming reach bounded | a, e, f | `maxUpDepthFromBottom` ≤ 10 |
| frames bracketed by `?25l`/`?25h` (no `?2026`) | all | `sync2026h` = 0. If a future CLI adopts `?2026`, the frame gate should switch to it. |
| tool block shape | a, e | header `^⏺ Name(`, `  ⎿` first output row, 5-space continuation, `… +N lines (ctrl+o to expand)` footer |
| verbose-mode marker | b, g | a screen row contains `Showing detailed transcript` |
| Ctrl-O collapse repaint uses `CUP` home | b, g | `cup` = 2 |
| height-only resize → no output | f | no data chunk between `resize:120x60` and the next input |
| read-only tools pre-folded by the CLI | e | `Read 1 file, listed 1 directory (ctrl+o to expand)` row |

## Shape of a real implementation

- **Model:** a per-session `@xterm/headless` terminal in the renderer (or a worker), fed the same PTY bytes the visible xterm gets today, at the
  PTY's own size. It must also be the **one** terminal that answers the CLI's queries (DA1, XTVERSION, kitty `?u`, focus). Today the visible
  xterm answers them. If both answered, the CLI would get duplicate replies.
- **Transcript log owned by the mirror:** rows are appended as they scroll out of the headless screen, except while verbose mode is on (fact 3).
  The view is drawn from this log plus the live screen, not from xterm scrollback.
- **View pane:** keep a visible `@xterm/xterm` of the pane's size, but feed it ourselves. On each frame boundary, diff the view rows against the
  last frame and write only the changed rows as `CUP row;1` + SGR-serialised cells + `EL`, then place the cursor at the mapped composer
  position. This keeps the WebGL renderer, the link provider and search. DOM rows would lose all of them. The mirror then owns what native
  scrollback gave for free: the pane's scrollback becomes the collapsed transcript, so selection and copy need care. A header row could also be
  made clickable to expand one block, which the CLI cannot do.
- **Modules:**
  - new `renderer/lib/screen-mirror.js`, holding the model, the frame gate, the dynamic region, collapse and diff;
  - `renderer.js`, for the terminal wiring (write path, `onData` query replies, resize to both terminals);
  - no main-process change, since the PTY keeps its current size.
- **Opt-in toggle per session.** Also handle the CLI's own fullscreen renderer: once the operator accepts it (the CLI already offers it), the
  alt screen is in play and this analysis no longer holds. The mirror should detect `?1049h` and step aside.

## Not captured / caveats

- No width resize, no mid-stream Ctrl-O (only after a turn finished), no permission dialog, no Esc-interrupt, no multi-screen tool output that
  the CLI streams while running.
- Every run went through this seat's `ANTHROPIC_BASE_URL` and `CLAUDE_CONFIG_DIR` (the `opsguru` account). Side effects on that account: the
  scratch dir is now a trusted folder, the fullscreen-renderer offer was dismissed once, and about 12 short sessions exist.
- Frames files were written for every run. The committed ones are listed in the ticket report; the rest can be regenerated with the commands above.
