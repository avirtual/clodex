# Changelog

Notable changes per release, written for people running Clodex rather than
reading its diffs. Starts here — earlier releases are described only by their
GitHub release notes, which were generated from commit subjects.

Keep `Unreleased` current as work lands. `scripts/release.sh` publishes it
verbatim as the release notes, then stamps it with the version and date and
opens a fresh empty one — so anything missing from it is missing from the
release. Text after `## Unreleased —` becomes the release subtitle. An empty or
absent `Unreleased` falls back to auto-generated commit subjects, so this never
blocks a release.

## Unreleased

- **A new Console tab in the bottom drawer shows what a seat's Bash tool actually
  ran.** The CLI renders its own Bash calls as a few scattered truncated lines;
  this shows one block per call with the full command and its complete output
  (stdout and stderr interleaved as they happened), how long it took, and — the
  part the CLI's inline view hides hardest — the exit code and error text of the
  commands that FAILED. Per-seat like the Terminal tab: each agent shows its own,
  and switching sessions switches the content. The tab appears only for Claude
  seats, since that is where the data comes from, and only in the desktop app —
  the browser surface cannot serve it.
  Output arrives at completion, not as it streams, so a long-running command
  shows nothing until it finishes. When the CLI truncates a very large result the
  block says so and reports the full size. Parallel Bash calls are all captured
  intact — each is recorded as its own file, so concurrent calls cannot overwrite
  or splice each other. If a seat runs more calls than one refresh can carry, the
  pane marks how many it skipped rather than dropping them silently.

## 5.25.0 — 2026-09-03

- **Low-contrast terminal output is now floored at a readable ratio.** The CLI
  paints its assistant-row bullet in pure black, which on the dark themes sat at
  1.23:1 against the background — a hole where the bullet should be. xterm now
  lifts any foreground that falls below 4.5:1 against the cell it sits on, so
  dim greys and near-invisible glyphs stay legible without changing anything a
  program painted with adequate contrast. Box-drawing characters are exempt, so
  TUI borders keep their colours.
- **Escape now closes the Discover Sessions, Peers, Plugins and Sandbox
  dialogs**, matching New Session, Preferences and Edit Session. Discover was
  the case that surfaced this: Escape did nothing at all and the only ways out
  were Cancel and the X. As before, Escape acts only when a single dialog is
  open — with a second surface raised over one, it closes neither. A drag that
  starts inside the Discover panel and releases outside it no longer dismisses
  the dialog.
- **Intents on the CLI's own bullet rows are highlighted.** The
  highlighter strips the decorator glyphs Claude Code paints ahead of a rendered
  line before it looks for `[agent:…]`, but its list held `⬤` where the CLI
  actually emits `⏺` — a lookalike that was never checked against real output.
  Every intent the CLI rendered under its bullet went unmarked, though it still
  fired. The prompt-echo rows that start with `❯` stay unmarked deliberately:
  that row is the composer, so marking it would light up an intent you were
  still typing.
- **The CLI's prompt echo now follows your theme instead of being a white slab.**
  Claude Code paints every submitted prompt on a light grey background, which on
  the dark themes is a bright slab across the scrollback — worst with heavy
  agent-to-agent messaging, where every injected dm is one. Each theme now
  carries its own echo colours, tinted a step off the terminal background so the
  block still reads as a block. Two limits worth knowing: the recolour happens as
  output arrives, so rows already in the scrollback keep the colours they were
  written with when you switch themes (a restored session is replayed, so those
  do follow); and if a future CLI release changes its echo colours, the recolour
  silently stops and the slab returns.

## 5.24.0 — 2026-09-03

- **Escape now closes the New Session, Preferences and Edit Session dialogs**,
  as does a press on the dimmed area around them. Previously only Cancel or the
  ✕ would do it, which read as the app being stuck. A dialog with a second box
  open on top of it stays put until that box is dismissed.

- **The ⚙ session menu's popovers sometimes took two or three clicks to
  appear.** Picking Tools, Skills, Agents or Intents opened the panel above the
  top of the window, where you could not see it — so the next click closed the
  invisible panel and only the one after that opened it for real. The status
  bar rebuilds itself whenever new numbers arrive, which replaces the ⚙ button
  the panel was measuring itself against; it now measures against the button
  that is actually on screen when you pick. The context breakdown had the same
  fault while its data was loading, and every one of these panels is now kept
  inside the window even when its anchor is gone.

- **A peer's sessions and info panels could open off the top of the window.**
  Both are anchored to a peer header in the sidebar, so a peer sitting high in
  the list opened its panel above the top edge, out of reach. They are now kept
  inside the window like the status bar's panels.

- **Clicking the context, cost or cache-bust segment on the status bar
  occasionally did nothing.** The bar redraws itself whenever new proxy or
  context numbers arrive, and a redraw that landed in the middle of a press
  threw the click away — the segment you pressed no longer existed by the time
  you released the button. The three popovers now open on the press itself, so
  a redraw can no longer swallow the gesture. The wirescope link still opens on
  release, where it belongs.

- **Codex sessions no longer mistake Clodex's own hook file for your
  `.codex/hooks.json`.** Clodex writes its hook config into your project's
  `.codex/hooks.json`, moving any file already there to a `.wb-wrap-backup`
  slot it restores on exit. If a quit skipped that restore, the next launch
  found Clodex's own hook file sitting there and backed *it* up as if it were
  yours — a later cleanup would then "restore" Clodex's hook as your config and
  leave it there for good. Your own config was never overwritten or deleted;
  only the backup slot was ever written. Setup now refuses to back up a file
  that holds Clodex's own bytes, and clears a backup slot already poisoned that
  way, so cleanup removes the hook instead of enshrining it.

- **Restored background tabs no longer come back garbled.** After a relaunch,
  every restored tab except the one that opened focused replayed its buffered
  output into a terminal still sized at 80x24, while the agent behind it was
  running at the real window size. Wrapped text sorted itself out when you
  clicked the tab; a redraw that positions its own cursor — which the Claude
  composer does — did not, so the tab stayed scrambled until the CLI next
  repainted it. Each restored terminal is now measured before its output is
  replayed into it.

- **Cmd+W no longer archives the session hidden behind a dialog.** With
  Preferences, Edit Session, Peers, Plugins, Sandbox, a prompt/agent/skill/exec
  editor, a plugin's own window, or a name-entry box like Save as Template or
  Create Team open, Cmd+W went straight past it and archived whatever session was
  behind it — only the New Session dialog was ever consulted. In the browser
  frontend the same was true of every confirmation and file box. The other window chords read
  that same single dialog, so they shared the cause without sharing the symptom:
  Cmd+T opened a second dialog on top of the one already up, and Cmd+1..9, Cmd+F
  and the cycle chords switched or searched the terminal underneath. The browser
  frontend's Alt equivalents behaved the same way. Every chord now checks every
  overlay: with a dialog open they do nothing, and Cmd+W still closes the New
  Session dialog when that is the only thing open.

- **The sessions.json backup now holds the state from before the app started,
  not from one write ago.** The `.bak` beside your session list used to be
  refreshed on every single field write — so a build that dropped or emptied
  your sessions had copied the damage into the backup within seconds, and the
  backup was inert against exactly the "an upgrade killed my agents" case it
  existed for. It is now written once per launch, from the file as it was found,
  and never refreshed while the app runs. It is also cheaper: a read, a parse
  and two disk syncs once per launch instead of on every field write as agents
  work.

- **A peer DM claim that fails on the wire now says so.** Mail is pulled from a
  peer by a claim that removes the messages from the far box's store before it
  answers, so a crash or a dropped connection mid-answer loses the batch — and
  the receiving end used to discard the error without a word, while the sender
  had already seen its send succeed. A failed claim now shows a line on the IPC
  log against that peer, rate-limited to once a minute so a peer that is down
  does not bury the log.

- **`task start` no longer says a seat holds a ticket that reached nobody.**
  Dispatching to a role with no live seat records the miss on the ticket. A
  later `start` reports that no live seat holds it and points at `assign`,
  instead of naming the role as a holder and offering to re-send a spec that was
  never sent.

- **`task start`, `task park` and `task respec` no longer hand back an `assign`
  command that bounces.** Each suggested the ticket's recorded role or, failing
  that, its assignee — but a ticket addressed to a seat NAME carries no role, so
  the suggestion named a seat that had since died, and a role key removed from
  the team since the ticket was filed named a role that no longer exists.
  `assign` refused both. Each of those replies now names a target only when
  `assign` would accept it, and otherwise says `<role|name>` rather than
  pointing at a command that cannot work.

- **The workbench Files tree now shows each file's size**, right-aligned on its
  row, with the last-modified date in the row's tooltip. A file whose size
  cannot be read shows nothing rather than `0 B`, so an unreadable file and a
  genuinely empty one stay tellable apart. Folders show neither.

## 5.23.0 — 2026-09-02

- **A command an agent runs in a workbench terminal can no longer lose its first
  character and run as something else.** Under load, a command sent to a drawer
  terminal could arrive with its leading byte missing — `echo a; echo b` reaching
  the shell as `cho a; echo b` — and the truncated remainder still ran, so a
  *different* command executed and reported its result. Measured at 32 concurrent
  shells, 16 of 320 commands were corrupted this way. Clodex interrupts the
  shell's current line before typing the command, and the loss happened whenever
  it typed into a shell that had not yet acknowledged that interrupt; it now
  re-sends the interrupt to draw out the acknowledgement rather than typing
  blind. Same load, after: 0 of 320.

- **What a ticket's code reviews cost is now recorded, and survives the reviewer
  being cleaned up.** Reviewer seats are discarded the moment they report a
  verdict, and the record discarded with them was the only thing linking a review
  to the money it spent — the spend itself was kept, but with nothing on it
  naming the ticket, the round or the reviewer, so it could not be added up. Each
  review round now appends a line to `REVIEW-COST.jsonl` in the ticket's own task
  directory as the review round ends, carrying that round's cost, tokens, cached
  fraction, verdict and must-fix count — including a round that ends without a
  verdict at all, because the lead rejected, accepted or retired it by hand.
  Rounds accumulate rather than overwrite, and a round whose cost genuinely could
  not be read is written as unknown rather than as zero, so an expensive review
  can never be mistaken for a free one.
  Applies to reviews from here on; past reviews cannot be reconstructed.

- **Agents are no longer told a message was swallowed by a seat that plainly
  read it.** The "your message was written into its terminal 90s ago and it has
  not started a turn since" notice fired whenever Clodex had not *observed* the
  receiving seat start a turn — which is not the same as the seat not having
  read the message, because that signal can arrive after the CLI has already
  recorded the turn. Seats that had read a message and replied at length were
  reported anyway, increasingly often. The check now looks at the receiving
  seat's own transcript before reporting, and stays quiet if the seat
  demonstrably consumed input after the message was written. A seat that really
  did swallow one is reported exactly as before, and so is a seat whose
  transcript cannot be read — the check can only ever withdraw a report, never
  invent one. This mattered beyond noise: the notice tells the sender to resend
  with `urgent`, which lands immediately into a seat that may be mid-turn, where
  concurrent writes overwrite one another's unsubmitted text.

## 5.22.0 — 2026-09-02

- **Agents are told their context is heavy at 175,000 tokens, and you can now
  change that.** The threshold had been raised to 200,000 so that seats spawned
  for a single ticket would not be nudged mid-task — but those seats are never
  nudged at any threshold, by a separate rule, so the raise only pushed
  long-running sessions deeper before they were told anything. The nudge now
  arrives 25,000 tokens earlier, and the sterner second warning sits at 225,000.
  Both numbers are editable in Settings ▸ Traffic optimization and persist across
  restarts. Models can also be given thresholds of their own, which is
  groundwork: none differs today.

- **Bundled wirescope updated to v0.6.58, which retires the compact-cache
  strip.** The proxy used to drop the cache marker from a compaction request
  when it judged the session cold, on the theory that re-caching a summary you
  will not reuse is waste. Measured over 14 days it lost money: the judgement
  was wrong 60 times out of 87, and each wrong call re-sent about 175k tokens
  of history at full price instead of a tenth of it — a net loss of roughly $42.
  The cause is structural rather than a threshold worth tuning, so the strip is
  now off in code and the environment variable that enabled it is ignored.
  Clodex no longer sets that variable. **A proxy already running keeps the old
  behaviour until Clodex is restarted.**

- **A typed message is no longer labelled as dictated.** Clodex tells the
  receiving agent when a message came out of a microphone, so it can read a
  garbled word for intent instead of taking it literally. That marker is armed
  just before the Enter that submits the dictated text — but if the submit then
  stood down (a permission dialog opened, the composer no longer held the
  draft, or you started typing), the marker was left armed and the next message
  you typed inherited it. The agent was then told your carefully typed text
  might be a mis-transcription. The marker is now withdrawn on every path that
  abandons a submit; its expiry is only a backstop for a withdrawal that never
  reached the proxy.

- **Cost reporting corrected for Fable 5.1 and Sonnet 5.** v5.21.0 updated the
  bundled wirescope table, but Clodex's own pricing is a port of it rather than
  a copy, so the two corrections never reached the numbers you see. Fable 5.1
  cached reads were costed 4x over (its read rate is a quarter of Fable 5's,
  and 5.1 traffic was being priced by the Fable 5 row), and every Sonnet 5
  receipt was costed 1.5x over from 2026-09-01 by a rate rise that was
  announced and then withdrawn. Both are now right; nothing else repriced.

## 5.21.0 — 2026-09-02

- **Bundled wirescope updated to v0.6.57**, which corrects two prices in its own
  table. Fable 5.1 breaks the cached-read multiplier every other model follows,
  so its reads were being costed at four times the real rate; and a rate rise
  for Sonnet 5 that was announced, dated and then withdrawn had been left in
  place, overstating every Sonnet 5 receipt by half again. Both are estimation
  only — nobody was charged anything, but the cost figures Clodex showed for
  those models were wrong. It also reads usage off a non-streaming response,
  which previously went uncounted.

- **A dictated message ending in the trigger phrase is sent again.** On the tap
  path the trigger key stopped the recorder but submitted nothing, so a spoken
  phrase was erased and the message left sitting in the composer. The CLI's own
  auto-submit cannot cover it: that submit is disabled the moment we erase the
  trigger phrase out of the draft, which we must do or the phrase ships inside
  the message. Clodex now sends the Enter itself, once the CLI has finished
  transcribing — and stands down if a permission dialog opened while it waited,
  if the composer no longer holds the draft, or if you start typing while it
  waits, which leaves the message one Enter from sent rather than submitting a
  correction mid-sentence. A transcription that never finishes sends after eight
  seconds rather than stranding the message.

- **A voice tap no longer disappears when the composer read fails.** The external
  ensure-on tap — the Voice Control wake word and `scripts/clodex-voice-tap.js`
  — read the composer through a call that could throw, and on the immediate path
  that throw escaped into the renderer's tap handler unguarded: the tap was lost
  and every check after it was skipped, silently. It now declines the way the
  deferred path already did, and says so in the console. A failure to write the
  key itself is still reported, not swallowed.

- **Clodex can see the recorder again — every voice gate that reads it has been
  answering "not recording" while the mic was live.** The check looked for the
  CLI's indicator with no space between the dot and `REC`, but the CLI paints
  `⏺ REC · tap to send`, with a space. Nothing matched, ever. The voice popover
  reported "Not recording" during a real recording, the automatic re-arm read the
  mic as dark, and the click-to-stop declined. The check now matches what the CLI
  actually paints, and it still ignores ordinary tool output that merely starts
  with those letters, so a lit reading means a lit recorder.

- **"Cannot read the screen" now says WHY.** The voice popover's unreadable
  reading covered three different situations with one sentence: a full-screen
  program legitimately covering the composer, and two separate ways the screen
  read can break. The first is normal and clears itself; the other two mean the
  feature is dead until you restart the session, and there was no way to tell
  which one you had. The reading now carries the cause in its tooltip, and the
  scripted voice tap — which fails at the same read, writing nothing and saying
  nothing — logs the cause to the console instead of declining silently. What
  Clodex will and will not write is unchanged.

- **Hands-free voice submit now ends the recording as it sends, instead of
  leaving the mic lit.** When you finish a spoken message with the submit
  phrase, Clodex sends it with your push-to-talk key rather than a plain Enter.
  The CLI treats that key as send-and-stop in one go, so the recording
  indicator goes out immediately. Enter alone never stopped it — the mic stayed
  lit for the rest of its 15-second silence timeout, and the follow-up tap that
  was supposed to clear it read the screen too late and usually declined,
  silently. Typing the phrase rather than speaking it still submits with Enter:
  with the mic dark that key would switch it ON, which is the one thing this
  must never do.

- **Truncated previews now end in `…`, so a cut line stops reading as a whole
  one.** `[agent:remind list]`, `[agent:memory list]`, the memory index and
  `notify-user`'s notification all shorten a long body to fit their column, and
  they used to cut it with no mark at all. A reminder whose body named a file
  showed up as a row ending at a directory — a fragment that still read as a
  complete, sensible instruction, so there was nothing to tell you the rest had
  been cut. The mark is spent inside each readout's width rather than added on
  top, so nothing got wider.

- **`scripts/release.sh --quiet` prints milestones and nothing else.** A release
  run through an agent's monitor sent back every line the script printed as a
  separate message — the notes preview alone, a changelog you had just written,
  came back as fourteen of them. With `--quiet` you get the version and tag, the
  DMG, the push, the release URL and the image result; the electron and renderer
  smokes, the build, the prune and the publish go to a log file whose path is
  printed at the start and again on any failure. The log sits outside `dist/`, so
  it survives the build step that empties it and is still there to read when the
  build is what broke. A non-empty `CI` turns it on by itself.

## 5.20.0 — 2026-09-01 — Talking to your agents

- **Moving the microphone now stops the recorder it moved away from.** Saying
  `select` while a seat was recording switched you to the named seat but left
  the old one listening in the window you had just left — up to about fifteen
  seconds of the room going to the CLI before it timed out on its own, with
  nothing on screen to tell you. The seat that loses the microphone is now
  stopped as it loses it. It cannot always manage it: a seat with un-sent
  text already in its composer keeps recording, because the key that stops the
  recorder also sends whatever is sitting there, and sending a half-written
  message to an agent you just walked away from is the worse of the two. That
  one still runs out on the CLI's own timeout.

- **Only the seat you are working with speaks its replies.** With spoken
  replies on, every agent finishing a turn narrated it, so a few background
  agents ending near each other produced a chorus — and since a new reply cuts
  off the one playing rather than waiting behind it, you heard the first few
  words of several and none of them whole. Now only the seat holding the
  microphone speaks, falling back to the seat you are looking at when no seat
  holds it; when neither is set, nothing speaks.

- **The spoken tap now works whatever voice mode you left the CLI in.** In
  `hold` it used to start a recording that stopped itself before you could
  speak, so you had to say `mode tap` first and tap again — two phrases, and no
  way to see from across the room which mode you were in. The tap sets the mode
  itself now and waits for the CLI to notice before sending the key. It does not
  put the mode back afterwards: `mode hold` is still how you stand it down.

- **`clodex-voice-tap` now takes named actions, not just a seat.**
  `clodex-voice-tap.js select <seat>` switches to that seat — always bringing
  its workspace window to the front, including when Clodex is already the app
  you are looking at and the seat lives in another workspace window — and then
  opens the microphone on it, so a spoken phrase can move you to an agent you
  cannot currently see instead of dictating into whichever tab happened to be
  open.
  `clodex-voice-tap.js mode tap|hold` switches the CLI's push-to-talk mode for
  the box, which previously meant editing settings by hand.
  `clodex-voice-tap.js speech on|off` turns spoken replies on or off
  for the box, so you can ask for narration from across the room instead of
  walking to the voice popover — always explicit, never a toggle, so repeating
  it is safe when you cannot see the current state. A name that matches no live
  seat — or an empty one, which is what an unset variable in a shortcut looks
  like — does nothing at all rather than falling back to the seat you were on.
  Existing shortcuts are unaffected: `clodex-voice-tap.js` and
  `clodex-voice-tap.js <seat>` behave exactly as before, including for a seat
  named `tap`, `select`, `mode` or `speech`.

- **The voice-mode picker works with no agent running.** Both places you can
  set the mode — the Voice row in Settings and the 🎤 button on the session bar
  — used to change it by typing `/voice <mode>` into one of your Claude
  sessions, so with none running they refused: the row was greyed out and the
  popover's rows could not be picked, on a setting that is box-wide and lives in
  a file you can write with nothing open at all. They now write that file
  directly, like `clodex-voice-tap mode` already did. Three things follow. The
  picker works with zero sessions open. A pick made while an agent is mid-turn
  applies immediately, instead of waiting for it to be between turns. And
  nothing is typed into your agents any more — choosing a mode used to leave a
  `/voice` command sitting in whichever session Clodex picked. Clodex no longer
  checks what the CLI checks before recording — an account that can stream
  voice, a recording tool, microphone permission — so a mode can now be stored
  on a box that cannot record; the CLI still checks all of it when recording
  actually starts, and says so then.

- **The microphone opens only when Clodex is in front.** With Clodex in the
  background — a browser over it, a video playing — an agent finishing a turn
  re-armed the recorder, and the audio in the room was transcribed into its
  composer as several turns of nonsense the agent then acted on. Nothing arms
  the recorder now unless Clodex is the frontmost application. There is no
  exception and no setting: a "listen from the background" switch is the same
  hole behind a checkbox. An external `clodex-voice-tap` still works with
  another app in front — it brings Clodex forward first and then listens,
  since naming a seat out loud is the act that makes listening intended.

- **Your speech goes to exactly one agent.** Dictating to one session while a
  different one — in a different workspace window — finished a turn left both
  recorders live, and the words went into both composers. If the phrase you
  spoke happened to end in your submit trigger, the background agent was
  *sent* a turn you never addressed to it, and acted on it. The microphone now
  has a single target box-wide: the seat you are looking at, or the one an
  external `clodex-voice-tap <name>` names. An agent finishing a turn can
  re-arm the recorder only if it already holds the microphone, so it can never
  take it from the seat you are talking to.

- **Spoken replies no longer talk into their own microphone.** With both
  "speak the final reply aloud" and the tap-mode re-arm switched on, the two
  fired on the same turn-end edge — so the recorder came back to life just as
  the narration started, and the reply Clodex was reading out was transcribed
  straight back into the composer. The re-arm now waits for the narration to
  finish before it presses the push-to-talk key. Tapping the microphone
  yourself mid-narration still stops the speech, and the re-arm stays out of
  the way afterwards rather than stopping the recording you just started. With
  speech switched off nothing changed at all.
- **Speech speed is yours to pick, and long replies are read to the end.**
  `say`'s default 175 wpm dragged; the new default is 210, with 150/175/240
  also offered. The point at which a reply is cut short doubled to 700
  characters, so a real answer is read out rather than a sentence or two of it.
- **The speech settings are in Settings now**, under Voice — the same
  checkbox, voice and speed the &#127908; button in the session bar carries,
  reading and writing the same values rather than a second copy.

- **See whether Clodex can actually tell the recorder is running — and stop it
  with a click.** The `⏺REC` on screen is painted by the Claude CLI, not by
  Clodex, so it says nothing about whether Clodex itself can see it; every voice
  gate depends on Clodex reading that indicator off the screen, and when the
  read fails nothing tells you. The voice popover now shows Clodex's own
  reading, from the same check the gates use rather than a second opinion: it
  distinguishes recording, the CLI's brief processing window, and — the one that
  was invisible before — "cannot read the screen", which quietly blocks the
  automatic re-arm. Clicking it while recording stops the recorder; in any other
  state it declines and writes nothing, since a keystroke sent then would arm a
  microphone you just asked to switch off.

- **Hear the reply from across the room.** Clodex can now read the agent's final
  reply aloud when a turn ends. Off by default; turn it on in the voice popover
  on the session bar, where the dictation mode already lives. **The speech is
  synthesized locally by macOS `say` — no audio and no text leaves the machine**,
  unlike dictation, which streams your microphone upstream to be transcribed.
  Only the final reply is spoken: never tool output, never a diff, never the
  intermediate chatter between tool calls. Code blocks, file paths, URLs, tables
  and markdown syntax are stripped before anything is spoken (a path read out
  character by character is unbearable), and a long reply is cut at a sentence
  end rather than narrated for minutes. The default voice is Daniel (en_GB),
  picked for being the clearest at a distance; any other installed voice can be
  chosen from the same popover, and voices you have not installed fall back to
  the system default rather than failing. It will not start talking while your
  microphone is live, and if you tap the mic while it is talking it stops
  immediately so you are not spoken over.

- **Start dictating from an outside script, without the keystroke going to the
  wrong app.** macOS Voice Control can already tap the recorder by pressing
  space, but a keystroke lands wherever the frontmost window happens to be, so
  the space went into someone else's document whenever Clodex was in the
  background. `scripts/clodex-voice-tap.js` asks Clodex directly instead: run it
  from a Voice Control command (via a shortcut), and it reaches the seat you are
  looking at whatever has focus. Pass a seat name to aim it somewhere else. It
  only ever turns recording ON — asking twice is harmless — and it declines
  rather than risk interrupting: if the recorder is already running, if there is
  a draft in the composer, if a permission dialog is open, or if it cannot read
  the seat's screen to tell, it writes nothing. It talks over Clodex's existing
  local socket, so it needs no new setting and stays reachable only by you.

- **A message from another agent no longer cuts you off while you are
  dictating.** Clodex holds an incoming message back while you are typing,
  because delivering one clears whatever is half-written in the composer. That
  protection never covered SPEAKING: dictated words are transcribed by the CLI
  straight into its own composer without passing through Clodex, so a seat you
  were talking into looked completely idle, and a message arriving mid-sentence
  truncated it mid-word. Clodex now also waits while the CLI's recording
  indicator is lit, on whichever seat is in front of you — whether or not
  hands-free submit is switched on. The existing five-minute cap still applies,
  so a recorder that gets stuck lit cannot hold your messages indefinitely.

- **And it no longer cuts you off while you are re-reading what you dictated.**
  The recording indicator goes out the moment you stop talking, which is exactly
  when you start reading the transcription back before sending it — so the
  protection above expired seconds into the window you were most exposed in. A
  message arriving while a long dictated draft sat in the composer still ate it.
  Clodex now recognises a dictated draft that is still sitting unsent and holds
  the message back the same way it already does for a draft you TYPED: the
  message waits on disk and arrives with your next turn, so nothing is delayed
  once you send. It releases as soon as the composer is empty or Clodex stops
  being able to see it, and the same five-minute cap bounds it regardless.

- **The microphone comes back on its own after a hands-free submit.** When the
  model answered quickly, the CLI left its recorder running after Clodex sent
  your message, and Clodex would not re-arm the microphone while it looked like
  you were still talking. You had to tap the key by hand. Clodex
  now stops that leftover recorder itself, immediately after sending, which is
  safe precisely there: you have just finished saying the trigger phrase, so
  there is nothing left to cut off. The usual re-arm then taps it back.

- **Fixed a case that could leave the microphone permanently stuck.** For about
  half a second after a recording stops, the CLI shows `Voice: processing…`
  while it finishes transcribing. Clodex read that as "not recording" and could
  tap the microphone key in that window — and in that state the key is not
  swallowed, so it landed in your input as a stray character. Your composer was
  then no longer empty, which is the one thing that stops the microphone being
  re-armed: it never came back until you cleared the stray character by hand.
  That state now blocks the re-arm.

- **Hands-free submit now fires while tap recording is still on.** It used to
  wait for you to untap before sending, which defeats the point of hands-free:
  Clodex waits for the composer to go quiet before submitting, and the audio
  level meter the CLI animates while the microphone is live counted as activity,
  so the wait never ended. It now watches what you have actually dictated rather
  than every repaint of the screen. The wait itself is unchanged — a phrase that
  lands mid-sentence still waits for you to finish talking.

- **A spoken message now tells the agent it was spoken.** Speech-to-text does
  not always produce what you said — a dictated "over and out" arrived once as
  "call where not" — and the agent reading it had no way to tell, so it took the
  garbled words literally. A hands-free submit now carries a marker saying the
  text was transcribed, so the agent reads for intent and asks when a word does
  not fit instead of guessing. The marker is attached only when Clodex actually
  saw you dictating for THIS message: a typed message that happens to end in the
  trigger phrase is not marked, and neither is one you type while the recorder
  happens to be listening. It needs traffic optimization on, expires in seconds,
  and never enters the conversation history.

- **Hands-free submit no longer re-sends what you already said.** With macOS
  dictation, the second and every later submit in one dictation session sent the
  whole session over again — your first sentence, its trigger word still in it,
  with the new sentence tacked on the end. macOS keeps its own record of
  everything dictated since you started and hands it back in full each time, and
  Clodex was reading that record rather than just the new words. It now keeps
  track of what it has already sent and submits only what you have said since.
  If dictation goes back and rewrites something it transcribed earlier, Clodex
  stops submitting rather than risk sending a sentence twice; leave it idle
  for a minute or two to start fresh. If you ever do see it resend something
  you already sent, and it did NOT follow a long pause, that is worth
  reporting — it means the tracking was dropped by something other than the
  idle timer.

- **Dictation can now submit for you when you say a phrase.** The Claude CLI
  only auto-submits when the last chunk of transcribed speech runs to three
  words or more, so trailing off at the end of a thought leaves the whole
  sentence sitting in the composer waiting for a keypress — which rather defeats
  talking to it. Preferences ▸ Voice input has a new **Hands-free submit**
  switch: end what you are saying with a phrase (`over and out` by default,
  editable) and Clodex erases the phrase and presses Enter. It matches at the end
  of what you have dictated, ignoring case and whatever punctuation dictation
  decided to add, so "Over and out." works as well as the bare words. Off by
  default. It does not care how the words reached the composer — the CLI's own
  voice mode and your own typing both count, so it works in the local-only setup
  where the CLI reports no voice mode at all. macOS dictation needs the second
  switch below as well, for the reason described there. The flip side is that a
  line you type by hand ending in the phrase submits too, which is why the
  default is three words you would never end a sentence with.
  Long drafts work too: the phrase is found even once what you have said
  has wrapped onto further lines, which is the case the feature is really for.
  Curly quotes and long dashes are folded to their plain forms on both sides, so
  a phrase like `that's it` still fires when dictation spells it with a
  typographic apostrophe.
  Only the session you are looking at listens, since that is the only one your
  dictation reaches. It will not fire while a session is asking permission for something,
  because Enter would answer that dialog; a phrase spoken while one is open is
  dropped rather than sent after it clears. Claude sessions on this machine.
- **…and it now works with macOS dictation, which used to need a keypress.**
  With the switch above on, hands-free submit still did nothing under macOS
  on-device dictation until you clicked or pressed a key — and the reason turned
  out to be worth the extra switch. Dictation does not hand your words to the
  session as you speak: it holds them, underlined and uncommitted, and only
  releases them when you touch the machine. So there was nothing in the session
  for the feature above to read, however long you waited. The words are on
  screen the whole time, though, so a second switch —
  **Also submit while macOS dictation is still holding the words** — reads them
  where they actually are and commits them for you once they end with your
  phrase, at which point the switch above takes over as usual. It needs the
  first box ticked and is off on its own, because it is the more forward of the
  two: it acts on a transcript you have not accepted yet, so if dictation drops
  your phrase into the middle of a sentence it will submit early, and there is
  no undo. Nothing else changes — it still stays silent while a session is
  asking permission, still only listens to the session you are looking at.
- **Tap mode can now re-arm itself when an agent finishes its turn.** In the
  CLI's **tap** voice mode the recorder goes deaf while the agent is working:
  the microphone is still on and the cursor still flickers when you speak, but
  nothing is inserted, and only a keypress starts it up again. So dictating
  across a back-and-forth meant walking over and tapping after every answer,
  which is the whole thing hands-free submit was supposed to fix. A third
  switch — **Re-arm tap mode when a session finishes its turn** — presses the
  push-to-talk key for you once the agent has finished and the screen has
  stopped repainting, so you can keep talking from wherever you are. It presses the key you actually have bound to
  push-to-talk, not always a space, and if you have bound it to a key
  combination rather than a single character it does nothing rather than type
  something into your composer. It also stays out of the way whenever a
  character would land somewhere it should not: nothing is pressed if you have
  started typing in the box yourself, if a full-screen program is on the screen,
  or if the session is asking permission for something — that last one matters
  more here than anywhere else, because a session waiting on a dialog is idle,
  which is exactly when this would otherwise fire, and the keypress would answer
  the dialog. Needs the CLI's voice mode set to tap and hands-free submit
  ticked; off by default, and box-wide like the rest of the voice settings.
  It now also checks whether the microphone is still live before pressing
  anything. The CLI's recorder stops listening on its own after about fifteen
  seconds of quiet, and the keypress only restarts it once that has happened —
  press it while the recorder is still going and it STOPS it instead. So an
  answer arriving while you were still mid-sentence used to cut you off. Clodex
  now reads the CLI's own red `REC` indicator off the screen and stays its hand
  while it is showing; if it cannot make out the screen at all it also does
  nothing, on the grounds that a re-arm you have to do yourself is a smaller
  annoyance than one that cuts you off mid-word.

- **A ticket seat now starts in a worktree whose dependencies resolve.** A git
  worktree has no `node_modules` and nothing installs one, so a hand dispatched
  to a ticket branch found every `require()` of a dependency and
  `npm run build:web` failing — and only learned the tree was usable when the
  suite ran, which is after it had finished working. The loop already planted a
  symlink to the main checkout's tree at suite time; that step now runs at spawn
  too, so the seat has it from its first command. If the link cannot be made —
  a checkout that has never had `npm install` run in it — the seat is spawned
  anyway and the dispatch reply says so, since a hand without dependencies can
  still read, write and commit. A team whose root is not a node project at all
  is left alone: no link is attempted and no `npm install` advice is given.

## 5.19.0 — 2026-08-30

- **A preserved ticket-suite dump now tells you when the branch moved out from
  under the run.** The `# head:` line records HEAD as it was when the run was
  queued, read before the run starts — but the suite then waits for a box-wide
  lock, so on a contended run the tree can move before measurement begins and
  that sha may not be the one the suite saw. The dump now carries a `# moved:`
  line giving both commits, HEAD at queue time and HEAD at finish, and saying
  that the lock wait sits between them; it appears only when the two differ. The
  dump also gained a `# start:` line, so the existing `# when:` has something to
  be a span against, matching the header the test digest already writes.

- **Accepting a ticket whose merge was still queued no longer leaves it
  advertising `(merge waiting: suite-in-flight)` for good.** When a merge finds
  the test-suite lock held it waits and retries, and marks the row so the wait
  is visible rather than invisible. If you landed the branch yourself and
  accepted the ticket during that wait, the mark was only ever taken off when
  the retry next woke — up to ten minutes later — and quitting or crashing
  Clodex in between froze it on the row permanently, since nothing rechecks the
  mark at startup. The accept now clears it as it closes the ticket out, on
  every board that shows it, and a merge attempt that was already underway when
  you accepted no longer writes the mark back afterwards — it re-checks the
  ticket before marking, so your accept is the last word. Accepts that leave the
  merge genuinely owed — the branch has not landed, or the check could not run —
  still keep the mark, because there a retry may yet land it.

- **A ticket released from the backlog now tells its seat that the "do not
  start" line in its own spec is spent.** A backlog ticket's spec is written
  when it is FILED, so it routinely carries its own gate — "do not start until
  the operator says go". When the go arrives in chat and you run `task
  assign`, that body was delivered word for word, so the dispatch told the
  agent to start and the spec told it to wait. Agents that stopped to ask cost
  a round-trip each; the quiet failure is the one that reads the gate as still
  live and sits on work you have already released. The dispatch now carries an
  extra line whenever the ticket had no assignee until that moment, and it is
  deliberately narrow: it settles only whether to BEGIN, leaves every other
  caveat and scope fence in the spec standing, and tells the agent to report
  rather than assume if the spec gates on some specific condition it cannot
  confirm. Nothing parses your prose — the signal is the board's own state, so
  the wording you file a gate in does not matter.

- **A preserved test-failure dump now names the commit its run STARTED at.**
  Both writers — the `run-tests` digest and the ticket loop's own per-round dump
  — read `git HEAD` while writing the file, which is one whole suite after the
  run began, so a commit landing mid-run was reported as the commit that had
  been measured. The mislabel was not the damage: "my fix is committed and the
  suite still reds at MY sha" reads as conclusive, and the obvious response is
  to edit work that was already correct. It cost a real debugging round. Both
  now capture HEAD before the suite starts, and the digest's dump carries a
  `# start:` line beside its `# when:` so a stale run is legible without having
  to already suspect one.

- **`task accept` no longer deletes a branch whose merge was undone.** The
  cleanup asked git whether the branch was an ancestor of master and read a yes
  as "the work landed". Those are not the same question: when the merge loop
  undoes a bad merge it runs `git revert -m 1`, which ADDS a commit rather than
  removing one, so the merge commit stays an ancestor and the check still
  answered yes over work that was no longer on master. Accept then reported a
  clean landing, removed the worktree and deleted the branch — leaving the only
  copy of the change in the reflog. It happened once for real. Accept now
  refuses that teardown on any ticket the loop marked `MERGE FAILED`: it keeps
  the tree and the branch, says which step the loop gave up at and why the
  ancestor answer is not evidence on that step, and tells you what the
  mark actually owes you — which differs by step: confirm master still carries
  the merge where the loop reverted one, confirm someone merged by hand where no
  merge commit came out of the step, and where it merged but was blocked from
  reverting, decide that undo before anything else (master carries that merge by
  construction, so reading it as a landing and then reverting later would strand
  the work in no branch at all). Where the loop's catch-all fired, read the
  escalation first — it says whether a merge was made at all. That accept still
  closes the ticket out, which clears the mark, so once you have checked, a
  second `task accept` takes the ordinary merged path. A branch measurably empty
  against its recorded fork point is exempt — there is no work there to lose.

- **A ticket whose auto-merge FAILED now says so on the board.** When the merge
  loop gives up on a ticket it stamps the failing step, and that stamp means the
  ticket needs the lead by hand — but no board showed it, so the one state that
  requires intervention was reachable only by opening `tickets.json`.
  `[agent:task list]` and the `clodex-team` exec pull now both show
  `!! MERGE FAILED: <step>` on the row, open and recently-closed alike, shaped
  unlike the quieter `(merge waiting: …)` mark so a board scan separates "needs
  me" from "waiting its turn". The **tickets viewer** shows it too, as a red
  badge with a red row edge — its own idiom rather than the text boards'
  suffix, keeping that same separation without the reader parsing the words.
  The mark now also CLEARS when the lead accepts a ticket whose branch landed,
  or one that never had a branch: the canonical recovery is that the lead
  merges by hand and accepts, which used to leave the finished ticket shouting
  `!! MERGE FAILED` from the recently-closed block for the whole 24h window. It
  deliberately survives an accept on a ticket whose branch is still unmerged —
  there the accept's own reply says to merge and accept again, so the mark is
  still true.

- **A ticket whose merge is waiting now says so on the board.** When the loop
  defers an auto-merge because a suite is already running in the root checkout,
  it stamps the ticket — but nothing rendered that stamp, so the lead could only
  reach it by opening `tickets.json` by hand and had to judge by feel whether an
  ACCEPT was fresh enough that the merge was still coming. `[agent:task list]`
  and the `clodex-team` exec pull now both show `(merge waiting: …)` on the row,
  open and recently-closed alike. The **tickets viewer** shows it too, as a dim
  badge that adds no row edge of its own: the merge is coming by itself, so the
  mark states it without pulling the eye the way the failure above does.

- **Accepting a ticket now ends a merge that is still waiting on the suite
  lock.** When the loop defers an auto-merge it retries for up to ten minutes,
  and the board says so — which is an invitation to land the branch by hand and
  accept, and the accept then removes the worktree and deletes the branch. The
  waiting retry knew nothing about that: it only checked the ticket was still
  `done`, which acceptance leaves it at, so it woke up, asked git about a branch
  that no longer existed, and stamped `!! MERGE FAILED: base-is-ancestor` back
  onto the row the accept had just cleared, with an escalation DM about a ticket
  you had already finished with. A pending merge is now dropped, quietly and
  with a log line, as soon as an accept closes the ticket out. An accept that
  does NOT close it out is untouched: those replies say to merge and accept
  again, so the merge is still owed and the retry still lands it.

- **And an accept landing during the merge itself no longer does it either.**
  The same blind spot existed a second time, at the last check before the merge
  runs: that check also read only `state`, which acceptance leaves at `done`, so
  an accept arriving in the sub-second gap between the pre-merge gates and the
  merge command walked into a deleted branch and stamped the same false
  `!! MERGE FAILED` — on a first-run merge, with no deferral or retry involved.
  That check now reads the closed-out mark too, and the log line says which of
  the conditions ended the merge.

- **The team lead prompt no longer tells the lead to merge and clean up by
  hand.** Both steps have been automated for a while: an ACCEPT verdict makes
  the ticket loop merge the branch to master and run a suite behind that merge,
  and `task accept` retires the seat, removes its worktree and deletes the
  branch. The shipped prompt still instructed the lead to do both itself, and a
  lead that obeyed it merged ahead of the loop — which then found the branch
  already in master and escalated, with the post-merge suite silently never run.
  The prompt now says the loop merges on ACCEPT, names the two cases where a
  lead really does still merge (no ticket carries the verdict, or the loop
  escalated at the merge step), and points cleanup at `task accept`. The hand
  prompt's matching sentence was corrected the same way.
- **The team lead prompt no longer tells the lead to merge by hand in the one
  window where the merge is already on its way.** That prompt's `task accept`
  paragraph still ended "merge first, then accept again" — correct for the two
  cases where a lead owns the merge, wrong right after an ACCEPT verdict, where
  the loop has scheduled the merge and a test suite holding the machine-wide
  lock can defer it for minutes. A lead accepting into that window was told to
  hand-merge, which is the failure the entry above removed from the other half
  of the file. It now says to wait for the merge notice there. Two smaller
  corrections in the same pass: accept's cleanup only runs on a tree that is
  clean and readable — a dirty tree, or one already removed by hand, keeps the
  tree, and the prompt now says so and names the second accept that finishes a
  dirty one — and the dispatch self-reminder is now described alongside the
  loop's own stall nudge, so a lead can tell which covers what instead of
  assuming either is the only net.
- **Accept has a third condition the prompt never stated: whose seat it is.**
  Cleanup is gated not only on the branch being merged and the tree being clean,
  but on the seat being one the ticket loop minted. Assign a ticket that carries a
  worktree to a STANDING seat — which an ordinary reassignment does, since a
  worktree pin is never degraded — and acceptance retires nothing and keeps the
  checkout, while the reply says so and neither prompt paragraph explained why.
  It does now — as a TABLE. What acceptance tears down turns on four independent
  facts (branch merged, whose seat, what the tree holds, whether the seat is
  running), and three rounds of describing that in flowing prose each left a new
  claim that was true of one path and false of another. The paragraph is now a
  four-row matrix of seat, worktree and branch, with the reply wording that tells
  a lead which row it got. Two things the prose kept getting wrong are now
  visible per row: on a standing assignee a dirty tree buys no protection at all,
  and no number of repeat accepts will ever clean that tree up, because the gate
  that would do it never opens; and deleting the branch is an ATTEMPT rather than
  an outcome — `git branch -d` refuses while any worktree still has the branch
  checked out, so on the rows that keep the tree without skipping the delete it
  ordinarily fails and the ref survives. The archive on a dirty or unreadable
  tree only runs if the seat is still up (one that already exited is simply left
  alone), and "keeps the tree" no longer reads as "keeps everything" — the dirty
  tree keeps its branch deliberately, so a second accept can find it.

## 5.18.0 — 2026-08-27 — your checkouts, your cost history, and three hostile values

- **Voice input has a switch — in Preferences and on the session bar.** The
  Claude CLI's voice mode — off, tap-to-talk, or hold-to-talk — was reachable
  only by typing `/voice` into a terminal, so nothing on screen said which one
  you were in. There is now a Voice input group in Preferences that shows the
  current mode and switches it. There is also a `🎤` button on the session bar
  of every Claude session, showing the mode it is in and opening the same
  three choices — the dialog states the setting in full, the button answers it
  at a glance. The setting is one per machine either way: every Claude session
  running here shares it, so both places show the same value. Choosing a mode
  sends `/voice` to a live session rather than editing the settings file,
  since a session already running would not notice the edit — pick one
  mid-turn and it is queued until the agent is between turns, and both places
  say so. A `/voice` you type yourself is picked up too: they read the file,
  not what Clodex last sent. Sessions started before a change keep the mode
  they launched with until they restart.

- **`SendFeedback` can now be switched off.** The tool arrived in a recent CLI
  drop and Clodex did not know about it, and a tool Clodex has never heard of
  cannot be disabled at all — unchecking it would have done nothing, except that
  the checklist never offered it. It is now in the list, and denied by default
  for new installs: it costs roughly 4,700 characters of instructions on every
  single request, to draft a feedback report that is queued on your machine and
  goes nowhere without your approval. If you have already customised the default
  deny list, your list wins and this one does not change it — add `SendFeedback`
  from the settings panel if you want it off. (`ListAgents`, mentioned in the
  same breath, has been toggleable since early August.)

- **Teammates of the same role now share the `# Team` block.** That block, in
  every team seat's system prompt, named the seat — "You are seat
  clodex-hand-504…" — and repeated it in a roster invocation on the line below,
  so no two seats could share a byte of it. It now states only the team, root
  and role, making it identical for every seat of a role. This is hygiene, not a
  windfall: the block is about **180 bytes**, and for ordinary ticket seats it is
  the last thing in that channel, so those bytes are the whole of it. Nothing is
  lost — a seat is still told its own name at the top of every session, and again
  after each `/clear` and `/compact`, and the copyable roster command still
  arrives with the roster itself. It only pays when same-role seats run
  concurrently, which for most teams means reviewers.

- **A Codex seat keeps the roster command across a `/clear` or `/compact`.** The
  `# Team` block told every seat that the way to check its team's composition
  would arrive in its context. For a Codex seat that was true only for the first
  conversation: the roster is delivered there as a message, so a context reset
  discarded it, while the block itself is cached and went on promising it. A
  Claude seat never had the problem — its roster is re-issued on every reset. The
  block now carries the command itself, with `<your name>` where the seat name
  goes, so it survives every reset alongside the block. The concrete, ready-to-copy
  version still comes with the roster.

- **A stub pty in a test could SIGKILL every process on the machine.** When a
  session is killed or archived, Clodex asks its pty to exit and then, five
  seconds later, sends SIGKILL as a backstop in case it did not. That backstop
  passed the pty's pid straight to `process.kill` with no check, and
  `process.kill` does not read a non-positive pid as an id: `-1` means *every
  process you are allowed to signal*, and `0` means *your own process group*.
  A test whose fake pty carried `pid: -1` reached that path and killed roughly
  277 processes — Dock, WindowServer, Terminal, browsers, databases — three
  times over, with the empty `catch` swallowing every trace. Both backstops now
  refuse any pid that is not a real one, and log the refusal.

- **Reloading a session lost track of its worktree, and the checkout leaked.**
  A session's worktree provenance is stored on its record, and that record is
  how the app finds the checkout again — but an in-place restart rebuilds the
  record from the spawn arguments, and the worktree was not carried across. A
  ticket seat that reloaded itself therefore came back not knowing where it was
  working: deleting it, or accepting its ticket, then reported success while
  leaving the directory on disk, unmerged commits and all, with nothing in the
  app able to find it. Two related settings were being dropped by the same seam
  and are now carried too — a session exempted from auto-compaction went back to
  compacting after a restart, and a reloaded seat re-delivered a boot digest to
  a conversation that already had one.

- **Reloading a session silently turned keep-warm off.** A perpetual keep-warm
  hold (Always, in the session menu) is stored on the session record, but every
  in-place restart — Restart, an args edit with restart ticked, and
  `[agent:context reload]` — rebuilds that record from the spawn arguments, and
  keep-warm was not among the fields carried across. The setting simply
  vanished, with no toast and no log line, and because a perpetual hold exists
  precisely for a seat nobody is sitting at, nothing ever noticed: the seat took
  no turn, so no re-arm ran. Both keep-warm states now survive a restart, the
  perpetual flag and a timed deadline alike.

- **Accepting a ticket could delete a checkout you were working in.** `task
  accept` retired whatever seat the ticket named — and on a merged branch that
  meant killing it, dropping its record and force-removing its worktree, with no
  check for uncommitted work. A ticket assigned to one of your own standing
  seats (by name, or by reassigning a ticket after its worktree seat died) put
  that seat's checkout on the wrong end of it. Acceptance now only retires seats
  the ticket loop itself spawned, leaves a standing seat and its tree alone, and
  says which of the two it did. It also refuses to remove any tree with
  uncommitted or untracked files, archiving the seat instead and telling you
  where to look — the same downgrade "retire" already made.
- **Finishing a ticket cleanup could leave a session row pointing at a deleted
  folder.** Removing a seat that had already exited removed its worktree but
  kept its session record, so the sidebar showed a row whose checkout was gone
  — and the reply still said the seat was retired and its worktree removed. The
  route there was the one the app itself suggests: when acceptance finds
  uncommitted work it keeps the tree and asks you to accept again once you have
  committed, and by then the seat is no longer running. The row now goes with
  the folder, however the seat ended — except when the folder could not be
  removed, where the row is deliberately kept, since it is the only thing left
  naming a checkout still on disk. That case now tells you the path to remove
  by hand.
- **Rejecting a ticket did not stop the merge it was overriding.** When a
  reviewer returned ACCEPT, the ticket loop queued the merge and then ran its
  safety gates — a git ancestor check, a clean-tree check, a branch check. A
  `task reject` sent in that window reopened the ticket correctly but the merge
  still landed on master, so work the lead had explicitly sent back for another
  round shipped anyway, with nothing on the record saying so. The merge step now
  re-reads the ticket immediately before merging and abandons it if the ticket
  is no longer done, leaving master untouched; the next ACCEPT queues it again.
  A reject sent once the merge itself is already underway still lands — by then
  there is a merge commit to undo, and reverting it stays your call.
- **A crash mid-write could wipe your whole cost history.** `wire-totals.json`
  holds the all-time per-session token and dollar totals behind the cost
  display and every per-ticket rollup, and it is rewritten in full about once a
  second while agents work. It was the one store still written straight over
  itself rather than through Clodex's crash-safe write, so a quit or a power
  loss landing inside that window truncated it — and because a corrupt totals
  file is deliberately tolerated on read, the ledger came back empty with
  nothing said. It is now written to a temp file and renamed into place, so an
  interrupted write leaves the previous totals intact.
- **A peer could run code on your machine by being looked at.** Numbers in a
  peer's session data were written into the sidebar without escaping, and this
  renderer can `require()` — so markup in a peer's HTTP response was not a
  display bug, it was code execution, triggered by attaching a peer session and
  viewing it. The values are now type-checked where they are formatted, which
  also closes the same hole at the other thirty-odd places those formatters are
  used. Only relevant if you connect to peers.
- **"Open in Terminal" ran the session's folder through a shell.** A folder path
  containing shell syntax was executed rather than opened. Paths are agent-
  supplied, and a session that *failed* to start still leaves a row you can
  right-click. No shell is involved now.
- **Two Codex sessions in one folder deleted that folder's `.codex/hooks.json`.**
  Clodex backs the file up while it borrows it and restores it on exit; with two
  sessions the backup was made once, restored by the first to exit, and the
  second then removed your original. Clodex now removes the file only when it
  still contains the config Clodex wrote.

## 5.17.0 — 2026-08-22 — a read-only GitHub verb for agents

- The "ticket merged" note the ticket loop sends the lead no longer claims a
  CHANGELOG entry is owed when the merge already carried one. It now checks what
  the merge actually put on master and says one of three things: the merge
  changed `CHANGELOG.md` so look before adding a second entry, an entry is owed,
  or the check itself did not answer — that last one reported as its own outcome
  rather than quietly folded into either of the others.

- New **GitHub plugin**, off by default. It adds one read-only agent verb,
  `[agent:gh]`, that collapses the six-commands-and-two-wrong-guesses dance an
  agent otherwise does against a repo: `status` (branch vs base, PR, CI and
  review state in one answer), `ci` (the failing checks, with the error lines
  distilled out of tens of thousands of lines of build log), `review`
  (unresolved review threads as a `file:line` worklist), and `pr --dry`, which
  renders the title, description and diffstat of the PR your commits would
  open. It never pushes and never opens a PR — a bare `[agent:gh pr]` declines
  and says why, because opening a pull request is the operator's action. It
  holds no credentials of its own: it shells out to the operator's own
  authenticated `gh` CLI, so `gh auth login` is a prerequisite. Enable it in
  Manage Plugins, then tick its verb in each seat's intent checklist.

- A reviewer seat no longer outlives the review round it was spawned for. A
  reviewer retires itself once it delivers a verdict, but when the lead ended
  the round instead — rejecting a ticket back for rework, or accepting it — the
  seat stayed live in the sidebar still attached to that ticket. If it later
  delivered its verdict, that verdict could land on a LATER round, judging work
  that no longer existed. Both endings now retire the seat, and an escalated
  review whose reviewer is still expected to answer is deliberately left alone.

## 5.16.0 — 2026-08-22

- A command run in an agent's terminal tab can no longer be corrupted by the
  interrupt that clears the line first. Clodex sends ^C before typing, to make
  sure the command lands on an empty prompt, and it then had to decide when the
  shell had finished reacting. It guessed from the output: any bytes arriving,
  followed by a brief pause, counted as the shell being ready. Under load that
  pause elapsed while the interrupt was still in flight, so the command was
  typed onto the line the shell was about to discard — and what survived was a
  truncated command that still ran (`cho: command not found`), which is worse
  than failing outright. Clodex now waits for the shell's own prompt to report
  that the last command exited on an interrupt, and raw output no longer
  releases the command at all. A shell that never reports one still gets its
  command, on the existing one-second backstop: later, not wrong.

- A stalled-ticket alarm now says when the seat stopped on an API error, and
  which error it was. The watchdog could only ever infer a stall from silence —
  a seat that has written nothing and is burning no CPU — so it reported the
  step it was stuck at and left you to open the session and find out why. When
  the seat's own transcript ends on an API error, that is a cause it reported
  itself, and the alarm now quotes it. The error text says which kind it is:
  an overloaded server usually clears on its own, a refusal or an exhausted
  balance will not. Clodex deliberately does not act on this — it tells you and
  stops, because most of these are not the retryable kind, and the automated
  wake a wedged seat already gets is unchanged.

- The cost popover's "By line" breakdown is back, and its percentages are right.
  It splits a session's estimated spend across the main line and each subagent,
  and it was reading its total from a different accounting than the shares it
  divided by that total — a lifetime figure over per-run rows. So the shares
  read lower the longer the app had been running, the "Main line" row went
  missing, and on a session with no subagents at all the whole section
  disappeared. It now reads every figure from one place, and says which run
  that figure covers — an unlabeled total next to the status bar's lifetime one
  was the same confusion in a different spot.

- Handlers can no longer quietly use a feature the browser transport does not
  have. Clodex serves the same UI to the desktop app and to a browser, and the
  object a handler uses to reply to whoever called it is not identical across the
  two — a handler written against the desktop one could call something the
  browser side lacked, throw, and have the failure swallowed. That is what once
  made a fifteen-minute remote deploy report success while streaming none of its
  progress to a browser tab. The two supported methods are now written down in
  one place, and a test fails the build if a handler reaches past them or if the
  browser transport stops providing one.

- The team roster now says when a role carries a setting that does nothing. Team
  files written against an older schema can still hold fields that were retired
  since — `tools` on a role is the one that has actually misled someone, because
  it reads exactly like a permission cap and enforces nothing. Those fields were
  reported only into a log nobody watches, so the roster went on presenting the
  role as if the setting applied. Each affected role now carries a line under its
  own row naming the retired fields, and a role with a clean definition looks
  exactly as it did before. Fields that are retired but still honored for
  backwards compatibility are called out separately, with the replacement to
  write, so that deleting one cannot be mistaken for a harmless cleanup — it
  would change how that role dispatches.

- Every agent now gets the ticket verbs in its own prompt. The `task` grammar —
  how a seat closes the ticket it was dispatched, and how it finds that ticket's
  id — reached seats only through a seeded role brief on disk, while the protocol
  prompt itself documented every other verb. That was fragile in a way nobody
  could see: a seeded file can silently freeze behind the copy Clodex ships, and
  this one did, for three days. During that window the grammar for closing a
  ticket was one stale file away from being unreachable, and the near-miss
  bounce — which lists `task` as a valid verb — would have gone on advertising a
  verb the seat had never been taught. It cost a real seat a confused round over
  how to close its own ticket.
  The prompt now carries the two lines a non-lead seat actually needs: `task done`
  with the three things that got that seat stuck (the report is the body, it is
  required, and a dm carrying the report does *not* close the ticket — it reaches
  the lead looking identical while the ticket stays open), and `task list`, which
  is how a seat finds its id. The lead's dispatch verbs are named with their
  argument shapes only, so a seat does not invent a spelling for them; the full
  protocol stays in the lead's brief.
  Unlike the other verbs, this one cannot be switched off — the ticket verbs are
  not part of the per-seat intent allowlist, so the grammar reaches every seat
  regardless of how narrowly it was scoped.

- A ticket whose automatic checks fail now stays recoverable instead of going
  quiet. When a seat closed a ticket and one of the checks that runs before the
  review failed — nothing committed on the branch, a rebased base, a suite that
  could not be run — Clodex told the lead and stopped there. The ticket was left
  marked done but with nothing in flight: closing it again was refused ("is done,
  not open"), the stall watchdog never looked at it again, and no review ever ran
  on that branch. The only verb that moved it was **reject**, which reopens the
  ticket and counts a rework round — recording a rejection that never happened
  against work nobody had reviewed.
  Such a ticket is now **held** rather than finished, and every message about it
  says who can clear it and how. For a check the branch can satisfy — nothing
  committed, an empty diff — the seat that owns the branch is told directly, as it
  already was for a failing test suite, and closing the ticket again re-runs the
  checks from where they stopped: the ticket is never reopened and no rework round
  is counted. For a check that no amount of re-closing can satisfy, such as a spec
  naming an artifact directory that cannot be resolved, the message says so and
  names what has to change instead of prescribing a retry that would fail
  identically every time. For a check that could not run at all — a busy test
  lock, a runner that would not start — nobody is asked to fix a branch that was
  never at fault.
  The board carries the held check by name, so a ticket stays recoverable even if
  the message announcing it was missed, and the watchdog re-raises it on the usual
  schedule saying an escalation is waiting rather than reporting a stuck step.
  Rejecting a held ticket still works and still means what it says.
  Two follow-on wording fixes: closing a held ticket again no longer announces a
  second "done" for a ticket that was never re-closed — it reads *re-verifying*,
  matching what the seat itself is told. And a seat that closes a ticket a second
  time while its checks are still in flight is now told that they have not
  reported yet — and pointed at the stall alarm that covers a run which died
  partway — rather than getting a bare "is done, not open" that left rejecting
  the ticket as the only obvious move.
  Refusing is still correct: it is what keeps two check runs off one branch.

- Correcting a ticket's spec no longer throws the previous one away. **Respec**
  replaces an open ticket's spec, and until now it recorded only the superseded
  *title* — the previous body was kept nowhere. That mattered because corrections
  are usually written as a delta against the spec the seat is already holding
  ("keep everything above, but also…"), and a seat that restarts is re-sent the
  ticket's current spec and nothing else. So a seat replayed after a correction
  received instructions whose other half no longer existed anywhere: a
  well-formed, complete-looking brief with most of the job missing from it, and no
  sign anything was absent.
  Every superseded body is now kept on the ticket, so a corrected ticket's full
  history is recoverable. And any seat handed a corrected ticket — on a restart, on
  a **reassignment** after a seat died mid-ticket, or on its first dispatch if it
  was corrected before anyone picked it up — is told that the spec was replaced and
  how many times. The one exception is the seat being corrected as it works, which
  is already told directly. The message carries a specific warning with it: work
  already in the tree which the current spec never mentions is more likely to be an
  earlier instruction than stray work, so it is reported rather than deleted.
  Superseded bodies stay out of the message itself and off the board's data feed;
  the ticket list shows the correction count as it already did.

## 5.15.0 — 2026-08-21 — the ticket machinery stops producing wrong results

- Re-dispatching a ticket now keeps the branch it was originally given, instead
  of working out a new name from the ticket's current wording. A ticket's branch
  was re-derived from the first line of its spec every time it was dispatched onto
  a fresh checkout — which happens whenever the previous one is gone, locked or in
  use. So a ticket whose spec had since been edited, or one filed before the
  naming rule last changed, got a *second* branch forked from the current tree,
  while the work the previous seat had committed stayed behind on the first one.
  The ticket then pointed at the new branch, so the branch you went to merge and
  the branch holding the commits were quietly not the same.

- Assigning a ticket by clicking in the tickets viewer now tells the seat where
  the ticket's artifact directory actually is, exactly as typing the assignment
  as an intent already did. The spec's `tasks/…` pointer is usually written
  relative to the project's artifact directory, but an agent resolves a relative
  path against its own working directory — and this repo contains a directory of
  the same name, so the seat found one, read another ticket's files, and got on
  with the job. Both ways of assigning now deliver the same resolved path and
  the same explanation of it, and the two wordings are pinned against each other
  so they cannot drift apart again.

- When Clodex cannot give one of your library files a shipped update, it now
  tells you in the inbox instead of only in a log file nobody opens — but only
  once per withheld update, not on every launch. A library file you have edited
  yourself stops receiving shipped updates, which is the correct behaviour (your
  edit is preserved) and worth knowing about; the previous release reported it
  as a log line on every single launch, and the advice it gave was to delete the
  file, which for a file that is genuinely your own config destroys it. The note
  now leads with the case that applies to most people — you edited it, nothing
  needs doing — and mentions copying your version aside before the destructive
  option. A given withheld update is announced once and then stays quiet until a
  newer shipped version is withheld too. The first launch after this ships will
  produce one note listing every already-stranded file (on a typical install
  that is a single file); that is the backlog being reported, not a new problem.

- A ticket's git branch is now named after what the ticket is actually about.
  The branch takes its readable half from the spec's first line, but that line
  was being read from the ticket's list-summary title, which is cut at 80
  characters — and a dispatch opens with a ~67-character artifact path, so only
  a dozen characters of the actual sentence survived to be slugged. Every one of
  the last eleven tickets filed here was affected: three separate pairs collided
  outright (two `t`, two `the-s`, two `the`) and one lost its readable half
  entirely, so the name distinguished nothing and `git branch --list` was the
  only way to find out what a branch held. The slug now reads the whole first
  line and does its own word-boundary cut at 40 characters, which is what it was
  built to do; those become names like
  `t462-the-two-anchor-slice-unguarded-at-four`. The summary column is
  unchanged, existing branches are untouched, and the artifact path is still
  read off that same line.

- A ticket spec that names its task dir the short way (`tasks/<name>/SPEC.md`)
  now reaches the seat with that path already resolved. The two ends read the
  same string differently: Clodex places it under the project's artifact dir in
  `~/.clodex`, while an agent reading the spec resolves it against its working
  directory — the repo. Where the repo happens to contain a directory of the
  same name, the agent lands in a real but wrong one instead of failing, reads
  stale notes and writes its own there. Seen live: a seat reported its briefing
  missing, worked without it, and journalled into an abandoned copy. The
  dispatch now carries a `TASK DIR:` line with the resolved path and the rule
  behind it, and so does the scope handed to a reviewer — which reads the same
  pointer from the same repo, and so had the same problem. The line also says
  the path names a directory (the pointer usually ends in a file) and that it
  may not exist yet, since reading its absence as "there is no artifact" is the
  step that actually went wrong. Only the seat doing the work is told to create
  it — the reviewer, which cannot write anything, is told the same fact without
  an instruction it could not follow. The stored spec is untouched, so what the
  review sees is still what was written; a path that Clodex itself would refuse
  to write to is simply not named, and the ticket is dispatched either way.

- A library file that stopped receiving shipped updates now says so. Clodex
  seeds `~/.clodex/library` from the shipped defaults and deliberately never
  overwrites a file you have edited — but it decided "edited" from a hash
  mismatch alone, so a copy that had merely fallen behind was frozen just as
  permanently, and silently. One shipped team-role prompt sat 8 days and 20
  revisions stale that way, so every lead seat spawned in that window booted
  missing rules that were already in the release. Such a file is now reported at
  launch, naming it and how to take the shipped version. Your edits are still
  never overwritten: a file whose bytes match no shipped revision is left
  exactly as it is. One content-free repair was added — a file already identical
  to the shipped bytes with a stale stamp has its stamp reconciled, which puts a
  hand-repaired file back on the upgrade path for the next release.

- Accepting a ticket whose branch carries no commits no longer reports it as
  *merged*. The merge check asks whether the branch is an ancestor of master, and
  a branch that never committed is still sitting on its base — which is an
  ancestor — so a ticket closed with nothing committed was accepted with "merged
  into master; seat retired, worktree removed, branch deleted". Nothing had been
  merged. The accept reply now counts the branch first and says "branch X has 0
  commits beyond Y, so NOTHING was merged", matching the wording the review loop
  already uses for the same condition. The cleanup itself is unchanged — an empty
  branch has nothing to lose — and the ticket is no longer *recorded* as merged
  either.

  The count only settles it when it was measured against the branch's recorded
  fork point. Where it could not be — none was recorded, or the recorded commit
  has since been rebased or garbage-collected away — an empty branch and one
  already merged count the same, so accept reports the outcome as unknown rather
  than picking a side, and says which of the two reasons applies. Same for a
  count that cannot be run at all. The team-lead prompt shipped with Clodex
  described acceptance as a two-outcome verb, so a lead could read that unknown
  outcome as "the branch was empty" and record a merge that really happened as
  nothing — the same false report, made by the reader instead of the code. It
  now briefs all four outcomes and says which one actually means empty.

- Review notifications now count must-fixes correctly when a reviewer nests
  their reasoning. A one-item REWORK whose finding was traced through five indented
  sub-bullets was announced as "6 must-fixes", sending the lead hunting five
  findings that did not exist. Items are now counted at the shallowest
  indentation the section itself uses, so sub-bullets belong to the item above
  them while genuine siblings still count separately — measured across the
  recorded verdicts, ten of them had been overcounted, one by eight to one. The
  merge gate itself was never affected: it only ever asked whether the count was
  zero.

- The agent protocol reference now says that *every* body-carrying intent
  captures greedily, and names them. It previously listed only two of the
  thirteen, which implied the rest stopped at the end of their own line — so
  prose written under a reminder, a notify-user or a ticket close was silently
  swallowed into it. The two genuinely line-scoped verbs are named as the
  exceptions they are.
- Closing a ticket nobody had started no longer interrupts a working seat. Closing
  or cancelling a ticket hands the seat that held it its next queued one — but for
  a backlog ticket still filed against a *role*, that seat was resolved to whoever
  currently holds the role: a hand mid-work on something else entirely. Closing an
  unrelated backlog item then pushed that hand its own in-flight spec back, looking
  exactly like a fresh assignment, and a hand that reads a fresh assignment starts
  clean — discarding the work in progress. The hand-off now only fires when the
  closed ticket had actually started, which is the only case where a seat was freed.

- Every such hand-off is now marked `REPLAY`. It always redelivers a spec the seat
  was already sent once, so unmarked it was indistinguishable from new work.

- Dispatching a second ticket to a seat that has not yet started its first one no
  longer loses the first ticket. The second dispatch clears the seat's composer,
  which destroys the unsubmitted copy of the first spec, and it also displaced the
  one watcher that would have noticed — so the seat sat silent on a ticket it had
  never actually been told about, and the only thing that eventually spoke was the
  stall watchdog, reporting it to the lead as a *stalled seat*.

  The displaced ticket is now redelivered instead, marked `REPLAY` so the seat can
  tell it from a fresh assignment. Redeliveries are drained one at a time, and
  never while another unconfirmed write is outstanding — two at once would recreate
  the same collision.

  Each redelivery is a one-shot, and the budget is per *episode* rather than per
  ticket: a ticket re-assigned to the same seat weeks later and displaced again
  gets its own redelivery, instead of an immediate escalation on a budget spent
  long ago. An episode ends as soon as the redelivery is out of harm's way —
  either the seat visibly took it, or it was set aside for the seat's next turn
  because the seat was busy or could not be interrupted, which nothing can
  overwrite. That second case counts
  for the same reason as the first, so a ticket whose repair happened to land
  while its seat was working is not held to the earlier episode's budget forever.
  A seat that has gone silent still escalates rather than being written to a third
  time. A displaced ticket that closed or moved to another seat
  meanwhile is dropped; one whose ticket no longer resolves to any live seat is
  escalated to the lead rather than dropped silently; and one the seat turns out to
  have received after all — its transcript proves it, the activity signal having
  simply arrived ahead of the CLI writing the message down — is dropped rather than
  sent twice.

  Dispatching is unchanged from the lead's side: nothing is refused, and no new
  step is needed.

## 5.14.0 — 2026-08-20 — wirescope through the tunnel, and links that land on the right machine

- Wirescope dashboard links now WORK when you open a peer box's web frontend
  through the ↗ tunnel, rather than merely being suppressed as unreachable (see
  the entry below, which stops them landing on the wrong machine). Opening the
  web view now also forwards that box's wirescope and tells the page where it
  landed, so the link resolves to the box's dashboard through the tunnel.
  Nothing to configure, and nothing to lose: a box with no wirescope — or one
  running a version that predates this — simply has no dashboard link, exactly
  as before, and the web frontend itself opens either way.


- A lead can no longer spawn a duplicate reviewer into the ticket loop's blind
  window. Closing a ticket stamps it for verification, and the loop spawns its
  own reviewer only once the branch's full suite has passed; for that whole run —
  usually a couple of minutes — the ticket looks unreviewed and is not. A bare
  `[agent:team-review]` fired there spawned a second reviewer
  that re-read the whole diff and reported to nobody, because only the loop's
  call carries the ticket id a verdict routes back through. It is now refused,
  naming the tickets in verify and pointing at `[agent:task reject <id>]` for
  the case it gets used for — another round on an already-reviewed ticket. The
  loop's own reviewer is unaffected.


- Viewing a box's Clodex in a browser no longer offers a wirescope link that
  silently lands on the WRONG machine. The dashboard link is built against the
  box's own loopback address, and unless the box publishes a reachable wirescope
  URL the browser resolved it against the VIEWER's machine instead — where a
  local wirescope is usually listening on the very same port, so it opened and
  rendered a foreign session id: confidently wrong rather than visibly broken.
  Boxes installed over ssh never publish that URL, so this was the normal case
  there. Such a link is now suppressed with a short explanation instead of
  opened. Every other link (GitHub, release notes) is unaffected.


- The same wrong-machine failure is now closed for EVERY link, not just the
  wirescope one. An audit found the sandbox "Open in browser →" links — in the
  Sandboxes dialog and on the peer bar — breaking identically: they address a
  box's web UI on the box's own loopback, so clicking one in a browser opened it
  on YOUR machine instead, where another Clodex is often listening on that very
  port. You got a real Clodex, silently the wrong one. Rather than listing ports
  to distrust, the browser frontend now refuses any link addressed to loopback
  (`localhost` / `127.x`) whenever you are not browsing on the box itself, and
  says so instead of opening it. Links that were already correct still work
  untouched: GitHub and release notes, everything you click while browsing on
  the box at `localhost`, and the tunnelled dashboard links the entries above
  just made resolvable — those address a port on YOUR machine and are meant to.

- A stale browser bundle is now caught by the test suite rather than at release
  time. The browser frontend is served from a prebuilt bundle committed in the
  repo; releasing already refused to ship a stale one, but nothing objected in
  between, so a merged-but-unrebuilt renderer change left the sources reading
  fixed and the suite green while a checkout of the main branch — the ssh deploy
  path — served the old code. The suite now rebuilds the bundle in memory and
  compares it byte for byte with the committed one, naming the command to fix
  it. No release could ever have carried the stale bundle; this just moves the
  same 0.3s check to where the mistake is made.


## 5.13.0 — 2026-08-19 — the ticket loop stops losing work to its own machinery

- The suite lock no longer costs a merge or eats a report. Two things shared one
  cause: the lock is box-wide, so a hand verifying its own worktree holds the
  root's lock for a whole run. An accepted ticket whose merge landed in that
  window used to be refused permanently and downgraded to a manual `git merge` —
  it now waits and retries (up to ten times, and never more than ten minutes) and
  merges by itself once the run finishes, while merges for other tickets carry on
  unblocked. Only that one transient refusal retries; a dirty tree, a moved
  branch or a red suite still stops at once, and an exhausted wait escalates with
  the same manual command it always gave. Separately, an agent's suite command
  was capped at two minutes against a suite that now takes ~74 seconds plus up to
  30 seconds of waiting for the lock, so a run that SUCCEEDED could still be
  killed before it could report; the cap is now seven minutes. A command that
  does hit its ceiling now says it timed out and that its work may still be
  running, instead of arriving as an ordinary failure. And when the suite refuses
  to start because another run holds the lock, it no longer prints a pid that has
  already exited — the pid file lags the real holder, and that stale pid was an
  invitation to delete a valid lock and deadlock two runs.

- Clearing a role's unused `cwd` in the team-roles editor no longer leaves an
  unexplained empty box. The field stays visible and uneditable on purpose — the
  role still dispatches `standing`, so a value typed there would be saved and
  never used — but its note used to disappear along with the value, leaving
  nothing saying why the box could not be typed into. It now says the value is
  cleared and that the field stays inert while the role is standing.

- Dispatching a ticket whose spec names no `tasks/…` artifact directory now
  refuses at dispatch instead of at verify. Such a ticket has nowhere for the
  review step to write its diff, so it used to be accepted, worked all the way
  through, and only then rejected — costing a whole round on work that could
  never land. `[agent:task start]` and `[agent:task assign]` refuse it, and so
  does the tickets board, on both of the ways it dispatches: assigning an
  existing ticket, and opening a new one with an assignee already picked. On a
  new ticket the refusal names the fix in the only terms that apply — nothing
  was filed, so there is nothing to `respec` and no ticket id to name.

  Filing a ticket with no assignee is unaffected, since it dispatches nothing,
  as are solo boards with no team. Re-sending a spec still goes through:
  re-assigning a ticket that already owns a worktree is how a respawned or stuck
  seat recovers, and refusing that would strand the recovery.

- Agents are now told their context is heavy at 200k tokens rather than 150k,
  and a seat spawned for a single ticket is never told at all. The old threshold
  was set before ticket work existed and fired in the middle of ordinary tickets;
  a one-ticket seat is retired when it finishes, so compacting costs it the
  context its rework needs and saves nothing it would not get for free anyway.

## 5.12.0 — 2026-08-18 — the team popover, redesigned

- The team popover's Add Role form is now behind a single `+ Add role` button,
  and asks for the name and how tickets reach the role first, with the optional
  details below. It asked for five fields up front before, all of them on screen
  whether or not you were adding anything. Closing it clears what you typed, so
  a half-filled form is never left looking like a role that was saved.

- The stall watchdog moved behind a gear beside the `?` in the team popover's
  title. It is a setting for the whole team rather than part of any role, and it
  was taking up room on a panel you open to look at roles. Its behaviour is
  unchanged — the same field, the same friendly units, the same Set and Clear.

- A role's `cwd` and spawn `template` now appear only when they do something.
  Both are used when a ticket spawns a seat for the role; a standing role's seat
  is one you created yourself, so neither has any effect on it. On a standing
  role they are hidden when empty, and when a value IS stored the field stays
  visible and marked as unused rather than disappearing — the popover always
  saves `cwd`, so a hidden one would have been kept forever with no way to see
  it. A stored `cwd` can be cleared there; a stored `template` shows why it
  cannot be removed from the app in this version, and points at the two things
  that do work — switching the role to spawn or worktree, or editing
  `team.json`. Switching a role between standing and spawn shows or hides the
  fields immediately, before you save, and anything you have typed or cleared
  is kept across the switch.

- The dispatch picker in a role's editor is now three labelled segments instead
  of a dropdown of sentences, and it works from the keyboard: arrow keys move
  between the modes, and what each mode does is on the segment's tooltip rather
  than crammed into its label. The Add Role form keeps a short dropdown, where
  the panel is too narrow for segments.

- Field labels in the team popover sit above their inputs rather than in a
  right-aligned column, so long values get the full width of the panel.

- The team popover now opens on a summary of the team rather than on every
  field of every role at once. Each role is one line — who is filling it, how
  many of them are working, and how its tickets are dispatched — and clicking a
  line opens that role's editor, one at a time. The fields themselves are
  unchanged; they are just no longer all on screen simultaneously, which on a
  four-role team meant scrolling past three editors to reach the fourth. A lead
  pointer that names something Clodex cannot find now says so at the top instead
  of leaving the panel looking ordinary. A lead that is merely stopped is not
  treated as broken — it restarts under its name.

- A team missing its `hand` role is now offered one back, the way a missing
  `reviewer` already was. Removing the hand left a team that reads as complete
  but has nothing to implement the specs its lead writes, with no symptom until
  a ticket has nowhere to land. The offer card says what is currently happening,
  not just what the role would do, and the definition it adds is Clodex's own —
  what you type in the card is never mixed into it. Teams that already have both
  roles see no change.

- Read-only roles are no longer dimmed as a whole. `lead` and `reviewer` are
  operator-owned, and fading their entire row also faded the buttons that still
  work on them — the seat picker on the lead, Remove on the reviewer — so a live
  control looked disabled. Only the locked text is dimmed now.

- A role can now dispatch a one-shot seat that works in the shared checkout.
  The `dispatch` picker in the team popover gained a third option, `spawn`:
  Clodex mints a fresh seat for the ticket, hands it the spec, and that seat is
  done when the ticket is — but without minting a branch or a git worktree for
  it. Until now the only way to get a one-shot hand was `worktree`, which also
  gave it its own branch and checkout, so a team whose project is not a git
  repository could not have ephemeral hands at all. Now it can: the dispatch
  path for a `spawn` ticket makes no git calls at all. The seat is told, in its
  dispatch, that it shares the checkout with everyone else and that committing
  is the lead's call — it has no branch of its own to commit to. Because there
  is no branch, a `spawn` ticket closes when the hand reports: the verify-and-
  review loop that runs on a worktree ticket asks questions about a branch, and
  there is no diff for it to check. Accepting one archives its seat rather than
  deleting it, so its transcript and anything it left uncommitted stay
  recoverable. `lead` and `reviewer` still cannot be given either one-shot
  dispatch.

- A team's roles can now live in different directories. Each role in the team
  popover gained a `cwd` field — a path relative to the team root — so a
  component team can put its lead at the project root while its hands start in
  `api/` and `web/`. Leave it blank and nothing changes: the seat boots at the
  team root as it always has. The path has to name a directory that already
  exists, and Clodex will not create one for you: a seat working in an invented
  empty directory looks exactly like a seat working correctly. Absolute paths
  and anything escaping the team root are refused when you set them — including
  a symlink that points out of the tree — since `team.json` is agent-writable
  and this field decides where a seat's shell opens. Two cases fall back to the
  team root and say so in the spawn reply rather than failing the ticket: the
  directory has since been deleted, or it
  belongs to a nested team of its own (a seat booted there would silently join
  THAT team's board). Worktree tickets are unaffected in how they name their
  tree — the `WORK IN:` line still points at the tree root, with the role's area
  named on a line of its own. The `lead` role does not take a `cwd`: its seat is
  not spawned by the team, so its directory is set when you create the seat.

- The cache-bust panel no longer buries the busts that cost something. An idle
  cache lapse is recorded as a bust like any other, but it rewrote nothing and
  has nothing to show — a `FULL-REWRITE` heading over `0 tok rewritten · 0%` —
  and on a session left idle for a day those rows outnumbered the real ones
  hundreds to one. They now collapse to a single counted line, so the panel's
  headline number means what this session actually paid. A zero-token bust that
  still says WHAT changed is kept: free is not the same as uninformative.

## 5.11.0 — 2026-08-17 — teams stop being fixed

- A team's lead seat can now be chosen from the team popover instead of only by
  hand-editing `team.json`. The lead row shows which seat currently holds the
  role and whether it resolves to anything — a team created from the Teams menu
  names a `<team>-lead` seat that does not exist yet, and that used to read as
  if it were fine. Pick a running seat from the list, type the name of a stopped
  one, or create the seat from the row. Bash sessions are deliberately not
  offered: they have no messaging registry, so a lead pointed at one could never
  be reached. The lead ROLE itself stays built-in and locked, as before.
- A team no longer has to keep its reviewer. The `reviewer` row in the team
  popover gained a Remove button, and a team without one shows an "Add it back"
  row in its place rather than nothing at all. Removing it is not free and the
  confirm says so: tickets on that team escalate to you at the review step
  instead of getting a cold reviewer, which is the working arrangement if you
  would rather review the work yourself. Removal is blocked while a reviewer
  seat is live or a reviewer ticket is open, exactly like any other role.
  Two things stay fixed. Only you can do this — from the app; the
  `[agent:team role-rm]` intent still refuses, so a lead cannot remove its own
  reviewer. And adding it back writes Clodex's own definition of the role, never
  one from a `team.json`, so removing and re-adding cannot be used to swap in a
  more agreeable reviewer. The `lead` role remains non-removable for everyone,
  including you: a team without one fails to load and would read as no team at
  all.

## 5.10.2 — 2026-08-16

- "Keep cache warm — always" stopped keeping the cache warm after roughly eight
  hours of an idle seat, and stayed stopped until the seat took a turn. The
  keep-warm ping replayed the login token captured at the seat's last turn;
  those expire, and the CLI refreshes them only when it takes a turn — so on an
  idle seat, the one case the setting exists for, the token went stale and two
  rejected pings a minute apart switched the hold off for the night. The setting
  itself was never lost, which is why it still read "held always". Clodex now
  reads the current token when it pings, and waits quietly instead of pinging
  when there is no valid one to use.
- Bundled wirescope updated to v0.6.54, which fixes its own version of the same
  failure: a keep-warm hold whose credential-refresh attempts had run out would
  stop pinging while still reporting itself as armed.

## 5.10.1 — 2026-08-15

- A command an agent ran in a seat's terminal could lose its first character on
  a loaded machine, and the truncated remainder still ran — `echo a; echo b`
  arriving as `cho a; echo b`. Before typing, Clodex interrupts whatever is on
  the line and waited for the shell to answer; on a busy box, output from the
  *previous* command could be mistaken for that answer, so the command went out
  before the interrupt had landed and the shell discarded its opening byte.
  Clodex now waits for the shell's own prompt marker, which cannot be produced
  by earlier output. Rare, but it could silently turn one command into a
  different valid one.
- The drawer bar's plan-usage readout is calmer and no longer misreports whose
  budget it is. It was red on a blue bar — hard to read, and an alarm about
  something you cannot act on faster by being startled; severity now reads from
  the words, in the same palette as the rest of the bar. "rate limited" named a
  past event without saying what it meant, and is now "requests being refused".
  It also appeared on Codex seats, where a Claude plan's figure does not belong,
  and a Codex session's poll could blank it for everyone until the next Claude
  poll — the flicker and the misattribution were one bug.
- The plan-usage readout now comes off Clodex's own wire, updating on each
  forwarded turn instead of on a 5s poll of a separate service. It survives a
  restart, so the figure is there at launch rather than blank until the first
  turn, and its countdown keeps ticking while the fleet is idle. Once a window
  has actually reset the readout disappears instead of showing a number for a
  window that no longer exists, and a "requests being refused" warning fades on
  its own — it no longer stays up until the next turn, which after a refusal
  burst may be a long time coming. Codex seats cannot make it appear at all.

## 5.10.0 — 2026-08-15

- Your Claude plan's usage now shows up in the drawer bar — the strip carrying
  the IPC Traffic and Activity tabs — before it bites: the percentage used,
  which window it is (`5h` or `7d`), and how long until it resets. It appears
  only when the API itself starts warning, so a comfortable week looks exactly
  as it does today and the readout showing up at all is the signal. A refused
  request or a recent rate limit reads louder. The figure updates when your
  agents talk to the API rather than on a timer, so a reading that has gone
  quiet is dimmed rather than shown as if it were live. It stays put as you
  switch between IPC Traffic, Activity and the other tabs, and needs a wirescope
  proxy new enough to report it — on an older one the bar looks unchanged.
- The drawer bar's **Export** and **Clear** buttons are now icons, matching the
  ones already next to them. Same actions, hover for the label.
- A team role that names a prompt, template, exec command or append file which
  isn't installed now says so, instead of the seat quietly booting without it.
  A missing role prompt used to be swallowed: the seat came up unbriefed, behaved
  oddly, and nothing anywhere mentioned the file. Now the team's roles popover
  (right-click a team's sidebar header) shows a per-role checklist of what the
  manifest names and the box doesn't have, and every spawn path — `[agent:spawn]`,
  ticket dispatch, the reviewer, a GUI create — reports it once on its own
  channel. Nothing is blocked: the seat still spawns and the warning rides
  alongside. Missing prompts and templates read as warnings (the seat's behaviour
  breaks); an append file the template names but nobody has written yet reads as a
  note, since that's the normal state of a team someone just created. Create
  Team… lands on that popover, so a new team's first screen is the list of files
  it still owes. The exec check covers everything the command actually needs —
  the script it runs, the directory it runs in, and whether the command is
  even well-formed enough to run at all — so a command that would fail on every
  call can't show a tick.

- Teams work on your own projects, and there is now a guide for it —
  `docs/teams.md`, written for someone standing a team up on a codebase that
  isn't Clodex. It covers what `Create Team…` gives you and the handful of
  things only your project can supply: the project-knowledge prompt file, exec
  grants that point at your own scripts, and what happens to the ticket loop
  when a project's tests live somewhere else or don't exist at all (it
  escalates to the lead rather than failing anyone's work).

- A seat template can now write `"cwd": "${TEAM_ROOT}"` and boot in whichever
  team spawns it, instead of hardcoding one project's path. The shipped hand
  template does this, so a new team's seats start in their own repository. The
  old behaviour was a quiet one: copying a working template to a second project
  booted its seats in the FIRST project, while their tickets lived in the
  second — everything looked fine and the work landed in the wrong tree. If the
  token can't be resolved, the spawn is now refused with an explanation rather
  than guessing a directory.

- "Keep warm — Always (until stopped)" now survives an app restart. It used to
  come back only when the agent took its next turn, which on an unattended seat
  meant never: one measured restart left a seat with keep-warm switched on for
  5.5 hours without a single ping, the cache going cold the whole time — the one
  mode that exists for when nobody is watching was the one that quietly stopped.
  Clodex now re-arms those holds at startup on its own. Unchanged: it still only
  pings a cache that is still warm, so a seat whose cache lapsed during a long
  shutdown stays quiet rather than paying to rebuild it, and timed holds (2h,
  4h…) behave exactly as before.

- A seat spawned by an agent no longer steals the keyboard while you are
  typing. Previously a ticket seat or an `[agent:spawn]` appearing mid-sentence
  would jump focus to itself, and the rest of the line you were writing went to
  the new session instead of the one you meant. Agent-spawned sessions now
  appear in the sidebar without taking focus, and a session you create yourself
  still opens focused as before — except while you have a half-typed line open,
  which nothing interrupts.

## 5.9.0 — 2026-08-15

- The internal wire log stops growing forever. `~/.clodex/wire-shadow.jsonl` is
  a forensic record nothing reads back automatically, and with no retention at
  all it had reached 61MB on one machine — around 1.9MB a day. It now keeps
  high-volume traffic for 14 days and prunes what is older, so it settles at a
  steady size instead of climbing. Existing oversized logs start shrinking on
  the next launch; no action needed.

- The rare records in that log — errors, dropped intents, wire failures — are
  now kept indefinitely, in a separate `wire-shadow-diag.jsonl`. Those are the
  entries anyone actually goes looking for after something breaks, and they
  amount to a few megabytes a *year*, so there is no reason to ever age them
  out. Splitting them off is what makes pruning the bulk safe: diagnostics
  already in your existing log are moved across rather than deleted.

- The terminal intent marks no longer light up every sentence that merely
  *mentions* an intent. Agents discuss intents constantly, and a mark on each
  of those lines turned the screen into a mosaic that hid the handful of real
  emissions. A mark now needs the `[agent:…]` to start the line, exactly as
  firing does — so the warning colour is back to meaning what it should: a
  line that was written to fire and didn't.

- An intent mark now highlights the `[agent:…]` itself rather than washing the
  whole terminal row. An intent starts its own line, so most of that row was
  empty terminal getting a background — and on a `[agent:dm …]` the wash ran
  over the message body too. The scrollbar tick is unchanged, so finding an
  intent without scrolling still works exactly as before.

- A task that starts a seat but loses its spec now says so. Starting a ticket
  could mint the worktree, the branch and the seat, record the ticket as
  assigned with its spec attached, and leave the seat holding nothing — it
  would see the team roster, correctly conclude it had no task, and stand by.
  Nothing looked wrong from outside: a live seat, idle, a healthy record, and
  the first sign was a person noticing the silence. Two things kept it quiet.
  A ticket was marked delivered once its spec entered the write queue rather
  than once the seat was actually written to, and a ticket marked delivered is
  never sent again. And the 90-second check built to catch a spec that never
  landed stood down for any turn the seat took — including a turn spent
  reading something else entirely, which is what happens seconds after a seat
  starts. Clodex now marks a spec delivered only once it has really gone out,
  and only counts a turn as proof when the seat's own transcript shows it read
  that spec; anything else leaves the check armed, so the spec is re-sent and
  then escalated to the lead rather than lost in silence.

- Review seats now read a large file in one pass instead of paginating
  through it. A reviewer's whole job is reading the diff it was handed, and
  it was being handed one in 25000-token slices — so it spent turns on
  bookkeeping before it could say anything about the change. Bigger diffs
  were where it got worse, which is backwards. If you have edited your own
  copy of the reviewer template, Clodex leaves it alone on upgrade and it
  keeps the old limit — add `CLAUDE_CODE_FILE_READ_MAX_OUTPUT_TOKENS` set to
  `60000` to its `env` yourself.

- An intent an agent writes in **bold** or *italics* now fires instead of
  being silently ignored. Agents reach for emphasis when a line matters — a
  review verdict, a handoff — and that was exactly the line that vanished:
  the work was done, the message was written, and nothing was delivered.
  Markdown bullets are untouched, so a list item that merely starts with a
  star still does nothing, and quoted examples stay quoted.

- Custom subagents no longer travel on the seat's command line. Enabling one
  used to spawn the CLI with the whole agent definition — prompt included —
  inline in `--agents`, where anyone running `ps` could read it and where a
  long enough roster would eventually hit the argument-length limit. They now
  install the same way skills do, through a session-only plugin directory
  under `~/.clodex`, so nothing about them is visible in the process list.

  **This changes how the model calls them.** A library subagent is now
  dispatched as `clodex-agents:<name>` rather than `<name>` — the CLI
  namespaces plugin-supplied agents and accepts no short form. Nothing needs
  changing for the model itself, which reads its roster fresh each session,
  but a *skill* of yours that names a subagent explicitly (`subagent_type:
  "test-runner"`) needs the prefixed name. Clodex warns at spawn, naming the
  skill and the form to use, whenever an injected skill calls an agent the
  session cannot reach.

  One trade came with it: `permissionMode`, `initialPrompt`, `hooks` and
  `mcpServers` in an agent's frontmatter are ignored on this path. None of the
  bundled agents uses them; if one of yours does, a spawn now warns rather
  than letting the field quietly do nothing.

- Intents an agent emits are now marked in the terminal, with a tick in the
  scrollbar lane, so you can see at a glance whether one was actually sent
  instead of scrolling back through a wall of prose to look for it. Lines that
  only LOOK like an intent and will silently do nothing — prose ahead of the
  bracket, a mistyped verb — get a differently coloured mark, which is the case
  that used to cost a turn before anyone noticed. Quoted examples (escaped
  `\[agent:…]` or inside a code fence) are deliberately left unmarked.

- The per-session Skills popover shows the skills the session actually has
  again. If a project defines directory-scoped skills (a `.claude/skills`
  folder that only applies under, say, `app/`), those were taking over the
  list — the popover offered skills the session could not use, while some of
  the ones it really had loaded went missing and could not be turned off.
  Scoped skills are still listed, but greyed out and labelled with the
  directory they apply under, so it is clear which ones this session can
  actually toggle.

## 5.8.0 — 2026-08-14 — agents that get themselves unstuck

- The ticket watchdog gained a middle rung: before the lead is alarmed about a
  stalled ticket, a seat that is demonstrably wedged gets one automated wake —
  a single injected line asking it to resume, nothing new. A hand that lost a
  turn to an API error recovers on its own instead of waiting for the lead to
  notice and poke it by hand. The bar for writing into a terminal is high,
  because every injection destroys whatever is sitting unsubmitted in the
  composer: the seat must show no transcript growth and no CPU anywhere in its
  process tree across two consecutive sweeps, be idle, hold no unanswered
  delivery, and have no operator draft open — and all of it is re-checked at the
  last instant before the write, which is cancelled if anything changed. A seat
  gets at most one wake per stall window no matter how many of its tickets are
  stalled, since it has only one composer. If the wake produces no turn within
  90s the lead is alarmed as before, now told that the wake was already tried.
  The lead's first alarm is delayed by at most the wake's grace and confirm
  windows, and never suppressed.

- The watchdog's seat-liveness probe now measures CPU across the seat's whole
  process tree instead of the CLI process alone. A seat inside a long tool call
  (a build, a test run) keeps its CPU in the child while its transcript stays
  flat and its activity reads idle — all three signals pointing the same wrong
  way, so a perfectly healthy seat was classified as wedged. Measured twice on
  one box. This also changes the existing review-step probe, deliberately and in
  the safe direction: a reviewer running a long verify child now reads as
  running rather than wedged, and a genuinely wedged reviewer still alarms.

- `[agent:remind list]` no longer shows a blank preview for a reminder whose
  body was written on the lines following the intent line. The reminder was
  always stored complete and always fired complete — only the listing was
  wrong, so nothing was ever lost. It read as an empty body, which is worse
  than it sounds: a readout that reports present data as absent teaches a rule
  that is not true. The same first-line preview is now shared with the memory
  index and the memory digest, which were not affected but would have been by
  any change to how those bodies are stored.

- The parked-message preview no longer reads "(no preview)" for a message that
  has one. A dm whose body was written on the lines following the intent line
  previewed its empty first line, so the sidebar fell back to the generic
  marker — the message itself was always parked and delivered intact. Same
  first-line preview as the reminder listing above.

- A reminder can now be tied to the ticket it is about, and dies with it. Write
  `[agent:remind for t42 in 40m] check the branch landed` and the reminder is
  cancelled automatically once t42 is cancelled, or accepted in a way that
  actually closes it out — so a check you armed at dispatch cannot fire hours
  later carrying instructions about work that is already finished, describing a
  state that has since moved on. An accept that reports the branch as unmerged
  (or cannot check) keeps the reminder, because it asks you to merge and accept
  again — that is the moment "check the branch landed" is most wanted, not
  least. Reporting a ticket `done` does not cancel it either: a rejection
  reopens the ticket, and the reminder is still wanted through the rework round.
  The binding is explicit — nothing is guessed from the reminder's text, and
  binding to a ticket that does not exist, or that is already closed out and so
  could never release the reminder, is refused outright rather than quietly
  armed.

- A rejection that never reaches its seat now says so. When a ticket is sent
  back for rework, Clodex watches that the seat actually starts a turn on it;
  if the message was swallowed, it redelivers once and then tells you the seat
  was never told — instead of reporting it as a seat that stalled, which is the
  same silence with the wrong cause attached.

- A message to an agent that never reads it now tells you. If a dm is typed
  into a seat and that seat never starts a turn, the sender is told about it
  roughly a minute and a half later, and the event shows up in the IPC log.
  Nothing is re-sent automatically — the resend is yours to make, because only
  you know whether the message is safe to repeat. The wording hedges on
  purpose: when several messages are outstanding at one seat there is no way to
  tell which of them landed, so it says they may not have been seen rather than
  claiming a loss it cannot prove.

- A stalled-ticket alarm now says when the seat may simply never have been
  told. Previously a seat that swallowed its instructions looked exactly like a
  seat stuck on the work, and every reaction that follows from that reading is
  the wrong one.

- The test that guards the suite's own mutex no longer blames the code it is
  testing when the fault is its own. If the harness launched the script and got
  no answer back at all, it used to report that as "the script wrote nothing" —
  an accusation against the file under test, which sent a reader off to diff
  something that was never at fault. It now tells those two cases apart, says
  plainly which one happened, and retries only the case where it heard nothing.
  A run that answers *wrongly* is still failed on the first attempt at full
  strength, and a genuine deadlock still goes red — a test made robust by
  dropping what it detects would be worse than the flake it hides.

## 5.7.0 — 2026-08-14 — tickets that run themselves

Most of this release is one story: a ticket now goes from a written spec to a
merged branch without anyone driving it. You file it, you start it, and Clodex
mints a worktree and a seat, delivers the spec, runs the suite, sends the work
to a cold reviewer that has never seen it, hands back rework with the must-fixes
attached, and merges when the review approves — reporting to the team lead only
when something needs a decision. Everything under it is the detail of making
that boring: work that gets dropped now gets noticed, alarms name what they
measured instead of guessing, and costs are attributed to whoever spent them.

The parts you notice outside that: a peer terminal survives a window reload
instead of coming back blank and leaving a shell running on the other machine,
and the Tickets panel works without a team and lets you edit the board.

- A peer terminal survives a window reload, and stops leaving a shell running on
  the other machine when it does not. Reloading the window left the far side
  still streaming for a seat nothing was watching any more — a live connection
  and a real shell process on someone else's box, held open by a view that no
  longer existed and with nothing left that could ask it to stop. Re-showing the
  seat then painted a blank pane, because the connection it needed was already
  taken. Closing a window did the same thing, permanently. Peer terminals are now
  owned by the window watching them and are released when it reloads or closes,
  so the shell on the other side goes away with the view, and a reloaded terminal
  comes back with its scrollback. Two windows watching the same seat no longer
  interfere: closing one leaves the other's terminal alone.
- A long review no longer gets reported as a stalled one. The ticket loop's
  stall alarm measured only how long a step had been running, so a reviewer
  working steadily through a large diff was announced as stuck once it passed
  the window. It now checks the reviewer itself before raising the alarm, using
  two signals rather than one: a review that is writing, or that is thinking
  about what to write next, is left alone. A genuinely stuck reviewer is still
  reported, and now names the seat and what was measured about it. Where the
  second signal cannot be read, the alarm still fires and says so rather than
  claiming more than it knows.
- A reviewer template that names a model is now honored. Setting `--model` in a
  reviewer template had no effect: the review path discarded the template's
  arguments wholesale, so every reviewer spawned on the default model however it
  was configured. `--model` is now carried through on its own — the rest of a
  template's arguments are still refused, deliberately, because a reviewer's
  whole premise is a tool cap that raw CLI arguments would walk straight past.
  A template whose `--model` names nothing usable now says so when the reviewer
  spawns, rather than falling back to the default model in silence — a silent
  fallback is the same failure one layer in.
- A reviewer that never starts is now restarted automatically instead of
  sitting silent. A freshly spawned reviewer seat can receive its scope and
  never take a first turn: the message that starts it is swallowed whole, and
  because the seat stays alive and idle every signal reads healthy, so nothing
  noticed until an operator happened to look. Clodex now re-sends the start
  nudge once, which is measurably enough to recover the seat, and reports it to
  the team lead only if the seat is still silent after that. The re-sent nudge
  carries no scope — the scope was never the part that got lost.
- A ticket whose seat no longer exists now says so. Previously it was reported
  as a quiet hand — advice to wait for a seat that had been retired — and once
  that first alarm had fired the ticket went permanently silent. It now names
  the situation and its three exits: reassign, cancel, or park.
- Terminal exec no longer loses characters out of the command it types. It
  abandons the current line, then waits for the shell's answer to go quiet
  before typing, because the signal that clears the line also discards input
  written alongside it — an operator running a command into a busy terminal
  could previously see a mangled command run, or `command not found` for a
  fragment of one. A one second ceiling on that wait means a shell that never
  stops talking still gets its command.
- The must-fix placeholder check no longer stalls on a long run of emphasis
  characters, and tolerates a trailing period after the placeholder
  (`**(none)**.`). A blockquote or other line prefix is still not emphasis, so
  `> *(none)*` continues to count as a must-fix.
- A test run that crashes or times out now keeps its output too, and saved
  output can no longer overwrite itself. The previous change kept the output
  of runs that FAILED; a run that died or hung was still reduced to its last
  few lines, even though it reverts the merge just the same. Saved files are
  now stamped, so a ticket reviewed more than once cannot overwrite its own
  earlier evidence, and they are published by rename — a save that dies
  partway can no longer leave a half-written file that reads as complete.
- The same failing output is now kept when a merge is undone. Clodex merges
  a reviewed branch, runs the suite again, and reverts the merge if that
  run fails — but the output of the run that justified the revert was
  discarded, which is the one report you cannot get back by re-running,
  since the tree has already been reverted underneath you. It is now saved
  and named in the escalation, and the message tells you to re-run instead
  only on the paths where the merge was actually undone. A save that fails
  no longer leaves a half-written file behind looking like the real thing.
- A reviewer's "no must-fixes" is now understood however it is emphasised.
  Clodex merges a reviewed branch automatically when the verdict accepts it
  and lists no must-fixes — but it read the list literally, so a reviewer
  who wrote the empty list in bold or italics had the merge refused and
  escalated as though the branch still had work outstanding. Markdown
  emphasis is now stripped before the list is read. The check that matters
  is unchanged in the other direction: a verdict that lists real must-fixes
  still blocks the merge, and a single-item list is still a list, not a
  placeholder.
- When the ticket loop sends a branch back because its tests fail, the
  failing output is now kept. The loop ran the suite, read the one-line
  summary, and threw the rest away, so the agent was told THAT its branch
  was red and had to reproduce the run to find out how. The loop now saves
  the run's output per ticket and per round, and names that file in the
  rework it sends back. If saving fails, the rework still goes out and says
  why there is no file — a rejection with no evidence is still a correct
  rejection.
- The team lead is now told when the ticket loop sends work back. A branch
  whose test suite fails is returned to the agent that wrote it, which was
  always the right recipient — but the lead only heard about it when that
  delivery FAILED, so the ordinary case was invisible to the person
  responsible for the ticket. The lead now gets its own summary: which ticket,
  which agent, how many rounds deep. The failing-test detail still goes only
  to the agent that has to act on it.
- A lead rejecting a ticket that the loop has just rejected no longer bounces.
  The two used to race: the loop reopened the ticket, and the lead's own
  rejection was then refused with an error reading as though it had already
  been handled, while the must-fixes it carried were left in a file nobody
  reads. Those must-fixes are now delivered to the agent as follow-up rework.
  Rejecting a ticket that never closed still points you at `task respec`,
  which remains the verb for that.
- A follow-up rework that could not be delivered no longer resets the ticket's
  stall timer. It used to count as activity whether or not it arrived, so a
  ticket that was going quiet for the worst reason — nobody could be told about
  it — bought itself another full window of silence before the watchdog spoke
  up. It is also no longer told that "no live seat holds" a ticket the lead is
  in fact holding itself.
- When a test run fails, its output is now kept instead of thrown away. The
  one-line summary that agents run tests through reported which tests failed but
  discarded everything explaining why, so the next step was always to run the
  whole suite again just to read the error — and a failure that only shows up
  under load might not come back. The full output of a failing run is now saved
  to a file the summary names. Large assertion diffs survive it too; they were
  being truncated at exactly the point the interesting part began.
- Two tests that failed at random under load now pass reliably, and for the
  right reason. Both were waiting out a fixed stretch of wall clock and then
  asserting on work that a busy machine had not started yet — so the suite went
  red on a healthy build often enough to make a green run stop meaning much.
  They now wait for the work itself: the hint test for the ranking pass to run,
  and the terminal-attach tests for the session token to arrive before typing
  into it. Waiting longer would not have fixed either one.
- The wire proxy's tests no longer wait out fixed stretches of wall clock
  before checking their results. Where the check was genuinely racing the work
  — the compressed responses, and the case where the client hangs up
  mid-stream — a slow machine could read the answer before it existed and fail
  a healthy build. They now wait for the event they are actually about.
  Elsewhere the wait was simply dead time, and the suite is quicker without it.
- A ticket whose review comes back ACCEPT is now merged for you. The team lead
  used to be the one running `git merge` after every verdict; the loop now does
  it, runs the full suite on the result, and reverts the merge if that suite
  goes red. Anything it will not do by itself — a checkout that is dirty, a
  branch that moved, a suite it was not allowed to run — comes back to the lead
  as a message naming the commit and the exact command to undo it, rather than
  being guessed at. Merges never overlap each other or a test run you started
  yourself. Nothing is pushed, and the changelog and the final `task accept`
  stay yours.
- A review that approves a ticket and says so no longer blocks its own merge.
  Reviewers write their verdict's must-fix section as "(none)" and then explain
  why nothing needs fixing; that explanation was read as the list of things to
  fix, so the auto-merge refused an approval that had no objections in it and
  sent the lead to resolve a contradiction that did not exist. A section that
  opens by declaring no must-fixes now declares none, whatever follows it. An
  approval that really does list must-fixes is still refused, unchanged.
- The "Clodex restarted" notice now reaches an agent in seconds rather than
  minutes. If a pane had an unsent draft open in it, the notice waited on a
  five-minute fallback, and opening two workspaces made it worse — the second
  one's restore cancelled the retry the first had scheduled. The notice now has
  its own short deadline and is delivered once, not once per workspace. It still
  never interrupts something you are in the middle of typing: it waits for the
  pane to go quiet first, for as long as that takes.
- Running the tests no longer writes to your own `~/.clodex`. Building the app's
  internals inside a test seeded the real library, materialized real scripts and
  swept the real agent registry — so a full suite run quietly edited the same
  directory the running app was using. Tests now build against a temporary root,
  and one that forgets to now fails loudly instead of reaching for your home
  directory.
- A hand working in a ticket's own worktree can now verify that worktree. The
  granted test command measured the team's main checkout for every seat, so a
  hand running it against its branch was handed the main checkout's result —
  green, and about code the hand had never touched. It now takes the tree to
  measure, refuses a path that is not a worktree of this repo rather than
  quietly falling back, and names the tree in its answer.
- A ticket dispatched to a seat that never picks it up is now reported. Four
  times in one night a seat was handed a spec and simply never started, and
  nothing distinguished that from a seat working normally — the log recorded
  only that the send was attempted. A dispatch that produces no sign of life is
  now redelivered once and then escalated to the lead, and a spec parked for a
  busy seat is correctly left alone rather than resent to a seat that already
  has it.
- A dispatched ticket now tells the seat how to close it. Every dispatch is
  long enough to arrive as an attachment, so the one line a seat sees before
  deciding whether to open it had to carry the ticket's id and the closing
  command — otherwise the instruction for finishing the work sat behind the
  very step it was meant to save.

- A ticket whose spec turned out to be wrong can now be corrected in place with
  `task respec`, rather than cancelled and refiled — which burned its id, its
  history and the link to its notes. If the ticket is already with a hand, the
  corrected spec is delivered marked as a correction, so the hand keeps its
  working tree and its context instead of starting over. A ticket nobody is
  working on yet is corrected on the record, and the reply names the verb that
  will send it.
- The guard that checks every intent in the code is exercised by a test now
  reads the code as code. It had been pairing quote characters over raw bytes,
  so a backtick inside a comment opened a "string" that ran on for lines —
  dropping real intents from the set it checks while collecting a thousand
  fragments that were never intents at all. Comments, regular expressions and
  nested template interpolation are now understood, and the count the guard
  reports is one you can trust.
- That same guard now also refuses to read a predicate it does not understand,
  rather than quietly reporting on the part it could parse.
- The guard that keeps the intent parser and its test corpus in step now also
  covers the sub-verbs that decide how an intent's body is read. That set is
  derived separately from the one the earlier guard checks, so a sub-verb could
  be added to it and go untested — the same way one went untested for a full
  release cycle before.
- A ticket reviewed more than once now reports each round's cost separately.
  The review seat was named from a counter that is freed when a seat retires,
  so a second round could reuse the first round's label — or come out ordered
  backwards. The round is read from the ticket itself now, and the seat is
  named for the ticket and round it belongs to, so it is also findable in the
  roster while it works.
- A ticket's automatic test run no longer reports green over a dependency set
  the branch has stopped declaring. It compares the branch's declared
  dependencies against the checkout it borrows `node_modules` from, and holds
  the ticket for you instead of reviewing work whose suite only passed because
  the borrowed tree still carried a package the branch dropped.
- `node_modules` is ignored again on a fresh clone. The entry only matched a
  real directory, so the symlink a ticket run creates showed up as an untracked
  change on every machine except one that happened to carry a local exclude.
- The guard that keeps the intent parser and its test corpus in step now covers
  `[agent:team …]` as well as `[agent:task …]`, and a new check makes sure a
  future family of sub-verbs cannot be added without being covered too — whatever
  its verbs are spelled with. A sub-verb went untested for a full release cycle
  this way.

- A stalled ticket's alarm now tells you what the seat was actually doing. It
  names the seat's last tool call — and distinguishes a call still in flight
  from one that died mid-write — alongside the branch's commit count and
  whether the tree is dirty. A dirty worktree on its own never separated a
  working seat from one killed mid-turn, which is how a genuinely dead seat
  got dismissed as busy.
- A stall that nobody answers now re-escalates on a doubling schedule
  (30m, 1h, 2h, 4h) instead of speaking once and going quiet. The doubling is
  what keeps an unattended stall visible without flooding the prompt stream:
  an 8-hour stall speaks about five times, not sixteen.
- The stall watchdog no longer alarms about tickets that were filed but never
  started. Opening a ticket for a role records that role as the assignee, so a
  backlog ticket looked dispatched to the watchdog even though no seat was ever
  spawned and nothing could be stalling. Twenty-eight open tickets were in that
  state, and with the new escalation schedule above they would have produced
  roughly 140 alarms a night about work nobody had started.
- A ticket's verify step now runs the test suite in the ticket's own worktree
  before a reviewer is spawned, so nobody is asked to review a branch that does
  not build. The suite runner gets its own process group and is killed as a
  group on timeout: it blocks in a synchronous spawn, so the previous kill left
  the inner test process running and still holding ports, which deadlocked the
  next run against a lock it had inherited.
- Fixed a packaging test that only ever passed in a checkout where a build had
  been run: it asserted the existence of directories that are gitignored and
  untracked, so it failed in every fresh clone and every ticket worktree.
- The ticket board no longer flags filed-but-unstarted tickets as stalled, and
  a ticket dispatched from the board is now recorded as started. The board kept
  its own copy of the stall rule and did not get the fix above, so the same
  twenty-eight tickets stayed lit on screen. Fixing only that would have been
  worse than the bug: assigning a ticket from the board delivers its spec but
  never stamped a start time, so a board-dispatched ticket would have read as
  never-started forever — invisible to the board's flag and to the watchdog
  alike. A stall nobody is told about is the more expensive direction.
- A ticket's artifact directory is now found anywhere in its spec, not only on
  the first line. A spec that named its task dir lower down left the review
  step with nowhere to write the diff, so it computed one and threw it away —
  measured nine times in a night, the largest discarding 78KB, twice on the
  tickets that fix the review loop itself. The scan is a strict superset, so
  any spec that resolved before resolves to the same directory now. The loop
  also checks that a destination exists before spending a full-branch diff on
  it, and when there is none it names a recovery that works: the suggested
  command is parsed by the real intent grammar and exercised end to end, so
  renaming an intent breaks the test rather than quietly leaving the advice
  pointing at a command nobody can run.
- Fixed a stall-sweep test that could not have caught the bug it was written
  for. Every exemption fixture had a single-element board, so an exemption
  that skipped the entire remaining sweep instead of just its own ticket
  looked identical to a correct one, and would have silenced every alarm after
  the first exempt ticket with the suite still green.
- A review verdict on a ticket now tells the lead it arrived. It was written
  to the ticket record and nowhere else, so the only way to learn a review had
  finished was to poll the board — while an ad-hoc review scoped by a path
  reported back normally. The record is still the source of truth and the full
  verdict is still kept out of the inbox, since one measured verdict ran to
  nearly 16KB; what arrives is a summary with the verdict, the round and the
  must-fix count. The full text is written beside the ticket's review diff in
  its own task directory, so it outlives both the reviewer and the half-hour
  sweep that used to be the only copy.
- Two agent commands of the same kind in one message no longer collapse into
  one. Their de-duplication key ignored the ticket id, so `[agent:task start
  t1]` and `[agent:task start t2]` looked identical and the second was dropped
  with no error to the sender — measured on two ticket approvals emitted
  together, where only the first took effect and the second's worktree and
  branch survived unnoticed. It affected every command carrying an id, and
  `team role-rm` across different roles. Genuine double-pastes still collapse,
  which is the direction that matters: the key can only tell more things
  apart, never fewer.
- Fixed a test that had been passing without checking anything since the
  `task start` command was added. It compares the command parser against a
  frozen copy of the parser it replaced, over a corpus harvested from three
  test files — and the file exercising `task start` was not one of them, so
  the frozen copy never learned the command and the comparison stayed green.
  The corpus now asserts that every command in the real grammar appears in it,
  so the next command added cannot slip through the same gap.
- A repeated stall alarm now says which rung of the escalation ladder it is on.
  Every alarm from the second onward said "repeat 1", so the 1h, 2h and 4h
  warnings were indistinguishable from each other and the number was simply
  false — in a message whose whole purpose is to be trusted when it says
  something is wrong.

- A retired role field in `team.json` now says so on load, instead of vanishing
  once the file claims a current schema version. `roles.reviewer.tools` looks
  like a capability restriction and enforces nothing — the real cap is in code —
  and a version-stamped manifest dropped it in silence, so the file kept reading
  as policy. The warning partitions by measured effect rather than by key name:
  a key is described as still-read only when deleting it actually changes the
  role, which matters because `worktree` is honored for an exact `true` on a
  non-reserved role with no explicit `dispatch` and inert everywhere else.
  Telling the owner of an inert `worktree: false` to "write `dispatch:
  \"worktree\"` instead" would have converted a standing role into one that
  mints branches nobody asked for.

- Reporting a ticket done now runs the review, instead of asking the lead to.
  `[agent:task done]` recorded the report and stopped there: the lead had to
  notice the ticket, check the branch existed and carried commits, materialize
  the diff, assemble a scope out of the spec and the report, and only then spawn
  the reviewer — six manual steps per ticket, every one of them the same. Closing
  a ticket now verifies its tree (the branch exists, the base is an ancestor of
  its HEAD, there are commits to look at), writes the diff, builds the review
  scope from the ticket's own spec and report, and spawns the cold reviewer
  itself. Anything that stops it — a missing branch, no commits, a base that
  drifted, a reviewer that cannot be spawned — is escalated to the lead with what
  it found and what it had already done, so a loop that stops says why. The lead
  still merges, and still only after a verdict.

- The terminal's shell refusal no longer reads as a version treadmill. When your
  shell is a bash too old to report command results, the message used to name two
  version numbers and point at Homebrew — which reads as "your machine is behind"
  when the truth is the opposite. bash 4.4 is from 2016; macOS still ships 2007's
  3.2 as `/bin/bash`, so the newest Mac reports the same version as the oldest.
  The refusal now says that, says nothing needs updating, and offers zsh first —
  it has been the macOS default since 2019, so it is already there and needs no
  install. It also tells you to restart Clodex afterwards, without which the
  advice quietly does not take: the shell is read from the app's own environment
  at launch, so changing it and opening a new tab reproduces the same refusal.

- Filing a ticket and starting it are now two acts. `[agent:task add]` wrote the
  ticket and immediately minted its branch, its checkout and its teammate, so a
  lead who wanted to think about a ticket before running it had to remember to
  park it — and "do not start yet" written in the body was read by nobody. `add`
  now writes the ticket and starts nothing; `[agent:task start <id>]` mints the
  tree and the seat and delivers the spec. A ticket you have not started is
  simply one you have not started, and the board says so.

- A cold reviewer's verdict on a ticket now lands on the ticket. It was delivered
  to the lead as a message, so the finding of a full review existed only in one
  agent's conversation: if that agent compacted, or the reviewer's report arrived
  while it was busy, the verdict was gone and the review had to be paid for
  again. The verdict, its must-fixes and its round number are written to the
  ticket record, which outlives every seat involved. A review you asked for
  yourself with `[agent:team-review]` still reports back to you, unchanged.

- A cold reviewer now boots already knowing what it is reviewing. The scope you
  pass to `[agent:team-review]` was sent to the new seat as a message, which meant
  it arrived at the seat's first turn — and a message written while the CLI is
  still drawing its interface is wiped by it. The seat then sat idle, looking like
  it was thinking, holding a briefing that said how to review but not what; the
  lead had to notice and resend. Six times in one day. The scope is now part of
  the reviewer's prompt, present before it takes a turn at all, so there is no
  moment at which it can be lost — and it survives a compact, which the message
  did not.

- How a role gets its work is now a named choice you can see and change. Whether
  a ticket went to the role's live seat or minted a fresh one in its own branch
  and checkout used to be a `worktree: true` boolean that only a hand-edit of
  `team.json` could set — a field with two behaviours, one of which had no name.
  It is now `dispatch`, set from the team popover's Roles section: `standing`
  hands the spec to the seat already holding the role, `worktree` gives the
  ticket its own branch, tree and teammate. Existing team files keep their
  setting; the old key is still read, so a file nobody has edited behaves as it
  did before, and is rewritten the next time any role changes.

- Ticket branch names are readable again. The branch was slugged from the
  ticket's first line, which is also where the dispatch format asks for a link to
  the task folder and where a lead naturally writes the ticket number — so the
  branch ended up repeating the number, swallowing the folder path, or, when a
  lead guessed the number before the board issued one, asserting a ticket that
  does not exist. The slug now drops a leading number and any folder path, and
  truncates on a word boundary rather than mid-word. The ticket's link to its
  folder is unchanged; only the branch name is.

- Finishing a ticket is now one step. `[agent:task accept <id>]` closes it,
  retires the seat, removes its worktree and deletes its branch — but only after
  git confirms the branch really is merged into the base. If it is not merged, or
  if the check cannot run at all, nothing is removed and it says why. Accepting
  also records which session did the work, so a seat can be brought back later
  for a hotfix instead of being reconstructed from scratch.

- Retiring a seat no longer claims a directory has uncommitted work when it
  simply is not there any more. Removing a merged worktree before retiring its
  seat — the correct order — made the confirmation report uncommitted changes in
  a directory that had just been deleted, and tell you to go commit them. It now
  distinguishes a tree it could not inspect from one that is genuinely dirty.
  Both still archive the seat rather than discarding it.

- Asking for a test run while one is already going now says so, instead of
  timing out. The refusal existed but could never be seen: the script waited the
  full 120 seconds before printing it, and the exec entry killed the run at
  exactly 120 seconds, so the caller got an unexplained timeout. It now gives up
  after 30 seconds and reports which run holds the suite and how long it has been
  going — enough to tell a healthy run from a wedged one.

- The Tickets panel no longer needs a team, and can now edit the board. It used
  to find boards by walking the list of teams, so a project without one showed
  nothing at all; it now lists projects directly, with team membership shown as
  extra detail where it exists. Tickets can be opened, re-specced, assigned to a
  live session, closed and cancelled from the panel — previously it was
  read-only and every change had to go through an agent. Editing is desktop-only;
  the browser frontend stays read-only. Note that closing a ticket here does not
  hand the seat its next ticket or write the cost record, which `[agent:task
  done]` still does.

- Tickets no longer require a team. `[agent:task add/list/done/...]` used to
  refuse outright unless a `team.json` owned the session's directory, so filing
  a note to yourself meant first inventing a team to be your own lead. The verbs
  now work in any git repository, keyed to that repo's ticket board — the same
  board a team in that repo would use, so tickets filed solo are still there
  after a team is created. Outside a git repository the verbs still refuse,
  since there is no project for a ticket to belong to.

- Ticket boards copied to the new per-project location now re-sync themselves.
  The copy ran once and was then locked, so a board copied while a ticket was
  still being worked kept the half-finished version forever — one ticket showed
  as open after it had been closed, and the stall watchdog nudged about it. Each
  launch now refreshes any record the old board has a newer version of, and stops
  doing anything once the old board goes quiet.

- Bundled wirescope updated to v0.6.51. The `/_session` view labelled each block
  with its position in the request payload, which looked like a count of how many
  times that message had been sent and was not one — a request carrying a message
  plus the system message alongside it showed as two calls when only one crossed
  the wire. Blocks now read `call 3 x16`: which call first carried it, and how
  many have re-sent it since. The header gains an API-calls count next to turns.

- The ticket board now belongs to the PROJECT rather than to the team, so two
  teams working one repo share one board instead of each keeping a private list
  the other cannot see. Existing boards migrate themselves on first launch: your
  tickets are copied, never moved, and the old file is left where it is. A board
  that cannot be read is skipped and retried next launch rather than replaced.

- Seat spawn/retire notices now go to the team lead alone. Every seat on the
  project used to get them, so a hand mid-task was woken to be told that an
  unrelated reviewer had restarted — news it cannot act on. Who is up is the
  lead's business. Each seat still boots with an accurate roster; only the
  interruption is gone.

- A reviewer template whose `tools` is not a list, or is an empty one, no longer
  spawns a reviewer holding every tool the cap allows. Both cases used to be
  indistinguishable from leaving `tools` out, so a typo in the template granted
  more than it asked for — the one direction that should never happen by
  accident. Each is now refused with the edit that fixes it: make the value a
  list, or put allowed tool names in it. Leaving `tools` out still means "accept
  the full set", unchanged.
- A cold review is now refused, with an explanation, when the reviewer template
  asks for tools that share nothing with what a reviewer is allowed
  (`Read`/`Grep`/`Glob`). That combination used to spawn a reviewer with every
  tool disabled — a seat that could not open the diff it was reviewing, and
  reported on it anyway. The refusal names what the template asked for and what
  is allowed, and no reviewer name is consumed. Templates that narrow to some of
  the allowed tools, or name none at all, are unaffected.
- A reviewer template's auto-compact opt-out now applies to the reviewer seat.
  Turning auto-compact off in a template used for cold reviews had no effect —
  the setting was read on other spawn paths and skipped on that one, so the seat
  compacted anyway with nothing to say it had. Templates that do not set the
  field are unaffected.
- A template environment key that is refused now says which of the two problems
  it hit, on every path that spawns a seat. A key outside the allowed set needs
  operator approval; a key whose value is not a string needs the value quoted.
  One path reported the second as the first, sending operators to ask for
  permission they already had.
- Ticket cost is now attributed to the seat that actually did the work. A
  ticket filed against a role is recorded against the seat it was handed to,
  including when the original seat died and a sibling picked the work up on the
  next respawn. Previously the record kept naming the seat the ticket was first
  pinned to, so a rollup could publish a dead seat's lifetime spend under work
  somebody else did. Where the record and the delivery disagree about who
  worked it, the cost says the seat is unknown rather than picking one.
- Ticket boards name the role a ticket was filed under rather than the seat it
  was handed to, in the tickets viewer as well as the built-in boards. Replies
  suggesting a recovery command name the role too — suggesting a seat that has
  since gone would hand back a command that bounces.
- A team role now declares only the four things something actually reads:
  `template`, `prompt`, `brief`, and `dispatch`. The other five —
  `instantiate`, `standing`, `tools`, `type`, `ephemeral` — were declarations no
  spawn path consumed, so setting one changed nothing while reading exactly like
  configuration. `tools` was the worst of them: a role that appeared to cap a
  seat's tools did not, and the only real cap lives in code. Team files carrying
  the old fields are migrated in place the next time any role is edited, and are
  read correctly until then.
- Ticket work now reports what it cost. Closing a ticket writes a `COST.json`
  into its task directory: the spend of the seat that worked it, how many
  commits landed on its branch, and two counters for the waste the rollup exists
  to expose — work redone after a rejected review, and worktrees left behind by
  retired seats. Where the seat that spent cannot be identified with certainty
  the record says so rather than guessing, since a confident wrong number
  poisons every total that sums it.
- The `clodex-team` roster no longer annotates roles with a field the schema
  deleted. It read `team.json` directly rather than through the shared loader,
  so it had kept rendering `instantiate` — which would have silently vanished
  from the line once a team file migrated.
- Plugins can ask whether a worktree is dirty. `host.lib.gitWorktree.isDirty()`
  reports whether a checkout holds work git would track, so a plugin can warn
  before an action that would discard it.
- A template's environment keys are now reported when they are refused, on
  every path that spawns a team seat. A key outside the allowed set and a key
  whose value is not a string are different problems, and they are now named
  differently — previously an allowed key with a mistyped value was reported as
  needing approval the operator already had. Ticket seats announce refused keys
  too; they used to drop them silently while other paths said so.

- Retiring a teammate no longer abandons its worktree. A discarded seat's
  checkout was left on disk with nothing pointing at it — retiring dropped the
  only record naming the tree, so neither Clodex nor the sidebar could find it
  again, and any commits on its branch that had not been merged were stranded
  there. The confirmation said its state lived on in the task artifact, which
  was true of its notes and not of its code. Retiring now removes the checkout,
  and archiving still keeps it, since an archived seat is resumable and that
  checkout is what it resumes into.

## 5.6.0 — 2026-08-11 — Teams in the menu bar, and a clock that knows you are working

- **Agents no longer look idle while they are working.** The idle time shown
  for a session — in `[agent:who]`, in the sidebar, and in the tray — measured
  how long ago the activity LABEL last changed, not how long ago the agent last
  did anything. An agent taking request after request without changing state
  stayed labelled "thinking" while its clock ran, so a long turn reported
  minutes of idleness. The same number decides whether a message to an agent is
  delivered or held until its next turn, so busy agents had messages parked and
  cold ones woken. It is now stamped from the agent's actual traffic. Restart
  behaviour is unchanged: a resumed session still dates from its last real turn
  rather than from the restart, and a session whose files carry a clock ahead of
  the machine's no longer keeps that wrong time permanently.

- **Teams are reachable from the menu bar.** A new Teams menu lists every team,
  opens its roles editor, and — the part that was missing — creates a team
  without spawning a seat for it. Until now a team could only be born as a side
  effect of creating a session, and the only way to edit one was an unhinted
  right-click on a sidebar group header, which exists solely when the sidebar is
  grouped by Project. That right-click still works; it is no longer the only way
  in. The menu also stays for a box with no teams at all, since that is exactly
  the box that needs to create its first one.

- Long turns no longer die at ~5 minutes of stream silence. Clodex now spawns
  every seat with the Claude CLI's stall threshold raised to its maximum of 30
  minutes, which mostly matters behind a proxy, where a slow first token used to
  surface as `API Error: Response stalled mid-stream.` This is a floor, not an
  override: a value you set in any env scope (global, workspace, or session)
  still wins. It has one cost worth knowing — setting the variable at all takes
  the CLI off its server-side default, so a future upstream change to that
  default no longer reaches you in either direction.

- A second agent asking for a reboot too soon after another one is no longer
  told "a reboot happened" when none has. Since restarts now wait for an
  all-idle window, the earlier request may still be pending — or have been
  cancelled or dropped without ever restarting anything. The refusal now says
  a reboot was *requested* that long ago, which is the fact Clodex actually
  knows.

- Reboot: a deferred restart that is abandoned no longer reports itself to a
  seat that merely shares the requester's name. A seat killed and recreated
  under the same name during the wait — which can run up to 30 minutes — was
  receiving a parked "reboot DROPPED" for a restart it never asked for.

## 5.5.3 — 2026-08-11

- `[agent:reboot]` no longer interrupts working agents. It used to relaunch
  half a second after the request, which landed mid-turn and cut off whatever
  any session happened to be streaming — including agents that had nothing to
  do with the reboot. It now waits for every session to go quiet before
  restarting, giving up after 30 minutes rather than waiting forever. Measured
  against a month of traffic: about a fifth of all mid-stream cutoffs were
  caused by this, and 19 of 25 reboots interrupted at least one agent.
- If a pending restart is abandoned, the requesting agent is now told why.
  Previously it was always told sessions had stayed busy for 30 minutes, even
  when the operator had cancelled the restart by hand a moment earlier — and it
  was invited to ask again, which turned a deliberate cancel into a loop. A
  cancelled restart now says so and says not to re-request it.
- The "restart dropped" notification no longer claims the restart was
  cancelled, and names the agent that asked for it when an agent did.
- **Keep-warm "Always" is no longer silently switched off overnight.** This
  corrects the behaviour described in 5.5.0: a rejected ping that looked like
  an expired credential used to clear the Always setting from the session's
  record, on the reasoning that Clodex cannot refresh your credentials for you.
  That reasoning was wrong. The CLI refreshes its own token on its next real
  turn, so the rejection is temporary — but the erasure was permanent, and the
  seat came back cold with nothing to show why. Measured on one box: every such
  disarm happened overnight, and a seat that missed the erasure by chance
  recovered on its own about twelve minutes later and stayed warm for six more
  hours. Now no ping failure of any kind, credential-shaped or not, can clear
  what you set: the strikes still stop that round of pinging, and the seat
  picks it back up on its next turn. Only you withdraw an Always.
- Traffic optimization updated to wirescope v0.6.50, which drops the
  boiling-pot analysis that measured out negative and was removed from Clodex
  last release. No change to how requests are handled.

## 5.5.2 — 2026-08-11

- Fixes the Workbench being unusable over web access, where the file tree
  showed nothing and no button or the close X responded to a click, though they
  still lit up on hover. It looked like something invisible was covering the
  panel; in fact the panel had never finished being built. Hiding the two
  desktop-only browse buttons in 5.5.0 aborted the rest of the setup, so most
  of the Workbench was never connected to anything. Desktop was unaffected.
- The release now opens a real window and checks that the interface actually
  starts before it builds anything. Nothing in the previous checks ever loaded
  the interface, which is how 5.5.0 shipped with a sidebar that drew nothing —
  a release that reproduces that failure now stops instead of publishing.
- Running the test suite against a filename that does not exist is refused by
  name instead of quietly reporting success over a run that executed nothing.
- The test suite now refuses to report success when a filter (a test-name or
  skip pattern) matched nothing at all. It previously counted the files it had
  opened and filtered away as passes, so a mistyped pattern produced a green
  run with a plausible-looking number of passing tests and nothing verified.
- The release's startup check now runs against a clean, throwaway profile
  rather than whatever state the app on that machine had accumulated, so a
  failure that only affects a first-time user can no longer pass it. It also
  fails instead of hanging if the app never finishes starting.
- Removes the Boiling Pot, the per-file token-carriage report on the View menu,
  along with the background counting that fed it. It was built to find files
  being read wastefully; measured against a month of real usage, the waste it
  was looking for came to well under a tenth of a percent of spend, and most of
  what it did find was scratch files rather than code. Nothing else used it, so
  it went rather than kept collecting. Existing counter files are left alone.

## 5.5.1 — 2026-08-11 — v5.5.0 loaded no sessions; upgrade straight past it

- **Fixes a v5.5.0 regression that left the sidebar empty.** 5.5.0 moved the
  file peek and report panel to the document root so they would stop opening
  behind the inbox drawer. They landed after the tag that loads the interface,
  which runs while the page is still being read, so both were missing at the
  moment the code that wires them looked for them. That threw, and the throw
  stopped the rest of the interface from starting — no session list, no agents.
  Only 5.5.0 is affected; 5.4.0 and earlier are fine, and the stacking fix that
  release shipped is unchanged and still works. If you installed 5.5.0, replace
  it with this build.

## 5.5.0 — 2026-08-11 — notes you can click, folders you can browse

- **Links and file paths in inbox notes are now clickable.** Agents routinely
  put a URL or a `renderer.js:71` in a `[agent:notify-user]` note, and both used
  to be dead text you had to retype. A URL opens in your browser; a path opens
  the same file peek a path click in the terminal does, jumping to the line if
  the note named one. Paths in notes whose author has since exited cannot be
  resolved and say so rather than failing silently, since notes deliberately
  outlive the seat that raised them.
- **The Workbench can now browse any folder, not just the session's own
  directory.** "Go to Folder…" in the Files panel opens a native chooser, and
  "Up" steps to the parent. The chosen folder becomes the working root for
  Source Control too, so the two panels can never end up showing different
  trees — if you browse into a different repository, Source Control shows that
  repository. The banner that already appeared for a selected worktree now
  appears for a browsed folder as well, and says "folder" rather than
  "worktree", because it is what tells you which tree a Commit is about to
  write to. Clicking it returns you to the session directory. Nothing is
  remembered across restarts: Clodex always reopens on the session's own
  directory.

- **Keep-warm can now be set to "Always" on a session that should never go
  cold.** The fire button's menu gains an Always option next to 1/4/8 hours.
  Unlike a duration it is a property of the seat, not a one-off arming: it has
  no deadline, and it re-arms itself when you restart Clodex, so a lead agent
  stays warm through an absence longer than you planned for. It still stops on
  its own if two pings are rejected in a row. When the rejection is your
  credentials — which Clodex cannot refresh for you — the setting is cleared
  along with it, so it will not quietly start again on the next launch; a
  rejection of any other kind stops keep-warm for this run only and leaves
  Always set, so restarting Clodex picks it up again. Picking a duration
  afterwards replaces it. The button reads "held always" rather than counting
  down to a deadline that does not exist. Available on sessions whose keep-warm
  is handled in-process; sessions routed through an external proxy keep the
  1/4/8 choices.

- **Keep-warm no longer gives up because your network hiccupped.** A dropped
  connection, a closed laptop lid, or an overloaded upstream now counts as a
  ping declined rather than a ping failed, so it does not spend the two-strike
  stop. Only a rejected credential does. Before this, two unlucky minutes
  offline were enough to switch keep-warm off — and on a seat set to Always,
  to erase that setting for good while you were away from the machine.

- **Keep-warm survives `/clear`.** Clearing a session's context starts a new
  conversation underneath it, and the keep-warm hold used to stay attached to
  the old one — leaving the session quietly going cold until Clodex was
  restarted. It now hands over to the new conversation, and the old one is
  released rather than left behind burning a little CPU every minute for the
  rest of the session.

- **Peer sections in the sidebar fold, and a new workspace starts folded.**
  Click a peer's header to collapse it — the caret and the hidden-session count
  match the local group headers. The fold is remembered per workspace, so a
  workspace opened for one project no longer greets you with every session on
  every peer you have ever connected to; peers stay folded until you open them
  there, including peers that appear for the first time. Pausing a peer is also
  reachable again: it is on the header's right-click menu, and unlike the ⓘ
  popover's button it works on a peer that is offline — which was the one case
  where you could not pause at all. The popover's button now says "Pause" too,
  matching the "paused" the header has always shown.

- **The file peek opens above the inbox drawer, not behind it.** A path
  clicked in a note used to open the peek underneath the drawer that
  launched it. `#main` is `position: fixed`, so a full-screen overlay
  nested inside it was flattened to `#main`'s stacking order however high
  its own z-index; the peek and the report panel now live at the document
  root. Also fixed for the report panel, which had the same latent trap.
- **The Workbench's browse controls no longer appear on the web frontend.**
  "Go to Folder…" and "Up" are desktop-only: repointing the root from a
  browser would let the read methods walk any directory on the server, so
  the write is refused there. The buttons used to be present and fail into
  a toast; now they are absent.

## 5.4.0 — 2026-08-10 — A branch and a checkout for every teammate

- **Teammates can now work on the same repo at the same time, each in its own
  checkout.** `[agent:spawn name:X cwd:Y worktree:<branch>]` boots the new seat
  in its own `git worktree` on that branch, so two agents editing the same
  project no longer fight over one working tree — one can be mid-edit on a
  feature while another runs the tests. The branch is created if it does not
  exist and checked out if it does, and the tree is removed along with the
  session when you delete it. A spawn that fails cleans up the tree it made
  rather than leaving it behind.

- **A team role can now get a branch and a checkout per ticket, automatically.**
  Set `"worktree": true` on a role in its `team.json` and every ticket the lead
  opens for that role mints a branch named after the ticket, spawns a teammate in
  its own branch, and points the ticket at that teammate rather
  than the role. The teammate starts in the project as usual and is told where
  its worktree is, at the top of the ticket. One ticket, one branch, one
  teammate — so several can run at
  once without sharing a working tree, and the branch is there to review and
  merge whether or not the teammate is still alive. Roles are opted out by
  default, so existing teams work exactly as before. If the worktree cannot be
  created the ticket is still opened and stays with the role — it never quietly
  falls back to the shared checkout. The branch forks from the tree the lead is
  actually looking at, not from the default branch, so a ticket written against
  unpushed work reaches its teammate as described. Filing a ticket ahead of time
  and releasing it later gets the same treatment as opening one directly.

- **Re-assigning a ticket that already has a checkout does the right thing
  either way.** Assigning it back to its role while its teammate is still working
  now just re-sends the spec to that teammate, instead of handing the ticket —
  and the location of its checkout — to whichever teammate answered for the role
  first, who was mid-work in a different branch. And if the teammate is gone, the
  same command brings up a replacement on the *existing* checkout, so the commits
  it left on the branch are still there; previously the ticket came back
  unassigned with a git error. A checkout you deleted yourself is noticed and a
  fresh one made, rather than the teammate being sent to a directory that is no
  longer there. If the teammate is merely archived rather than gone, the ticket
  says so and tells you the two ways out — unarchive it, or delete the session to
  free the name, which also deletes its checkout, so anything left uncommitted
  there goes with it (committed work stays on the branch). And a ticket whose
  checkout is still held by a live teammate is not moved to another one: you are
  told who holds it, and nothing is changed — not the ticket, and not the teammate,
  which is never told its ticket moved when it did not. That holds whichever
  teammate or role you were moving it to, including ones that have no checkout of
  their own, since it is the ticket's checkout at stake. A parked ticket also stays
  parked through a refused move rather than being quietly dispatched by it.

- **Deleting an old teammate no longer deletes the checkout its replacement is
  working in.** When a ticket's replacement takes over the existing checkout, the
  old teammate's session stops pointing at it, so deleting that leftover row does
  what it says instead of pulling the tree out from under the live one. That holds
  whether the replacement inherited the checkout or got a fresh one in the same
  place — deleting a checkout's folder by hand frees the name, and the next one
  lands right back on it. It also holds when the teammate started up and then
  failed partway: its checkout is still recorded against it, so deleting it
  removes the tree instead of leaving it behind with nothing pointing at it.

- **Deleting a worktree's folder by hand no longer burns its branch.** git keeps
  the bookkeeping entry when the directory disappears from under it and then
  refuses to check that branch out anywhere else — `already used by worktree at`
  a path that no longer exists. Clodex now clears those dead entries before
  making a worktree, so a branch stays usable after an `rm -rf`.

- **Teammates now commit their own work, and the lead merges it.** The shipped
  team prompts previously told every hand never to commit, which made sense when
  they all shared one working tree and would have been committing over each
  other. With a branch and a checkout each, that rule left their work invisible:
  nothing a reviewer or the lead could look at until it was hand-carried. A hand
  now commits to its own branch as it works, the lead merges after the review
  verdict, and pushing stays with you. A hand that is *not* in its own worktree
  still leaves committing to the lead.

- **A teammate working in a worktree stays on its team.** Team membership was
  decided by directory: since git puts a worktree *beside* the project rather
  than inside it, a seat that moved into one silently dropped off the roster and
  stopped being reachable for tickets — which the lead saw as "no live seat yet",
  a waiting message for something that was never going to arrive. A team is now
  identified by its repository, so every worktree of it counts as the same
  project.

- **Agents stopped being told to reply to notifications that nobody sends.**
  Roster and team notices arrive from a stand-in sender called "team", and each
  one invited a reply. Session names are shared across the whole app, so if any
  session happened to be named `team`, those replies went to it — an unrelated
  agent, in another workspace, receiving fragments of conversations it was never
  part of. System notices no longer advertise a reply address. The same applied
  to `reminder`, `memory` and `reboot`.

- **An agent asking for its team's ticket board now receives the board.** A
  registered exec command replies to the agent with the last line of what it
  printed, which is the right answer for a command that reports a single verdict
  and the wrong one for a listing — the agent that asked for its tickets got the
  footer ("200 done, 33 cancelled") and no rows, and nothing about the reply said
  a board had been dropped. A command whose answer is genuinely several lines can
  now say so in its definition (`replyMaxBytes`) and have those lines delivered,
  with an explicit note when there were more than the budget allowed. Commands
  that report one line are unchanged.

- **A malformed monitor request can no longer write outside its own directory.**
  `clodex-monitor` used the agent name and monitor id from the request as
  directory and file names without checking them, so a request naming a path
  instead of a name could reach elsewhere on disk — including the file cleanup
  removes. Both are now checked, by the same rule the rest of the app uses for
  session names.

- **A resumed agent is now told when Clodex was upgraded underneath it.** An
  agent's system prompt is written once, when its conversation starts, and
  rewriting it later would re-bill the whole conversation — so a session you
  resume after updating Clodex carries the prompt it was born with. Until now it
  learned about the new version only if the prompt's own text had changed, which
  most releases don't do: an intent that kept its name but changed its arguments
  would just quietly keep being used the old way.

  Such a session now receives one line at its next message, naming the version
  it was last running under and the one it is running under now, and saying the
  running app wins where the two disagree. Sessions started fresh get nothing —
  they are already current. Nothing is sent for an upgrade that happened before
  this feature existed, since there is no record of what to compare against; the
  first resume establishes the baseline and the next upgrade is announced.

  Underneath it is a general per-session notice queue, so future one-off
  advisories that are in no rush can ride the same channel.

- **A peer reached over `https://` is now actually encrypted.** Clodex has
  always accepted an `https://` peer URL, and the command-line client always
  dialled it properly — but the app's own peer connection dialled every peer in
  plain HTTP regardless, while sending your peer token on each request. If you
  run a peer over TLS, that token was going over the wire in the clear. It now
  dials TLS for `https://` URLs, on port 443 unless you name another.

  One consequence to know about before you update: a peer whose certificate is
  self-signed or issued by a private CA will now fail to connect rather than
  quietly falling back to an unencrypted connection. That is the point of the
  fix, but it is a real change if that describes your setup.

- **Agents whose names begin with `_`, `.` or `-` can reach the network again.**
  Such a name has always been legal to create, and the session looked completely
  healthy — but the request router rejected it, so every request that agent made
  failed and it never reached Anthropic at all. The router now accepts the same
  names the app lets you create. Paths like `..` stay refused.

- **A container mount at `/` is refused instead of silently shadowing
  everything.** The sandbox checks that your mounts do not collide with the
  directories it manages, and every specific one was caught correctly — but `/`
  itself slipped through the check and took precedence over all of them.

- **Host paths with unusual characters no longer corrupt the sandbox config.** A
  directory containing a quote, a backslash or a newline produced a broken
  container definition; a Windows-style path could stop it loading entirely.

- **The new-session directory suggestions no longer span workspaces.** The
  "popular" list was built from every session on the machine, so it could
  suggest — and reveal — directories belonging to a different workspace. It now
  reflects only the workspace you are in, which does mean a shorter list.

- **A dropped streaming connection now gives up instead of retrying forever.**
  If reconnecting succeeded but the handler setting it up kept failing, the
  retry budget reset on every attempt, so the backoff never grew past its first
  step and the give-up path was never reached.

- **A workspace holding only archived sessions no longer looks empty.** The
  workspace rows in the Window and tray menus counted running sessions only, so
  a workspace whose seats were all archived showed no session count at all —
  the same way a genuinely empty one does. Choosing Delete Workspace… from that
  row then warned you about deleting the sessions the label had just implied
  were not there. Rows now count both, naming the running subset when the two
  differ ("3 sessions (1 running)"), and the delete confirmation counts both
  populations at click time rather than reusing a number captured when the menu
  was built — a tray menu can sit open for minutes.

- **The cache-bust inspector opens in about a second instead of sixteen.**
  Vendored wirescope v0.6.48, which decides each turn's verdict from the billing
  receipts it already has rather than re-reading every request body, and leaves
  the per-turn detail out of the response unless something asks for it. The
  popover shows the same numbers; it just stops downloading five megabytes to
  render them. The session navigator's turn view got the same treatment and is
  now roughly eight times faster.

## 5.3.0 — 2026-08-08 — a switch the serving box can actually reach

- **Terminal sharing moved to Settings, and now works on a box with no peers of
  its own.** The switch that lets a peer open a terminal on your machine used to
  live on each peer's info popover — but the thing it controls is one box-wide
  capability, not a per-peer permission, so a box that only *serves* (a server
  deployment with nothing dialled out from it) had no peer row to put the
  checkbox on and could never turn it on at all. That was the reported symptom:
  the peer's sessions show up, bash sessions open fine, and the Terminal tab
  never appears.

  It is now a single checkbox in **Settings ▸ Phone access ▸ Terminal sharing**,
  beside the other things this box serves. If any peer had it ticked before, the
  box keeps serving; if none did, it stays off — an upgrade never switches this
  on or off for you. The "sharing is on" indicator moved with it, from the peer
  row to the sidebar header, so it is still on screen without opening anything.

  Settings now also says what the switch actually exposes: a peer does not get a
  shell of its own, it attaches to the same drawer shell your Terminal tab
  shows, is handed its scrollback, and can type into it while you are. Turning
  it off still closes any remote shell already open.

## 5.2.0 — 2026-08-08 — your terminal, on your terms

- **The terminal reporting checkbox is now three choices.** It used to decide
  two unrelated things at once: whether the agent could run a command in your
  Terminal tab at all, and whether it was told about every command *you* ran
  there. Wanting the first without the second — let it run something when you
  ask, but stop narrating your own work — was not expressible, so the only way
  to stop the stream was to switch the whole feature off.

  In Settings the choices are now **Off** (no marks; the agent cannot run a
  command there either, since it would never learn one had finished), **Only
  what the agent asks for**, and **Everything I run too**. Existing setups keep
  what they had: the box ticked becomes "everything", unticked becomes "off".
  Nothing is switched on for you.

- **Switching the stream off now takes effect at once, and takes your queued
  commands with it.** Reports wait for your next message rather than
  interrupting the agent, so switching off used to leave the last few commands
  sitting in the queue — and the next thing you typed sent them anyway. Those
  pending reports are now discarded, and the change applies to terminals
  already open rather than the next one. Reports already merged into a
  conversation cannot be recalled, and Settings says so.

  Also stated plainly there: terminal reports are sent **verbatim** — a command
  line carrying a token, a password in a URL or an `Authorization` header goes
  as written. The redaction mentioned for panel selections applies to that
  feature only, which the wording no longer leaves ambiguous.

- **A terminal command whose result the shell could not label is no longer
  discarded.** Running `[agent:term exec] pwd` twice in a row answered "finished,
  but the shell did not report which command ran" — with no exit code and no
  output — even though both had been captured correctly. Bash declines to add a
  repeated command to its history, and Clodex read the unchanged history number
  as "we do not know what this was" and threw the whole answer away. Since a
  stock Ubuntu sets `HISTCONTROL=ignoreboth`, this hit every repeated command on
  a Linux box, including the very first command in a new terminal when the same
  one was the last thing run in the previous one.

  An agent that asked for a command now gets its exit code and its output back,
  under the command it sent. Where the shell genuinely did not confirm what ran,
  the answer says the name is *assumed* rather than reported, and warns that if
  the operator ran something at that moment the output may be theirs — so the
  agent can tell a confirmed result from an inferred one.

- **More commands are reported by name on Linux terminals.** Where the shell
  skipped a history entry only because the command repeated one, Clodex can now
  say what ran instead of reporting it unnamed. Where a command was kept out of
  the history on purpose, it stays unnamed, deliberately — guessing there would
  attach an unrelated command's name to output the operator meant to keep out of
  the record. That covers a shell with history switched off, a command typed with
  a leading space on a shell set up to skip those, and any shell with a
  `HISTIGNORE` pattern list, where there is no way to tell whether a given
  command was one of the skipped ones.

## 5.1.1 — 2026-08-07

- **Fixed the documented syntax for running a command in your terminal tab.**
  The help text told agents to write `[agent:term exec <command>]`, with the
  command inside the brackets. That form has never worked: the command belongs
  *after* the closing bracket, as `[agent:term exec] pwd`. An agent following
  the instructions literally ran no command and was told only that the intent
  was unrecognized. The help now shows the working form, and its own prose no
  longer contradicts it.

  Only agents granted the terminal intent ever saw the wrong line, so most
  sessions were never affected. Those that were get the correction as a protocol
  diff on their next turn rather than a rewritten prompt.

- **A mistyped `[agent:term …]` now says what the right form is.** Agents that
  get the brackets wrong were told only that the intent was unrecognized, next
  to a list of valid intents that included `term` — which reads as "the verb was
  fine" and sends them hunting for the wrong problem. The bounce now names the
  correct form for that specific mistake. It never guesses at the command and
  never runs one: it explains and refuses.

- **Writing a terminal command no longer breaks when the agent keeps talking.**
  A command ended at the closing bracket in the documentation but not in the
  code: whatever the agent wrote on the lines below was pulled into the command,
  which was then refused for spanning multiple lines. So a correctly written
  command failed because of the sentence after it, and the agent had to know to
  close it with `[agent:end]`. The command now ends where its line ends, as the
  instructions always said. A trailing `[agent:end]` is still accepted and does
  nothing.

  One form stops working: putting the command on the line *below* the bracket.
  That was never in the agent instructions — only in an error message you saw
  after already getting it wrong — and it now produces a refusal naming the
  form that works.

## 5.1.0 — 2026-08-07 — Terminals reach further, and a lost message finally arrives

- **The "Clodex is back" notice now actually reaches the agent that asked for
  the reboot.** An agent that restarts Clodex makes itself inert in the process,
  so it gets told when the app is running again. That notice has existed for a
  while and had never once been delivered — seven restarts, seven log lines
  saying it was handled, nothing arriving.

  The cause was a promise being mistaken for a receipt. The notice was handed to
  the message store for the restarted agent and then deleted from disk in the
  same breath, as though handing it over were the same as it landing. It isn't:
  the agent's CLI is still redrawing a long conversation at that moment, and a
  message delivered into that window can vanish with no copy left anywhere. Now
  the notice is kept until the agent demonstrably takes a turn, and re-offered
  in the meantime — twice, spaced to clear the startup window, then given up on.
  Worst case you see the same one-line notice twice; it carries its own
  timestamp, so a late duplicate reads as harmless. Notices older than 7 days
  are still dropped rather than delivered.

  To be plain about what this is: nothing in the stack can confirm a message was
  received, so this is a bounded retry, not a guarantee. It is labelled that way
  in the code too, because reading "handed over" as "delivered" is the exact
  mistake that hid this for seven restarts.

- **Deliveries that go missing now say so.** Several paths could claim a queued
  message off disk and then fail to deliver it, leaving no trace in the log —
  which is why the bug above survived as long as it did. Those paths now record
  when a claim comes up empty. This is diagnostic only; nothing changes about
  what gets delivered.

- **`[agent:term exec]` works on bash now, not just zsh.** Until now an agent
  asking to run something in your terminal was refused outright unless your
  shell was zsh — bash could be typed into, but nothing could tell the agent
  what a command had printed or what it exited with, so the feature declined
  rather than run something blind. bash is the default on most Linux
  distributions, so that was a large share of people getting nothing.

  It needs **bash 4.4 or newer**, and the reason is worth stating because macOS
  is the awkward case: Apple still ships bash **3.2** as `/bin/bash`, which
  lacks the hook this relies on. If that is your `$SHELL`, the agent's refusal
  now tells you the version you have and the version you need rather than
  suggesting you switch to zsh. A newer bash from Homebrew works.

  One honest caveat. Reporting requires us to start bash with our own startup
  file, and bash refuses to combine that with being a login shell — the two are
  mutually exclusive, unlike zsh where they are not. So the terminal tab
  *reconstructs* what a login shell reads: `/etc/profile` first, then the first
  of `~/.bash_profile`, `~/.bash_login` or `~/.profile` that exists, exactly as
  bash itself would. Your PATH and aliases come through. What differs is that
  `shopt -q login_shell` answers false, so a startup file that branches on it
  takes the other path. We would rather tell you that than fake the flag. As
  always, nothing under your home directory is written or modified, and if any
  of this cannot be done the terminal opens as an ordinary shell with reporting
  switched off — never a broken one.

- **The drawer's terminal now works over the web too.** 5.0.0 said the term tab
  exists only in the desktop app; that has changed, and the reason it changed is
  that the restriction never bought anything. A Clodex reached over the web can
  already open a session of type *bash*, which is a login shell on that same
  machine started by that same person — so refusing the drawer's terminal
  refused a tab, not a capability. The two doors now agree.

  Attaching from a browser gives you **the same shell the desktop drawer has**,
  not a second one: one process per window and seat, and a tab that joins it is
  handed the scrollback so far, exactly as re-opening the drawer on the desktop
  is. That is deliberate — the alternative, a blank pane on a live shell, hides
  a half-typed line or an open pager rather than protecting anything, since the
  history in question is your own and the machine is the one you are already
  signed in to.

  Two things deliberately did *not* change. The **ctl console** stays
  desktop-only: it runs clodexctl verbs, which is a different question from a
  shell. And a terminal **on a peered machine** stays desktop-only too — that
  one reaches a third box, which nothing else on the web surface can do.

## 5.0.0 — 2026-08-07 — The drawer grows up, and terminals get shared

- **Text you select in the drawer can ride along to the agent.** Off by default,
  behind its own preference. With it on, highlighting text in any drawer tab —
  the terminal, the ctl console, the activity feed — offers it to the active
  session, and there are two gestures with two different meanings. *Selecting*
  is ephemeral: it rides the next request only, is never cached, expires on its
  own, and is gone whether the agent used it or not. *Copy* is deliberate and
  permanent: it lands in the session's transcript, where the agent can refer
  back to it for the rest of the conversation. The split is deliberate — a
  highlight is a glance, a copy is a decision — and this is separate from the
  memory hints, which offer an agent things it wrote itself; this forwards what
  *you* highlighted, which is a different consent decision and so has its own
  switch.

  Copy works from every drawer tab now, not just the console, and it takes your
  selection rather than the whole pane — selecting a few lines in a 200-block
  console and pressing Copy used to overwrite the clipboard with all of it, and
  you only found out when you pasted. It also tells you what it copied, with a
  byte count, since a clipboard write can fail silently and look exactly like
  one that worked.

  A **📋** button in the drawer header shows what is actually riding your next
  message: the selection, anything queued, and the memory hints sharing the same
  block. It deliberately reports what the proxy holds and what Clodex believes
  *separately* instead of reconciling them into one answer — during development
  the two disagreed, with text on the wire while the status line said nothing
  was armed, and an inspector built on the same belief as the status line would
  have repeated that with more authority.

- **The status bar moved to the bottom of the window**, below the drawer instead
  of above it. It had been colliding with a tall drawer and getting painted over.

- **The ticket board shows the newest tickets first.** It used to sort
  quietest-first to surface stalls by position, but a stalled ticket already
  announces itself, so the ordering only meant the ticket you just filed landed
  at the bottom of a growing board.

- **`ctx` commands work without the prefix in the ctl console.** `list` does
  what `ctx list` does, in a pane whose status line already shows which context
  you are in. Real verbs always win, so nothing is shadowed.

- **`ListAgents` is now in the tool list**, so it can be turned off per session
  like the rest. Anthropic added it to the CLI; until it was listed here,
  unticking it would have had no effect, because a tool Clodex doesn't know
  about can't be put on a session's deny list.

- **A Terminal tab for a peer's session — a real shell on their machine.** Off
  by default, and the machine that would host the shell is the one that decides:
  tick "Allow terminal sharing" on a peer in its info popover. Until someone
  ticks it, a peer session's Terminal tab simply says the other box has not
  enabled it. With it on, the tab works the way the local one does — you type,
  you see output, resizing follows your window.

  It is the *same* shell the operator of that machine sees in their own Terminal
  tab for that session, not a second private one. That is deliberate: a shell
  running on someone's machine that they cannot see is the thing to avoid, and
  sharing the terminal makes their view of it impossible to lose. Closing your
  tab detaches your view and leaves their shell alone.

  The grant is visible while it lasts, not just at the moment you give it: the
  peer's header carries a marker for as long as terminal sharing is on, and both
  machines log the opening and the closing to the IPC log. Turning it off closes
  any shell already open, immediately, and the other end is told it was revoked
  rather than being left to think the network dropped.

  Separately from the grant, the session in your sidebar is marked for as long
  as someone is actually watching its terminal, and the mark clears when they
  leave — including when their connection simply drops. Opening the shared
  terminal starts the shell if it wasn't running, so a peer can be in a shell on
  your machine with no tab open for it on your screen; this is the marker that
  says so. Reconnects of a viewer who was already there stay quiet in the log,
  so a flaky link doesn't bury the openings that matter.

  Alongside the per-session mark there is a standing notice at the bottom of the
  sidebar whenever anyone is in one of your terminals, naming the session. The
  mark rides a session row, and a row is not always there to ride — you might
  have archived the session, filtered it out of the list, or be looking at a
  different workspace. The notice doesn't depend on any of that. Killing or
  archiving a session also ends the peer's view of its terminal, told to them as
  a close rather than a dropped connection; the shell itself keeps running,
  since it's yours.

  That mark is a precondition, not a decoration: keystrokes and resizes from a
  peer are refused unless that peer's box has the terminal open, so there is no
  way to type into one of your shells without the marker being on. And if you
  close the window a shared shell belongs to, the peer watching it is told the
  terminal was closed rather than being left with a pane that has quietly
  stopped — after which the peer cannot start a new one there either. Sessions
  outlive their window, so without that a peer could open a shell in a workspace
  you had closed, and every surface that would tell you — the mark, the tab, the
  log row — lives in the window that isn't there.

  On your side of a peer's terminal, if their box goes offline or they withdraw
  the grant while you have the tab open, the pane says so instead of going
  quietly inert.

  One thing worth being clear about, because the checkbox sits next to a
  particular peer: the switch is per peer as a *record of what you intended*, but
  what it turns on is a capability of your machine's wire. Clodex's peer wire has
  no cryptographic caller identity — it binds to loopback and the SSH tunnel is
  the boundary — so anyone who can reach that tunnel can use the capability while
  it is on. Treat it as "terminal sharing is on for this box", and turn it off
  when you are done.

- **Security fix: plugins could write files and run destructive git operations
  from the browser client.** When you serve Clodex to a browser, that connection
  is deliberately denied some of the sharper desktop capabilities. Plugin
  methods slipped past that line: an authenticated browser session could call
  *any* method of *any* loaded plugin, which for the built-in Workbench meant
  writing arbitrary files, committing, discarding changes, checking out
  branches, pushing, and creating or removing worktrees in any session's
  directory. Those now refuse from the browser and work only in the desktop app;
  reads — the file tree, file contents, `git status`, diffs, branch and worktree
  listings — are unaffected, so the browser Workbench still shows you everything
  it did before.

  This covers plugins only. Clodex's own file editing and session controls are
  unchanged and still reachable from a browser, so the browser surface remains
  a privileged one: only give the address and token to someone you would hand
  the machine to.

  Plugins now say which of their methods a browser may call, and the default is
  none. A third-party plugin with a browser-facing UI needs one line in its
  manifest to keep working there; the built-in plugins are already updated. If
  you only ever use the desktop app, nothing changes.

- **The agent can run a command in the terminal you are watching.** Off by
  default, and granted per session: tick "Run commands in the seat's terminal"
  in the session's intents list. With it on, the agent can type one command into
  its own Terminal tab — you see it run, in your shell, with your aliases and
  your history — and gets the output back. It is for the moment you hand a
  debugging session over but still want to watch: the agent drives, the terminal
  is still yours.

  The safeguards are the interesting part. It only ever reaches the terminal of
  the session that asked, never yours or another session's. It refuses rather
  than guesses: if the tab is not open, if something is already running in it, if
  a full-screen program like an editor or a pager has the terminal, or if the
  command is anything other than a single line, the agent is told why and nothing
  is typed. It never opens a terminal on your screen by itself. And it always
  gets an answer — if you Ctrl-C the command, close the tab, or the command is
  still going after two minutes, the agent is told that instead of waiting
  forever. A command that outruns the two minutes is *not* cancelled; it keeps
  running and its output arrives when it finishes.

  Two things it is careful about, both cases where the terminal is yours and the
  agent arrived mid-thought. If you had half a command typed at the prompt, that
  line is abandoned first — the same Ctrl-C you would press yourself — so your
  fragment can never end up joined onto the agent's command and run, whichever
  keybindings you use. And if you started something a fraction of a
  second before the agent's command arrived, the agent is told the terminal
  reported a *different* command finishing rather than being handed your result
  as if it were its own.

  The command itself must be plain text: anything invisible in it — a control
  character, a zero-width space, a right-to-left override — is refused rather
  than quietly removed, because the whole point is that the line you watch is the
  line that runs.

  Reporting must be on for this to work, since it is the same completion marks
  that carry the result back. If it is off, or your shell is not zsh, or the tab
  was opened before you turned reporting on, the agent is told which of those it
  is rather than running the command blind.

- **The agent can see what you run in its terminal.** Off by default;
  Preferences → "Report the commands I run in a session's terminal". With it on,
  each command you run in a session's Terminal tab is reported to that session's
  agent: the command line and its exit code, plus the tail of the output when it
  failed. A command that succeeded sends its line alone — a build that prints
  four thousand lines and works is not news. Reports ride along with your next
  message rather than interrupting, so they cost nothing until you say something.
  Nothing is sent for the shared terminal when no session is selected.

  This works by adding a small generated startup file to the terminal's shell so
  it can mark where each command begins and ends (the OSC 133 convention iTerm2
  and VSCode use). Your own `.zshrc` is sourced normally and is never modified.
  Requires zsh; another shell simply gets an ordinary terminal with no reporting.

- **The Terminal tab now hides itself where it made no sense.** A bash session is
  already a shell, so the drawer offered it a second, unrelated one. Worse, a
  peered session showed a terminal running on *your* box rather than the peer's —
  and every peer session in a workspace was quietly sharing that one shell. The
  tab now appears only for sessions it can actually serve. A terminal on the peer
  itself is a separate feature and is not in this release.

- **Each session gets its own terminal.** The drawer's Terminal tab used to be
  one shell per window, so switching sessions left you in the previous one's
  shell and directory. Every session now has its own, opening in its own working
  directory and keeping its own scrollback, and switching sessions switches
  shells. A session's shell ends when the session is deleted.

- **The drawer can be made taller.** A **⇕** button in the drawer header swaps
  the proportions — the drawer takes about 70% of the window and the session
  terminal keeps the rest, which is enough room to actually debug in the
  terminal or clodexctl tabs. It deliberately stops short of full screen: the
  session terminal stays visible, since watching an agent react to what you
  just typed is the point. The setting is remembered per window, and collapsing
  a tall drawer still collapses it — the height comes back on the next expand.

- **The bottom drawer is now a tab host.** It used to be the IPC log and
  nothing else; it now owns a tab strip with per-tab unread badges, and the IPC
  log is simply the first tab. Everything about the old drawer still works the
  same way — the same toggle, the same menu item, the same export and clear
  buttons — but there is now somewhere for the activity feed, a clodexctl
  console and a terminal to live. Those arrive next.

- **Subagent activity is now a drawer tab, and it stays put.** Clicking a
  subagent row used to open a popover that vanished the moment you clicked
  anywhere else, taking everything it had collected with it. That popover is
  gone; the drawer's new **Activity** tab holds a chip per subagent across the
  window's sessions, and the feed you select keeps accumulating while you switch
  sessions, look away, or the subagent finishes. Aged-out subagents keep their
  chip for as long as there is history behind it. The tab costs nothing while it
  is hidden or the drawer is collapsed — the chips ride telemetry that already
  arrives, and the one feed poll runs only for the feed you are looking at.
  It is honest about the lag it has: the feed updates at turn boundaries, the
  footer says so, and it tells you how long ago the last turn landed rather
  than pretending to be live.

- **The activity feed now shows every subagent turn, not one in five.** It read
  its turns from wirescope, which keeps only the most recent one per subagent
  and replaces it on the next request — so a subagent working faster than the
  poll had most of its work silently dropped, and what you did see was already
  a turn behind. Clodex sits in front of wirescope on the same connection, so
  those turns were crossing our own process the whole time; the feed now reads
  them there and keeps them. Turns that happen between two polls queue up
  instead of disappearing, which means nothing is lost while you are looking at
  another tab. If a very long-running subagent overflows the history we keep,
  the feed says so at the top rather than quietly closing the gap.

- **Feed rows say what a tool did, not just which tool ran.** A busy subagent
  read `Bash Bash Read Bash Bash` — every row true and the column as a whole
  useless. Each row now carries the argument that identifies the call: the
  command for `Bash`, the pattern for `Grep` and `Glob`, the path for a file
  tool, the description for a spawned `Task`. Snippets are trimmed to their
  first line and capped, so a heredoc or a multi-line script stays one row.
  This costs nothing extra on the wire: the arguments were already streaming
  past the collector that watches which files get touched, and it now keeps
  the part it was throwing away.

- **The feed shows what a subagent was thinking, not just what it did.** A
  reasoning block used to be dropped on the wire, so the feed could show a tool
  call and the sentence after it but never the thinking that led there. Turns
  now carry their reasoning as its own field, shown above the tools it explains
  and clamped to a few lines so the feed stays scannable. It is kept strictly
  separate from the turn's visible text on purpose: that text is what Clodex
  scans for `[agent:...]` commands, and an agent that merely reasons about
  sending a message must never be treated as having sent one.

- **The drawer has a clodexctl console.** A new **ctl** tab runs `clodexctl`
  against your contexts without leaving the app or opening a terminal —
  `sessions`, `run`, `exec`, `send`, `spawn`, `restart`, `logs`, `query`,
  `skills`, `args`, and the whole `ctx` family. Each command and its output stay
  together as one block, so Copy gives you a transcript rather than a flattened
  blob, and ↑/↓ walks your history. The connection stays warm between commands
  instead of re-dialing each time. Bearer tokens are stripped from every block
  including error output, and `ctx list` masks them the way `ctx show` always
  has. A **?** button lists the verbs that actually run here, derived from the
  console's own allowlist rather than a copy that could drift from it, and
  `help` / `<verb> --help` work as they do in the terminal — including for the
  verbs the console will not run, so asking why `attach` is refused gets you the
  verb's documentation rather than a second refusal.

  What it will not run is what a block cannot hold: `attach` and `logs
  --follow` are live streams, `deploy`/`upgrade`/`web` and friends are long
  children or servers, and `kill` and `restart-app` are irreversible acts whose
  confirmation prompt has nowhere to appear in a one-line input. The Terminal
  tab next door runs all of them. The console exists only in the desktop app: a
  Clodex reached over the web has no such channel registered at all.

- **The drawer has a terminal.** A **term** tab with a real login shell, one per
  window, opening in the directory your sessions in that window already work in.
  It starts the first time you look at it, not at launch, and keeps its
  scrollback while you switch tabs or collapse the drawer. Closing the window
  closes its shell. Like the ctl console, it exists only in the desktop app —
  there is no such channel on a Clodex reached over the web. It starts out yours
  alone; the two ways an agent can reach a terminal both arrived later in this
  release, and both are off until you turn them on.

## 4.15.0 — 2026-08-05 — Infra paths, and a review that arrives

- **Terraform and HCL paths in the terminal are now clickable.** The link
  scanner matches by extension — an allowlist, so ordinary prose stays inert —
  and it had no infrastructure languages in it at all, which left
  `modules/vpc/main.tf:42` as dead text. Adds `.tf`, `.tfvars`, `.tfstate` and
  `.hcl`. State files are included: they often hold secrets, but an agent
  working in your tree can already edit one, so hiding the viewer was never the
  thing protecting it.

- **A review no longer goes missing when the reviewer seat is brand new.** The
  scope is handed to a seat that has not taken its first turn yet, and only one
  event could deliver it; when that event did not fire, the review sat unread
  on disk forever while the seat looked alive and idle. There is now a second,
  independent path that delivers it, so a review that is waiting always lands.

- **A reviewer template's thinking-strip setting now actually applies.** Saving
  a strip level on the reviewer template had no effect on the seats that
  `[agent:team-review]` spawns — they ran unstripped whatever the template
  said, and nothing about the running seat showed it. The level is read from
  the template and applied to the seat.

- **The reviewer is told it has no shell.** Its tools are Read, Grep and Glob;
  there is no Bash, so `git diff` and friends were never available to it.
  Across 65 captured reviews, reaching for them anyway was the most common
  wasted round trip — each one re-bills the whole review context and returns
  nothing. It is also now told to issue independent reads together, since a
  review's cost tracks the number of requests, not the number of files.

- **The sidebar's PR chip no longer disappears thirty seconds after launch.** It
  painted at boot and then vanished for the life of the window: the cheap
  refresh that runs every 30s omits the git and gh work, and the renderer could
  not tell "this refresh didn't ask" from "the answer is none". Refreshes now
  say which questions they asked, so a cheap one can neither overwrite nor be
  believed about an expensive one's answer.

- **Revoking a plugin's access to a session now takes effect immediately.** The
  badges and menu entries it had painted used to stay up for the life of the
  window, because the sidebar refresh could not say "this session grants
  nothing" in a way the renderer could tell apart from "this refresh didn't
  ask".

- **Plugins can now read what an agent says.** A session-scoped plugin granted
  turn text receives each turn as the agent writes it — the capability that
  makes turn archivers, cross-session search and standup writers possible,
  where before a plugin could see a session's name and status but not one word
  of its work. The grant is per session and defaults off, and a plugin granted
  only tool inputs or thinking does not receive turn text: the capabilities are
  separate because they carry different risk. Nothing bundled uses this yet.

- **Plugins can now be scoped to individual sessions.** A plugin whose manifest
  says `"scope": "session"` is invisible to every session that has not granted
  it — absent from that session's intent checklist and prompt, not listed and
  refused. Grants are per capability (turn text, thinking blocks, tool inputs),
  each defaulting off, edited in the Intents popover's new Plugin Access block.
  Nothing shipped uses this yet: all four bundled plugins declare no scope and
  behave exactly as before. Scope means visibility, not isolation — intent verbs
  still share one global namespace.

- **The file popover's Diff tab now has line numbers**, the way the CLI shows
  them: additions and context numbered in the new file, deletions in the old,
  restarting at each hunk. The code column lines up with the File tab's gutter,
  so switching tabs on the same file no longer shifts everything sideways.

- **A session can now be spawned with the wire off.** New "Wire off" checkbox
  under Other options: the seat launches with no `ANTHROPIC_BASE_URL` at all —
  no Clodex tee and no API proxy. This is what Anthropic's remote access needs
  (attaching to a running session from the phone app refuses to work when that
  variable is set), so a wire-off seat can be reached from your phone and still
  drive the rest of the fleet through intents, which come from the transcript
  and are unaffected. The cost is the wire-only features: cache warmth, wire
  telemetry and protocol-accurate activity all go quiet, so wire-off rows carry
  a `⊘` in the sidebar rather than looking merely idle. The file list a session
  has touched still works — it is read from the transcript — but edits stop
  being attributed to the subagent that made them.
  Context %, tokens and cost still show — those come from the CLI's own status
  hook. The setting is remembered, so a restart, a restore or a template spawn
  all come back wire-off.

## 4.14.0 — 2026-08-04 — Every path in the terminal is a door

- **File paths in the terminal are now clickable.** When an agent mentions
  `renderer/lib/format.js:71`, clicking it opens that file in the peek modal,
  scrolled to line 71 and highlighted. The CLI is not involved and needs no
  support for this — Clodex scans the text it has already rendered. Paths are
  matched by shape, so a click on something that only looks like a path tells
  you it could not be found rather than doing nothing. Truncated paths are
  recovered by matching against the files that session has touched; a path that
  matches two of them is refused rather than guessed at. A leading `@` — the
  CLI's own "load this file" syntax — is understood, while a real path that
  starts with one (`node_modules/@babel/…`) still resolves normally.
- **The line numbers an edit prints are clickable too.** When a tool call shows
  its gutter under `Update(file.js)`, clicking a number opens that file at that
  line — the numbers name a line but not a file, so Clodex reads the file from
  the header above them. A number only links when it is part of an unbroken
  gutter under such a header, so numbers in ordinary output stay inert.
- **The file peek can be dragged by its title bar**, so it can be moved off
  whatever it is covering instead of only resized. A fresh open re-centres it;
  following a path or stepping back leaves it where you put it.
- **The File view shows line numbers**, and paths inside a viewed file are
  clickable too — following one keeps a back arrow to where you came from.
  A relative path resolves against the file it appears in first, so
  `../lib/format.js` means what it means to that file.
- **A file can now be edited in the peek.** An Edit tab next to Diff and File,
  with Cmd+S, a dirty marker, and a prompt before discarding unsaved changes.
  Editing is confined to the session's own directory and refuses a file that
  changed on disk since you opened it, so an agent still working in that file
  cannot have its edit silently overwritten. Files too large to load whole are
  not editable — saving one would discard everything past the display limit.
  Sessions running on a peer machine are viewable but not editable.
- **A session listing that ignored workspace boundaries has been removed.** The
  `session:listAll` IPC channel returned every session in every workspace. No
  client ever called it — the tray, the one thing it was written for, reads the
  same data in-process — but the browser frontend dispatches any registered
  channel by name, so an authenticated connection bound to a single workspace
  could have used it to list all of them. Deleted, along with the note in the
  architecture docs that wrongly described it as feeding the tray. A new test
  now fails if any IPC handler is registered without appearing in the API
  contract, which is how this one stayed unnoticed.
- **You can now file a ticket for later without starting it.**
  `[agent:task add <role>] <spec>` dispatches immediately — it delivers the spec
  to the seat the moment it is idle. Writing "BACKLOG, do not start" at the top
  of the ticket did nothing, because nothing reads the body; only the worker's
  own reading of that first line ever stopped it. Add `park` —
  `[agent:task add park <role>] <spec>` — and the assignee is recorded while the
  spec stays undelivered. A parked ticket is skipped by the queue, never replayed
  to a restarted seat, and exempt from the stall watchdog, so it also stops
  making real work wait behind it. `[agent:task assign <id> <role>]` releases it
  and sends the spec; `[agent:task park <id>]` parks or unparks one already open,
  so changing your mind no longer means cancelling and refiling. Both listings
  and the ticket board mark parked rows.

- **A seat's shell now sees the same Clodex root the app does.** The helper
  scripts — the team roster, the monitor, the task ledger — find their data
  through `CLODEX_HOME`. Commands you fire with `[agent:exec …]` were already
  pointed at the app's own root, but the same script run by hand from a seat's
  terminal inherited whatever the app happened to be launched with, so the two
  routes could read different trees and disagree about who is on the team. Every
  session now starts with that variable set to the app's root, which closes the
  split. The consequence worth knowing: setting `CLODEX_HOME` yourself in a
  session's environment no longer has any effect — it is overridden, the same way
  `TERM` always has been. Nothing else in that environment changes.

- **A session can now be told to skip wirescope's spawn-directive block.** Set
  `CLODEX_SPAWNER_HINT=off` in a session's environment and the proxy stops
  adding the `[wirescope]` block — the documentation of how to spawn subagents —
  to that seat's system prompt. It is worth doing for a seat that will never
  spawn one, since the block otherwise rides along on every request it makes.
  `=on` is the opposite, for a port where the block is off by default; anything
  else, including leaving the variable unset, changes nothing. The cold reviewer
  seat already skipped the block because it holds no spawning tools, so nothing
  about it changes here; what is new is that the switch is available to any
  session rather than being wired into one internal code path.

- **A rejected ticket command no longer eats what you wrote.** Fire
  `[agent:task done]` at a ticket someone already closed, or `[agent:task add]`
  from a seat that is not the lead, and the report or spec you just composed used
  to vanish with the error — it existed only in that turn, and nothing had kept a
  copy. Now every rejection saves the body first and the error tells you where it
  went, so you can recover it instead of rewriting it. If the save itself fails
  the error says that plainly rather than naming a file that is not there, and
  because the message directory is swept after thirty minutes the reply tells you
  that too. This happened twice in one night to agents working on Clodex itself,
  once losing a review verdict.

- **Clodex no longer records a message as sent while it is still queued.** Text
  bound for a session waits for a safe moment — the seat has to be idle, not
  mid-draft, not paused on a permission dialog — and that wait can run to
  minutes. The internal call that queues it, though, answered "delivered" the
  instant it accepted the bytes, so anything Clodex wrote down on the strength of
  that answer was recording a write that had not happened yet. If the app quit
  during the wait, the record said the message went out and the message was gone.
  The affected spots each hold something you would notice missing: parked mail
  waiting on a restart, a team's roster introduction, and the stall alarm that
  tells a lead one of its agents has gone quiet. They now wait for the write
  itself. The alarm additionally checks that the stall it is reporting is still
  the one happening — an agent that speaks up while the alarm is queued ends the
  stall, and the old code would have quietly disarmed the next one.

- **Turning an intent off no longer destroys what an agent wrote with it.** If a
  session is not allowed to send direct messages, and it composes one anyway, the
  refusal used to arrive with the message already gone. The bounce now explains
  that the capability is off for that seat, that retrying will fail the same way,
  and that only you can change it — from Edit Session → Intents. Four verbs also
  save the body first and tell the agent where it went: direct messages, inbox
  notes, reminders, and memory writes, the ones whose payload is composed prose
  that took a turn to write. A refused compact does not, because its note is still
  sitting in the context it was written for; a refused exec does not, because its
  arguments mean nothing without the command. Anything else says plainly that the
  body was lost rather than pretending otherwise. Saving is capped per seat and
  per verb so a session that has not learned the setting cannot fill the message
  directory by retrying every turn.

- **`[agent:context reload]` no longer strips a session's environment.** Reload
  respawns the CLI in place, and it was dropping every environment variable the
  session had been given. The loss outlived the reload: the respawn rewrote the
  session's saved record without them, so the variables were gone from every
  later resume as well, not just the running process. A session that reloaded
  once came back subtly different and stayed that way.

- **Team task artifacts are written outside your repository.** A team's working
  notes — specs, journals, design documents — live under
  `~/.clodex/projects/<project>-<hash>/tasks/`, never in the project being worked
  on. The directory is named for the project so it can be browsed by hand, and
  the hash is taken from its resolved path, so two checkouts that happen to share
  a folder name do not quietly share one artifact directory.
- **A restarted agent is told what it was working on.** A ticket's instructions
  used to reach a seat exactly once, when it was assigned. If that seat then
  crashed, cleared, or reloaded, it came back with no idea what its job was, and
  nothing ever told it again — from the board the ticket still looked assigned and
  in progress. Open tickets are now re-delivered when the agent comes back up, at
  the moment it can actually receive them, which is a different moment for Claude
  and Codex sessions. Only tickets belonging to that specific agent are replayed.

## 4.13.0 — 2026-08-04

- **Every sidebar session has an ⓘ button now.** Hover a row, click the ⓘ, and
  you get what Clodex already knew but had nowhere to say: how many times this
  conversation has been compacted and how much context those compacts threw
  away, turns and API requests, how big the transcript has grown, and the cost —
  in all four of its scopes, each labelled, because they are genuinely different
  numbers. Spend since the last compact, spend since the CLI process started,
  spend on this whole conversation, and **spend by this agent across every
  conversation it has ever held**, which only ever goes up: a /clear starts a
  fresh conversation but does not reset the seat's lifetime total. Where the
  older records have aged out of the ledger, the panel says how many it still
  has rather than presenting a short total as complete. Reading it costs
  nothing until you click — the transcript scan runs on demand, not on the
  poll.
- **Preferences is seven collapsible groups instead of one long scroll.** Every
  setting was expanded at once, so finding one meant scrolling past eight others
  and their explanations. Groups now start collapsed, each with a one-line
  summary of what is inside, and the ones you open are remembered. The settings
  themselves were regrouped rather than just folded: the two statusline sections
  are one "Statusline" group, and default tools and Claude MCP — both of which
  only affect sessions you create from now on — are one "New session defaults"
  group that says so once instead of twice. Traffic optimization now names
  wirescope as its first entry, since the transcript bake and the memory hints
  under it are things wirescope does — none of them exist without it, and the
  dialog never said so. Nothing moved out of the dialog and nothing changed what
  it does; a collapsed group still saves exactly as before.
- **Turning off traffic optimization now actually stops contextual hints.**
  Sessions already running kept the proxy address they were given when they
  started, so unticking the setting stopped wirescope but left those sessions
  still matching your drafts against memory and posting hints at a port with
  nothing on it. Each failed post also held that session's incoming messages for
  up to 30 seconds, so a DM sent right after you changed the setting arrived
  late. Sessions you routed to a proxy explicitly are unaffected — they keep
  their hints, as they always should have.
- **Fixed: a restarted proxy stopped being recognized as Clodex's own** —
  which showed up as Preferences saying "not running" next to a proxy that
  plainly was, no Restart button, and a vendored wirescope update that never
  got picked up no matter how many times you relaunched. Clodex identifies the
  proxy it started by a small pid file, and on a restart the outgoing process
  deleted the incoming one's copy on its way out. Everything downstream reads
  that file, so one missing byte turned a managed proxy into an unmanaged one.
  Recovering meant killing the process by hand. If you are on a proxy that
  reads "not running", it will re-adopt itself the next time it restarts.
- **A proxy Clodex lost track of now finds its way back.** The bug above left
  some proxies already orphaned, and nothing recovered them: Preferences kept
  saying "not running", the Restart button stayed hidden, and a vendored update
  was never picked up no matter how many times you relaunched. Clodex now
  re-adopts a proxy on the expected port only when it carries a private setting
  that Clodex itself sets at launch and nothing else supplies. A proxy you
  started by hand is left alone even when it runs from the same directory, and
  so is one belonging to another Clodex install on the same machine — neither is
  ever stopped or restarted by this one.
- **Two test runs can no longer wedge each other** (contributors only). Parts
  of the suite bind real ports, so two at once deadlock — both sit at 0% CPU
  and neither finishes, which looks exactly like a slow suite. `npm test` did
  not take the lock the digest path has always used, so the most obvious
  command in the repo walked past the guard; a stray run had been stuck for
  over thirteen hours. It now refuses immediately, naming the process holding
  the lock and how to clear it.
- **An agent now reaches for the tools you gave it.** Agents were told which
  commands you had granted them and how to call them, but not that those were
  the intended way to do the job — so they noticed the command and then wrote
  the equivalent shell line by hand, which is slower, noisier, and what the
  command existed to avoid. A team lead was also being shown its reviewer in a
  way that read like an ordinary helper, so it built its own instead of using
  the review channel that reports back to you. Both now say plainly what they
  are for and when to use them.
- **An agent's lifetime spend now survives a restart, and Opus 5 turns are no
  longer free.** The ⓘ panel's fourth number — everything this agent has ever
  spent — is the one that only goes up, and it was being reset: restarting a
  session dropped the list of conversations it was summed from, so "all time"
  quietly became "since the last restart". Separately, Opus 5 had no price row
  at all, so those turns costed at zero while still counting as requests — a
  conversation that had plainly cost something showed a total far below it.
  Both are fixed going forward; sessions already recorded with a zero total
  stay as they were.
- **Claude 5 Sonnet's introductory pricing now expires on its own.** The rate
  drops to standard on 1 September 2026 and the change was tracked as a note
  telling us to remember; it is now scheduled, so receipts before that date
  keep the rate they were billed at and later ones do not.
- **An agent updated by a new Clodex version now picks up its new instructions.**
  An agent's instructions are frozen while its conversation is warm — rewriting
  them mid-conversation would throw away everything it has cached, so changes
  are handed over as a diff instead. What was missing was the other half: at a
  /clear or a compact, where the conversation is gone or already being rebuilt,
  the frozen copy can safely be replaced. It was not being replaced, so an agent
  running across an upgrade could keep instructions from a week earlier
  indefinitely — one seat here ran six days that way. Refreshing costs nothing
  at a /clear and rides a cost the compact has already paid.
- Vendored wirescope v0.6.47.
- **An agent that gets an irrelevant memory now drops it without telling you.**
  Retrieval matches on words, so it misses — and when it did, agents announced
  the miss: one idle seat was handed a memory about an unrelated project,
  correctly declined to act on it, then summarized it back to you "so it isn't
  lost". The hint said to ignore it if unrelated, but said more loudly that it
  would not be repeated, so agents preserved it rather than dropping it. An
  unrelated memory is now dropped in silence, which is what it cost you nothing
  to receive.
- **A memory attached to a turn now says when you said it.** Hints arrived
  undated, so a claim from two years ago read as current — "your branching
  strategy is main/qa/devel" asserted flatly, with nothing to tell the agent it
  described work from 2024. Measured over the live stores: of 22 memories
  delivered across 30 questions, 15 were over a year old and 7 of those had no
  date recoverable from their own wording. Each memory now carries the month it
  was learned. Which memory rides is unaffected — the date is shown, never
  matched.
- **A Preferences toggle that cannot act now says so.** Three checkboxes — the
  resume-time transcript bake and both hint settings — did nothing unless
  wirescope was on, but you could still tick them, save, and
  relaunch to find them still ticked and still inert. They are now greyed with
  the reason underneath, and semantic ranking greys the same way when hints
  themselves are off. Your choices are remembered, not discarded: turn the proxy
  back on and they return as you left them.
- **The semantic pass no longer throws away the memory your question matched.**
  It was meant to reorder what the word-matching gate found; it was instead
  re-ranking the whole store and replacing that result outright. Asking "any
  other colleagues in my orbit?" matched a memory listing your colleagues on two
  words — and delivered three about an assistant project, LinkedIn posts and
  parenting, because they scored a hundredth of a point higher in a range the
  whole store fits inside. Measured over 12 questions: 41% of delivered memories
  were ones the question had actually matched, and on half of them every match
  was discarded. Now 100%.
- **A personal question now retrieves memories that actually mention it.** In a
  memory store about one person, every unit is similar to every question about
  that person — "who are my colleagues?" spanned 0.600 to 0.584 across its whole
  result, so what rode was three confident units about agent collaboration and
  AWS networking while the ones naming actual colleagues sat far below. A memory
  must now share a word with the question, and the pool it is chosen from is wide
  enough for that to mean something. Measured over 14 personal questions:
  precision rose from 40% to 75%, and four questions the store simply cannot
  answer (pets, music, and two others) now stay silent instead of shipping three
  confident irrelevant memories.
- **A hint no longer outlives the draft it was ranked against.** Arming happens
  at a typing pause, so a draft you keep editing could leave a hint registered
  against text that no longer exists. Continuing to type already replaced it;
  what didn't was editing your way down to *no* match — the previous winner
  stayed armed and rode the request. The hint slot is now cleared whenever the
  current draft earns nothing, including when it becomes unreadable (history
  recall, tab completion) or drops back below the length floor.
- A hint now says it is retrieved rather than verified: where one conflicts with
  what you just said, the agent is told you are right.
- **A hint can carry more than one memory, bounded by characters rather than by
  a count of one.** Short units — which is most of the common store — now ride
  together instead of one at a time, so a question the store answers in three
  places gets all three rather than whichever sorted first. Measured across
  eight matching questions: 19 units delivered where there were 8. The winner
  always rides; runners-up are admitted only while they stay close to it in
  score and inside the budget.

## 4.12.0 — 2026-08-03 — Memory an agent can actually use

The theme is retrieval: an agent now gets the right memory attached to the right
question, without anyone having to know the memory exists.

### Contextual hints

- **Hints arrive on the turn they were meant for.** A hint is attached to a
  single request, and arming it when you pressed Enter registered it ~200-300 ms
  after that request had already gone — so it rode the *next* turn and answered
  a question you had moved on from. Arming now happens on a brief typing pause,
  before Enter exists. If a message is delivered to the seat while a hint is
  waiting, it queues behind your draft instead of consuming the hint.
- **Short personal questions work.** "how old is my son", "where do i live" —
  these are one meaningful word after stopwords, and the lexical matcher scored
  every record in the store identically for them, so the "best" match was
  whichever id sorted first. These are now admitted on question shape and ranked
  by meaning. Questions about the *work* ("why is my test failing", "where is my
  config file") are deliberately excluded: measured 0 false hints across 14 of
  them.
- **Common memory.** A shared store every agent can match against, ranked as its
  own corpus, for facts that belong to you rather than to one agent.
- **A hint now says where it came from**, and no longer causes an agent to
  retract a correct answer. Previously an agent could answer from a hint, fail to
  find the source on the next turn (the hint is deliberately not repeated), and
  disown its own correct answer as something it had invented.
- Hints have a Preferences checkbox, and semantic ranking has its own.

### Semantic ranking (optional — needs Ollama)

Ranking by meaning rather than by shared words. **Ollama is not a dependency**:
without it every path reports "no opinion" and hint behaviour is exactly what it
was before — no errors, no hangs, no degraded mode. With it (`nomic-embed-text`),
hints get markedly better at paraphrase.

Note for anyone who enabled this during development: a caching bug caused each
agent's indexing pass to evict every other agent's vectors, so the feature could
never warm up. Fixed.

### Memory store

- `[agent:memory remember] tags=a,b` is parsed instead of being swallowed into
  the body — tags written this way previously vanished, taking any `pinned=true`
  after them with it.
- The operator owns pinning. An agent's own `pinned=true` is a recency nudge, not
  a guaranteed slot, and short recent units ride in full by default.
- Unknown frontmatter keys survive a rewrite instead of being dropped, and tags
  are searchable.
- The save instruction now asks for one usable claim rather than an essay —
  memories over ~600 bytes are never delivered in full, so a long memory is
  closer to no memory.
- A memory offered in truncated form can now actually be loaded. Recall searched
  only the agent's own store, so any offer naming a common-store id answered "no
  match" — an instruction the agent could not follow, failing silently.

### Teams and intents

- `[agent:context clear]` takes an optional continuation body, so a cleared
  session can brief its own next conversation instead of waking up amnesiac.
- `[agent:spawn]` honours a template's env through the reviewer allowlist.
- Exec definitions take a `${TEAM_ROOT}` placeholder, so one definition serves
  every team.

### Fixes

- Typing in a session no longer stalls for ~200 ms when hints are enabled; the
  ranking pass had been running on the keystroke path.
- The draft a hint ranks against now models a line editor, so Ctrl-W, Ctrl-K,
  cursor edits and history recall no longer rank text you had already deleted.
- Operator messages delivered to several sessions were journalled once per
  destination, inflating the index with duplicates; they are collapsed, keeping
  every origin.
- `REGISTRY_DIR` resolves to the app root rather than `CLODEX_HOME` for teams.
- Vendored wirescope v0.6.46.
