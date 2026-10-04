# session-manager.js

## Module-level helpers: exec status, stream codecs, boot-nudge probe, spill — execElapsedLabel … nearMissFormHint

| symbol | purpose | state | calls | pins |
|---|---|---|---|---|
| `execRunStatusReply` | one-line `status:` reply to an exec status query: one run by seq or the last 3 newest-first, tails trimmed by code point, then each head's cmd clipped, to stay inside a 400-char cap | none (pure) | execElapsedLabel | unpinned |
| `isScratchCutText` | true when a text starts with a scratch briefing prefix or the handoff-continue line, i.e. a manager-injected scratch cut | none | scratchRealArrivals | unpinned |
| `streamCodecCtx` | `{bypass, readOnly, model}` codec context for a stream seat, derived from its adapter and extra argv; readOnly accepts the long, short and `--flag=value` spellings of the cap | none (pure) | cli-adapters.adapterFor, cli-adapters.hasBypass, cli-adapters.hasReadOnlyCap, cli-adapters.resolveModelId | session-manager.test.js |
| `escapeSafeTail` | last `max` code units of a buffer, advanced past an escape sequence or a low surrogate the cut would split | none (pure) | none | session-manager.test.js |
| `bootNudgeProbeOf` | the first non-blank line of injected bytes, paste markers and Ctrl-U stripped, as up to 32 ink-visible chars to look for in the echo | none (pure) | inkVisibleText | unpinned |
| `stripCodexStreamArgs` | `{args, dropped}`: a codex argv minus the flags app-server refuses (with their value, including the `--flag=value` form) | none (pure) | none | unpinned |
| `spillAckLine` | the `[clodex] ... filed at <path>` notice for a prose spill, null for every other verb | none | none | spill-resolve-intent.test.js |
| `nextIncarnation` | a process-life id `pid.base36time.seq` for a spawned session, compared by ticket replay | module `incarnationSeq` | none | session-manager.test.js agent-plugin-spawn.test.js wire-off.test.js stock-template-tool-floor.test.js |
| `preseedClaudeOnboarding` | marks onboarding done and the cwd folder-trusted in `~/.claude.json` so a headless first claude spawn does not stall on a prompt | `~/.claude.json` | none | claude-onboarding-preseed.test.js |
| `nearMissFormHint` | the "command goes AFTER the bracket" hint when a bounced line starts `[agent:term`, else empty | none | none | unpinned |

### Invariants

- `nextIncarnation` stays module-level and is not a deps seam, because every value it is compared against was minted by the same build and the pid is what makes it unique across app processes.
- `preseedClaudeOnboarding` is merge-only: nothing to change is a no-write false, unparseable JSON is never clobbered, credentials are not touched, and any failure degrades to the prompt instead of blocking the spawn.
- `bootNudgeProbeOf` is sized by the module constant BOOT_NUDGE_PROBE_CHARS, and the echo it is matched against is capped by BOOT_NUDGE_ECHO_CAP in the pty data handler of `_createReserved`, while the nudge timings are the factory's deps-injected BOOT_NUDGE_MS family in `createSessionManager`.
- `nearMissFormHint` only names the correct form and must never reconstruct or run the command the line probably meant.
- `stripCodexStreamArgs` reports what it dropped so `_createReserved` can log it, because posture and model ride the codec instead of the argv on a stream seat.

### Hazards

- `isScratchCutText` reads SCRATCH_CUT_TEXT_PREFIXES, which is defined further down the file, so calling it at module load would throw a TDZ ReferenceError.
- `preseedClaudeOnboarding` writes through a tmp file and a rename, which replaces a symlinked `~/.claude.json` with a regular file instead of writing through the link.

## Process reaping, exit disposition and peer keys — sigkillPid … seatRelFiles

| symbol | purpose | state | calls | pins |
|---|---|---|---|---|
| `sigkillPid` | SIGKILLs a pid only when it is positive, and warns and refuses otherwise because non-positive pids broadcast | OS processes | none | sigkill-pid-guard.test.js sigkill-pid-census.test.js reap-seat-descendants.test.js session-move.test.js |
| `ptyOwnership` | classifies a pty pid in a ps snapshot as gone, ours (direct child of the owner pid) or foreign | none (pure) | none | term-marks-bash.test.js |
| `reapFromSnapshot` | SIGKILLs every descendant of a pty pid, but only when that pty is our direct child, and returns the count | OS processes | ptyOwnership, stall-evidence.descendantPids, sigkillPid | reap-seat-descendants.test.js |
| `reapPtyDescendants` | async entry point that takes a fresh ps snapshot and reaps beneath a pty with the owner pid set to process.pid | OS processes | psSnapshot, reapFromSnapshot | unpinned |
| `isStaleRegistration` | whether a blocking agent.json may be force-cleaned: its pid is dead or is our own pid (the fixed-pid Docker case) | none (pure) | none | session-manager.test.js |
| `exitDisposition` | `{expected, dropRecord, stampExited}` for a process exit, from agentType and the kill/shutdown/archive/move flags | none (pure) | none | session-move.test.js |
| `missingToolOnExit` | names the missing binary when an exit looks like node-pty's silent execvp failure (unexpected code 1, no signal, within 5s) | none (pure) | none | diag-tools.test.js |
| `nameConflict` | live, persisted or null for a name being minted at the spawn front door | none (pure) | none | session-manager.test.js ipc-handlers-team.test.js |
| `deniedBodyDisposition` | spill, note or none for the body of an intent the gate refused, with the label used in the report | none (pure) | none | session-manager.test.js |
| `findPeerByOrigin` | the peer record whose label, then id, then host matches a DM origin case-insensitively | none (pure) | none | relay-roster-intake.test.js session-manager.test.js |
| `seatRelFiles` | a name-sorted list of relative regular-file paths under a seat dir, the file list for a move-to-peer shipment | none (reads fs) | none | unpinned |

### Invariants

- `exitDisposition` folds `_userKilled`, `_shuttingDown`, `_archived` and `_moving` into `expected`, and its `dropRecord === !agentType && !expected` is the natural-exit record gate, so only a bash shell that exits on its own loses its record.
- `sigkillPid` exists for its `> 0` guard alone, because -1 signals the whole desktop and 0 the app's own process group.
- `reapFromSnapshot` refuses any pty that is not a direct child of the owner pid, so a stale or stubbed pid (or pid 1) never reaps someone else's tree.
- `nameConflict` guards only the mint front door, and the resume paths (restore, unarchive, restart, move) deliberately bypass it.
- `deniedBodyDisposition` defaults to note, so a verb nobody classified reports its destroyed body instead of dropping it silently.

### Hazards

- `reapPtyDescendants` must run while the pty is still alive, because after it exits its children reparent, `ptyOwnership` reports gone and nothing is reaped.
- `isStaleRegistration` returns true for any own-pid record although its comment scopes that clause to a session this process is not running, so a new caller passing a live seat's agent.json would force-clean a running registration.
- `findPeerByOrigin` looks up label, id, host while `peerOriginSuffix` emits label, host, id, so a peer whose suffix is a shared host (tunnelled peers on 127.0.0.1) resolves to the first peer with that host.
- `seatRelFiles` skips unreadable dirs and symlinks without a word, so a move-to-peer shipment silently omits them.

## createSessionManager factory, constructor and the wire runtime — createSessionManager … _onHoldLifecycle

| symbol | purpose | state | calls | pins |
|---|---|---|---|---|
| `createSessionManager` | builds one SessionManager from deps: destructured collaborators, NO_ARM stand-ins, deps-injected timing constants and the tickets store | factory-scope bindings (arm, speaker, BOOT_NUDGE_MS, ticketsStore) | SessionManager, tickets-store.createTicketsStore | session-manager.test.js createdat-restart.test.js wire-quota-seam.test.js session-move.test.js |
| `SessionManager` | the box-wide owner of every live seat: spawn, IO, intents, windows, wire, voice, move and teardown | `this.sessions`, `this.windows`, `sessions.json` | constructor, create, _ensureWire, _cleanup | session-manager.test.js session-manager-muse.test.js web-host.test.js exited-seat-row.test.js |
| `constructor` | initialises the session and window maps, focus/mic/app-focus voice routing, relay and ticket bookkeeping, and the intent deduper and activity tracker | `this.sessions`, `this.windows`, `this._micTarget`, `this._appFocused`, `s.activityTs` | wire-intents.IntentDeduper, wire-intents.ActivityTracker, _emitActivity | session-manager.test.js session-manager-muse.test.js |
| `_ensureWire` | the in-process WireProxy, memoised in `this._wire` with an in-flight `this._wirePending` so overlapping callers share one build | `this._wire`, `this._wirePending` | _buildWire | session-manager.test.js wire-off.test.js wire-quota-seam.test.js wire-totals-durability.test.js |
| `_buildWire` | opens the warmth store and hold keeper, restores perpetual holds, then starts the wire, stopping the keeper if the start throws | `this._holdKeeper`, wire-warmth.sqlite, wire-hold-entries.json | _startWire, _restorePerpetualHolds, _onHoldLifecycle | unpinned |
| `_startWire` | constructs, listens and subscribes the WireProxy: quota, spill family, turn start and completion, telemetry and failure recovery | `this._wire`, `this._shadow`, `this._wireTelemetry`, `s.lastMainStop` | _handleIntent, _onWireSessionRotated, _maybeRearmHold, quotaStore | unpinned |
| `_onWireSessionRotated` | backstop conversation handover when a wire turn is the first news of a /clear: ends the old hold and moves the seat onto the new sessionId | `s.sessionId`, `s._holdRearmed`, `s._leftSessionIds`, `sessions.json` | _noteSessionLeft, _wireSessionCorroborated, _noteConversationForDigest | clear-continuation.test.js session-manager.test.js |
| `_maybeRearmHold` | restores a persisted keep-warm intent onto the seat's current wire id, retried every main-line turn until an arm lands | `s._holdRearmed`, `sessions.json` holdUntil | wire/hold.rearmPlan | keepwarm-restart-preserve.test.js clear-continuation.test.js session-manager.test.js |
| `_onHoldLifecycle` | the hold keeper's event sink: writes re-anchored deadlines, reopens the re-arm gate on a failures disarm, and reports disarms and pings | `sessions.json` holdUntil, `s._holdRearmed` | _nameForWireSession, _keepwarmRow, keepwarmPingBody | clear-continuation.test.js session-manager.test.js |

### Invariants

- `createSessionManager` binds `arm` to the NO_ARM stand-in (and selection, voice-origin, termExec and speaker to their own stand-ins) so every call site runs unguarded, and the NO_SELECTION_ARM stand-in reports a refusal instead of a bare `{armed:false}`.
- `createSessionManager` derives BOOT_DRAIN_SETTLE_MS, BOOT_NUDGE_MS, BOOT_NUDGE_QUIET_MS, BOOT_NUDGE_MAXWAIT_MS, SPEC_CONFIRM_MS and DM_LATCH_CAP once from deps with production defaults, and SPEC_CONFIRM_MS is lent to team-tickets.js instead of being re-derived there.
- `constructor` keeps `_micTarget` separate from `_focusedSession` and starts `_appFocused` false, so no seat arms the microphone before a host has reported focus.
- `_startWire` keeps a per-batch fired Set on the wire path because the deduper allows wire-after-wire, while exempting exec from that intra-turn dedup.
- `_onWireSessionRotated` ends the old sessionId's hold before reassigning `s.sessionId`, refuses ids in `s._leftSessionIds`, and resets `_holdRearmed` itself.
- `_onHoldLifecycle` never erases a persisted keep-warm intent on a ping failure, and only a failures disarm reopens the re-arm gate.
- `constructor` stamps `activityTs` from the ActivityTracker `onEvent` callback with Math.max, because `_emitActivity` fires only on a label change and an out-of-order event must not drag idleMs back into the hold band.

### Hazards

- `_startWire`'s recovery replay dedups every intent type intra-turn, including exec, so a recovered turn holding two identical exec calls runs one while the live wire path would run both.
- `_maybeRearmHold` must stay outside the rotation guard in `_startWire`, or the first turn after an app restart never re-arms, and it must stay main-line-only or a perpetual hold arms with no replayable entry.
- `_buildWire` stops the hold keeper when `_startWire` throws but leaves the warmth store open, so a retry opens a second WarmthStore on the same sqlite file.
- `createSessionManager` reads spawnStreamSeat, reapBeforeResume, streamFor, loadStreamCodec, streamProc, speaker, claudeHome and the timing overrides off deps outside the destructure, so the destructure is not the full collaborator list.

## Windows, quota and the broadcast seam — _keepwarmRow … _broadcast

| symbol | purpose | state | calls | pins |
|---|---|---|---|---|
| `unregisterWindow` | drops a workspace's window handle on close and stops the box-wide speaker, which nothing else on that path would | `this.windows` | none | session-manager.test.js web-host.test.js peer-web-host.test.js |
| `workspaceForWindow` | reverse lookup of a handle's workspace id by `===` identity, null when not registered | `this.windows` | none | session-manager.test.js |
| `windowForSession` | the live handle of a session's workspace window, null once the session has left the map or its window is destroyed | `this.sessions`, `this.windows` | windowForWorkspace | external-tap-trigger.test.js session-manager.test.js |
| `quotaStore` | the account plan-quota store, built on first use so the startup read restores from disk before any wire or session exists | `this._quotaStore`, wire-quota.sqlite | wire/quota.QuotaStore, _shadowLog | wire-quota-seam.test.js |
| `_sendToSession` | sends one channel event to the session's workspace window, buffering pty-data into pendingOutput (2MB cap, cut by escapeSafeTail) when no window is live | `s.pendingOutput` | windowForSession, escapeSafeTail | session-manager.test.js exited-seat-row.test.js session-move-workspace.test.js web-host.test.js |
| `_broadcast` | sends one channel event to every live window handle, the fan-out for keep-warm rows, quota and ipc-message lines | `this.windows` | allLiveWindows | session-manager.test.js wire-quota-seam.test.js proxy-poller-quota.test.js |

### Invariants

- `_sendToSession` routes by the session's workspace window, so the exit path in `_createReserved` sends session-exit before `_cleanup` removes the session that window resolution needs.
- `windowForWorkspace` and `workspaceForWindow` touch a handle only through `.isDestroyed()` and `===` identity, and `_sendToSession` and `_broadcast` only through `.webContents.send`, because web-host handles are plain literals.
- `quotaStore` is built on first use rather than in `_ensureWire`, and lives in userData rather than run/<name>/, so a cold launch can show the restored reading before any wire-routed seat spawns.
- `_broadcastQuota` sends quota on its own wire-quota channel instead of the wirescope poller's payload, so the wire source never depends on a wirescope base existing.

### Hazards

- `_sendToSession` drops pty-data silently once the session has left `this.sessions`, and every other channel whenever no window is live.
- `unregisterWindow` deletes by workspace id without checking the handle, so a late close after a replacement `registerWindow` for the same workspace drops the live handle and diverts output into pendingOutput.
- `quotaStore` latches null for the process lifetime on a construction failure, with no retry.

## create() and the spawn path — create … _createReserved

| symbol | purpose | state | calls | pins |
|---|---|---|---|---|
| `create` | public spawn entry: rejects a live or reserved duplicate name, reserves xdg-overlay names in `_creating`, and delegates to `_createReserved` | `this._creating` | _createReserved, cli-adapters.adapterFor | session-manager.test.js create-mint-census.test.js createdat-restart.test.js session-move.test.js |
| `_createReserved` | the one spawn body: builds argv and env per agent type, spawns the pty or stream seat, registers the socket, records the live session and persistence, wires watchers and exit | `this.sessions`, `sessions.json`, run/<name>/ agent.json, `s.pendingOutput` | _sendToSession, _cleanup, exitDisposition, _ensureWire | unpinned |

### Invariants

- `_createReserved` builds claude argv by adding the generated `--settings` hook (unless the user passed one), `--add-dir` for the message dir, `--resume` with `--fork-session` on a fork, `--system-prompt-file` and `--append-system-prompt-file`, while codex stream argv goes through `stripCodexStreamArgs` and bash runs the shell with the extra args verbatim.
- `_createReserved` registers the agent socket first and binds second, and a force-clean of a blocking record happens only when the pre-bind probe proves it dead or `isStaleRegistration` says so and the record bytes are unchanged.
- `_createReserved` stamps each live session with `nextIncarnation` (minted, never persisted) and attaches a TranscriptSentinel for wire-sourced seats and a JsonlWatcher for every other agent seat.
- `_createReserved`'s pty data handler caps scrollback, forwards output through `_sendToSession` (which buffers up to 2MB in pendingOutput for a detached window), and arms the boot drain on the first bracketed-paste edge after BOOT_DRAIN_SETTLE_MS.
- `_createReserved`'s exit handler runs a fixed order: `_dead` first, `_sendToSession` session-exit before `_cleanup`, remote notify, then persistence by `exitDisposition` (a bash natural exit removes the record, an unexpected agent exit stamps exitedAt), then `_cleanup`.
- `_createReserved` buffers pty exit events and stream lines that arrive before the session exists and replays them once the exit handler and `_onStreamEvent` route are installed, so an early exit is not lost.
- `_createReserved` stamps createdAt once, computed above the upsert and baked into the hook, and re-mints it whenever the record is gone, so every kill()-based restart must re-seed it through `_preserveAcrossRestart` before create.
- `_createReserved`'s onSessionId clear branch calls `_noteSessionLeft` before `_holdKeeper.endSession`, whose synchronous hold event resolves the seat off the list, and duplicates `_onWireSessionRotated`'s handover on purpose because the symlink repoint usually arrives first.

### Hazards

- `_createReserved` calling `_cleanup` before `_sendToSession` session-exit strands a dead sidebar tab, because window resolution needs the session still in the map.
- `_createReserved` must compute `expected` and the record drop through the one `exitDisposition` call, since a flag added to one and not the other makes an expected exit also drop the record.
- `create` forwards its raw `arguments`, so its own defaults never reach `_createReserved` and a parameter added or reordered in one signature must be mirrored in the other.
- `create` reserves the name only for xdg-overlay adapters, so for every other type two concurrent creates both pass the duplicate check and only the proven-live socket veto in `_createReserved` stops the second from rebinding.
- `_createReserved` resolves prompt args and the baked prompt from one `_realIpcFor` call, and splitting it into two calls can bake a prompt out of sync with the argv.

## Exec ledger and stream-seat IO — lastOperatorInputAt … _refuseStreamInject

| symbol | purpose | state | calls | pins |
|---|---|---|---|---|
| `lastOperatorInputAt` | box-wide stamp of the last operator input (write, seatSend, seatControl), 0 before any | `this._lastOperatorInputAt` | none | injected-turn-bit.test.js headless-reboot.test.js |
| `inFlightExecRuns` | "<seat> run #N (cmd)" for every running exec run on a live seat, dead seats skipped | `s.execRuns`, `this.sessions` | none | exec-run-lost-restart.test.js |
| `_loadLostExecRuns` | lazily reads the in-flight exec ledger once per process, keeping only well-formed name/seq/cmd rows | `this._lostExecRuns`, REGISTRY_DIR exec ledger file | `_execLedgerPath` | unpinned |
| `deliverLostExecRuns` | on a new host, tells each live seat its in-flight exec run died, records it `lost`, keeps rows for persisted-not-live seats | `this._lostExecRuns`, `s.execRuns`, exec ledger file | `_loadLostExecRuns` `_writeExecLedger` `_injectText` | exec-run-lost-restart.test.js |
| `seatSend` | stream-seat composer send: arms the hint, holds idle delivery on its promise up to STREAM_ARM_WAIT_MS, enqueues as operator | `this._lastOperatorInputAt`, `s._armWait`, `s.outbox` | `_armSubmit` `_streamReleaseHeld` `_streamEnqueue` | seat-send-images.test.js session-manager.test.js api-contract.test.js |
| `seatControl` | operator stop/compact/clear on a stream seat, refusing while a reload/compact/clear is in flight; wire context cmd over a slash cmd | `this._lastOperatorInputAt`, `s.outbox` | `seatInterrupt` `_executeCompact` `_streamEnqueue` `_injectText` | session-manager.test.js transcript-pull-outbox.test.js api-contract.test.js |
| `_streamEnqueue` | single entry into a stream outbox: delivers at once when idle, unheld and the outbox is empty, else queues operator-first with parkKey replace and drains through `_streamTurnEnd` when idle, unheld and not init-stalled | `s.outbox`, `s.streamBusy`, `s._outboxRev` | `_streamHintHeld` `_streamDeliver` `_streamJoin` `_streamHoldPoll` `_streamTurnEnd` | session-manager.test.js |
| `_streamTurnEnd` | end-of-turn drain: marks idle, re-polls while hint-held, else delivers a lone wire item or the joined batch before it | `s.streamBusy`, `s.outbox` | `_streamHintHeld` `_streamJoin` `_streamDeliver` `_streamSent` | unpinned |
| `_onStreamPermission` | records a CLI permission request, raises a permission attention plus ipc line, notifies the OS when the window is unfocused | `s.streamPermissions`, `s._streamPermRev`, `s.needsAttention` | `_setAttention` `_broadcast` `windowForSession` | unpinned |
| `seatPermission` | answers one pending permission request with the operator's choice through the codec's encodePermission | `s.streamPermissions`, `s._streamPermRev`, `s.needsAttention` | `_streamSend` `_setAttention` `_sendToSession` | session-manager.test.js renderer-source-pins.test.js api-contract.test.js |
| `_onStreamEvent` | stream seat event pump: close tears down holds and reports exit, else decodes one line and dispatches by kind | `s._slashCommands`, `s._streamInitStalled`, `s._toolDrainedInTurn`, `s._resultHold` | `_streamTurnEnd` `_repointStreamTranscript` `_onStreamToolBoundary` `_onStreamPermission` | session-manager.test.js |
| `_repointStreamTranscript` | keeps run/<name>/transcript on the live stream transcript: record mode links the reported path, claude mode relinks to <sid>.jsonl | run/<name>/transcript symlink, `s._repointSkipLogged` | `_claudeTranscriptPath` `linkTranscript` `streamFor` | session-manager.test.js |
| `_refuseStreamInject` | true (with a warn and 80-byte preview) when a stream seat is dead or streamless so callers drop the inject; false for PTY | none | none | unpinned |

### Invariants

- `_streamEnqueue` is the only way into `s.outbox`, and it attaches onSend, produce and parkKey as non-enumerable properties so `seatOutbox` snapshots never carry them.
- `_streamTurnEnd` always delivers a wire item alone, never joined with queued text.
- `_streamTurnEnd`, `_streamEnqueue` and `_streamReleaseHeld` all consult `_streamHintHeld`, so a hint arm still in flight holds idle delivery on every drain path, bounded by HINT_HOLD_MAX_MS.
- `_loadLostExecRuns` and `_writeExecLedger` keep the exec ledger at the REGISTRY_DIR root, not under run/<name>/, so it survives the per-seat exit cleanup that `deliverLostExecRuns` must outlive.
- `seatSend` and `seatControl` stamp `lastOperatorInputAt` only after validating the seat and the command.

### Hazards

- `_streamTurnEnd` and `_streamEnqueue` call `_streamSent` whether or not `_streamDeliver` succeeded, so an item whose encodeUser yields nothing is consumed and its onSend still fires.
- `seatPermission` clears attention of ANY kind when the last request is answered, while its stale branch and `_dropStreamPermissions` clear only kind permission, so an unrelated attention can be wiped.
- `seatSend` chains `.finally` on the hint arm's promise with no catch, so a rejecting arm becomes an unhandled rejection.
- `_onStreamEvent` calls `_repointStreamTranscript` gated only on transcriptPath and passes sessionId unchecked, so a claude-mode seat whose init lacks an id relinks to undefined.jsonl.

## Operator input, drafts, voice and focus — write … resize

| symbol | purpose | state | calls | pins |
|---|---|---|---|---|
| `write` | operator keystrokes into a PTY seat: for human input on a live PTY seat stamps clocks, tracks paste/submit edges, clears attention, folds the draft | `this._lastOperatorInputAt`, `s.lastUserInputTs`, `s.lastUserSubmitTs`, `s._inPaste`, `s.needsAttention` | `_foldDraft` `_setAttention` `isHumanPtyInput` | hint-arm.test.js injected-turn-bit.test.js dictated-draft-protection.test.js |
| `_foldDraft` | carries the PTY draft as line-editor state and drives the hint arm: disarm on clear, submit on Enter, onDraft otherwise | `s._draftState`, `s._draft` | `foldDraft` `_armSubmit` `_armCtx` | unpinned |
| `_armSubmit` | submit edge shared by PTY and stream seats: final onDraft plus onSubmit, retires the selection queue, returns the arm's landed value | none (hint-arm and selection-arm module state) | `_armCtx` `_sendToSession` | unpinned |
| `_armCtx` | the one hint-routing context {agent, base, route} every hint path is built from | none | `resolveProxyBase` | hint-arm.test.js selection-arm.test.js session-manager.test.js |
| `noteVoiceRecording` | renderer's level report that a recorder is lit: stamps seat and box, stops narration on the rising edge | `s.lastVoiceRecordingTs`, `this._lastVoiceRecordingTs` | `speaker.interruptForRecorder` | speaking-defers-inject.test.js spoken-replies.test.js |
| `noteFocusedSession` | a window's report of which seat it shows: always updates tap routing, moves the mic only from the focused window of a frontmost app | `this._focusedSession`, `this._micTarget` | `_setMicTarget` | external-tap-trigger.test.js spoken-replies.test.js |
| `_voiceRoute` | the single decline table for voice verbs: named or focused seat, refusing missing, dead, voice-off or windowless seats | none | `voiceModeFor` `windowForSession` | external-tap-trigger.test.js |
| `voiceTap` | external wake-word entry: routes to a seat, takes the mic for it, raises its window when needed, sends the tap frame | `this._micTarget` | `_voiceRoute` `_setMicTarget` `_sendToSession` | external-tap-trigger.test.js |
| `resize` | resizes a live PTY, logs only on a changed size/requester key, and tells the remote server | `s._lastLoggedResize` | `getRemoteServer` | peer.test.js drawer-pty.test.js |

### Invariants

- `write` folds the draft only inside the isHumanPtyInput gate, so injected dm, nudge and ticket text never reaches the hint accumulator.
- `_foldDraft` is never awaited and swallows every error, so hint work can never stand between the operator's keystroke and the PTY write in `write`.
- `_armCtx` is the only place a hint base is resolved, using the live pref as a boolean and the spawn-captured base as the value, and preferring the exact proxyAgent route over the glob.
- `_setMicTarget` is the only writer of the microphone target, and `voiceTap` calls it only after every `_voiceRoute` decline and before both the raise and the frame.
- `noteVoiceRecording` keeps its own per-seat field plus a box-wide copy and computes the rising edge before stamping, so the lastUserInputTs readers are untouched.
- `voiceTap` raises its window (show then focus) when the caller asks or the app is backgrounded, after the retarget and before the frame, so no path arms the recorder in a background app without raising first.

### Hazards

- `noteFocusedSession` moving the microphone on a per-window report without both box-wide focus facts would retarget dictation to a seat the operator cannot see.
- `_voiceRoute` falls back to the focused seat only on an absent target; `voiceSelect` must keep its own empty-name check or an unset shell variable arms a seat nobody named.
- `_armSubmit` returns the arm's landed promise, which `_foldDraft` discards and `seatSend` chains without a catch.

## kill, destroy, archive, rename: the record-droppers — kill … rename

| symbol | purpose | state | calls | pins |
|---|---|---|---|---|
| `kill` | user-initiated stop of a live seat that also DROPS its persistence record before the process dies; a no-op on a seat not in the map | `s._userKilled`, sessions.json record, proxy spawner-hint row | `_notifyComposition` `_procPid` `sigkillPid` `reapPtyDescendants` | session-manager.test.js session-forget-ipc.test.js reap-seat-descendants.test.js sigkill-pid-guard.test.js |
| `_waitForExit` | polls `this.sessions` every 100ms up to 8s and reports whether the seat left the map | `this.sessions` | none | session-rename.test.js session-move.test.js session-move-peer.test.js session-manager.test.js |
| `destroy` | end a seat for good: kill it, remove the worktree its record names, then drop record and seat dir only when nothing is stranded | sessions.json record, REGISTRY_DIR seat dir, worktree on disk | `kill` `_waitForExit` `clearHintForRecord` `gitWorktree.removeWorktree` | worktree-restart-preserve.test.js session-manager.test.js |
| `archive` | stop a live seat but KEEP its record stamped archivedAt, so the row resumes with --resume | `s._archived`, sessions.json archivedAt | `_notifyComposition` `sigkillPid` `reapPtyDescendants` | reap-seat-descendants.test.js sigkill-pid-guard.test.js |
| `_stopForRespawn` | the record-keeping stop shared by rename, move and moveToPeer: stream kill, or captured-pid SIGKILL timer plus descendant reap | none (the process only) | `sigkillPid` `reapPtyDescendants` | unpinned |
| `rename` | give a seat a new name: refuse ticket/assignee seats and collisions, stop it, move name-keyed state, respawn with --resume | `this._movingNames`, `s._moving`, sessions.json key, seat dirs, pending/<name>, library/memory-loadlog/<name>.jsonl, team lead pointer | `_stopForRespawn` `_waitForExit` `_renameDirs` `create` | session-rename.test.js |

### Invariants

- `kill` calls getPersistence().remove() UNCONDITIONALLY, agent or bash, before the pty dies, so a killed agent's record is gone and the bash drop gate `exitDisposition` feeds in the exit handler only suppresses a redundant second remove.
- `kill` returns at its `if (!s) return;` before its remove, so on an already-dead seat only `destroy` drops the record; without that own drop the worktree goes and the record naming it stays.
- `destroy` drops the record per return, never up front: the no-worktree and worktree-removed returns drop it, the `_waitForExit` timeout return (process still running, tree kept, `ok: false`) and the removeWorktree failure return keep it (each re-upserting it archived for a live seat whose record `kill` already removed).
- `destroy` is the only route that ends a seat for good; restart paths call `kill` on purpose because they recreate the same seat, so worktree removal must never be folded into `kill`.
- `archive` keeps the record stamped archivedAt and sets `s._archived` without touching `s._userKilled`, so `exitDisposition` treats the exit as expected and the record survives.
- `rename`, `move` and `moveToPeer` stop through `_stopForRespawn`, never `kill`, because the record is exactly what they must keep.

### Hazards

- The full record-dropper set is docs/sessions.md's "Every record-dropper" list (not re-copied here so it cannot drift); `kill` and `destroy` are the two that live in this file, and a new getPersistence().remove() call site outside that list is a record dropped where nobody expects one.
- `destroy` on a live seat relies on `kill` having already cleared the proxy hint, since its dropRecord is a no-op when the seat was live.
- `rename` spells out the 26-argument `create` call a third time (with `move` and `moveToPeer`), so a new `create` parameter must be added to all three or a respawn silently drops it.

## move, moveToWorkspace, moveToPeer — move … moveToPeer

| symbol | purpose | state | calls | pins |
|---|---|---|---|---|
| `move` | re-home a seat to a new local cwd: stop it, rewrite cwd, unarchive, respawn with --resume, announce a team change | `this._movingNames`, `s._moving`, sessions.json cwd and archivedAt | `_stopForRespawn` `_waitForExit` `create` `_notifyComposition` | session-move.test.js session-rename.test.js |
| `moveToWorkspace` | reassign a seat (live or archived) to another workspace window with no kill or respawn; the old window always gets moved-out | sessions.json workspaceId, `s.workspaceId` | `windowForWorkspace` `session-restore.liveSnapshotFor` `archivedSnapshotFor` | session-move-workspace.test.js session-move.test.js |
| `_moveBadSegment` | pre-flight: first seat-kind or pending/ relative path with a segment a peer would refuse, else null | none | `seatRelFiles` | unpinned |
| `_moveRecord` | the record shipped to a peer: cwd set to the far cwd, MOVE_TO_PEER_OMIT keys removed, account carried by label | none | `getAccounts.labelFor` | unpinned |
| `_moveShipment` | the file manifest for a peer move: transcript, every non-run seat kind, pending/<name>, memory load log, reminder rows | none | `seatRelFiles` `getReminders.listForAgent` | session-move-peer.test.js |
| `moveToPeer` | ship a Claude seat's conversation and state to a peer, then keep a local archived backup stamped movedTo; respawn here if refused and it was live here | `this._movingNames`, `s._moving`, sessions.json movedTo and archivedAt | `_moveRecord` `_moveShipment` `_stopForRespawn` `create` | session-move-peer.test.js session-move.test.js preserve-census.test.js |

### Invariants

- `move` and `moveToPeer` refuse a second call for a name held in `this._movingNames` for the whole call, not off the live `s._moving`, because a not-live record has no session to carry that flag.
- `move` keeps the record and rewrites only cwd (clearing archivedAt), and its `create` catch arm clears the archive stamp a second time because re-upserting the pre-move snapshot brings it back.
- `moveToWorkspace` sends session:moved-out to the OLD window directly through `windowForWorkspace`, never via `_sendToSession`, which resolves the window from the new workspaceId.
- `moveToWorkspace` builds the session:moved-in row with the same liveSnapshotFor or archivedSnapshotFor that session-restore uses, so the moved row and a restored row cannot drift.
- `moveToPeer` on success stamps movedTo and archives the record, never deleting it, so this box keeps the backup and a click resumes a fork.
- `moveToPeer` makes every refusal (sessionId shape, `_moveBadSegment`, transcript lookup, far importBegin probe) before the pty is touched, so a refusal costs no kill.

### Hazards

- `_moveBadSegment` and `_moveShipment` walk the same kind list (SEAT_KINDS minus run, plus pending/); widening one without the other lets a peer refuse a file mid-ship.
- `moveToPeer` composes the transcript path from claudeHome() with no account dir, while `_moveRecord` knows the seat may run under another CLAUDE_CONFIG_DIR, so a non-live seat on another account can fail with transcript not found.
- `moveToPeer` never calls importAbort when importShip returns ok false, unlike its exit-timeout and throw arms, so the peer may keep a stranded staged import.

## Prompt, team block, roster and restart plumbing — clearHintForRecord … _accountForWireAgent

| symbol | purpose | state | calls | pins |
|---|---|---|---|---|
| `clearHintForRecord` | clears the proxy spawner-hint row a dropped record set, for exits with no live session to read spawnerHintSet from | remote proxy hint table (via HTTP) | `resolveProxyBase` `ProxyClient.spawnerHint` | session-forget-ipc.test.js |
| `_teamBlockFor` | the team half of the IPC prompt (team block plus role prompt unless it rides as system file), reporting a missing role prompt | none (reads team.json and prompt files each call) | `resolveTeam` `formatTeamBlock` `matchSeatRole` `readSystemPromptBody` | prompt-refresh-recipe.test.js team-prompt-dir.test.js team-preflight.test.js resolve-seat-shape.test.js |
| `_realIpcFor` | the one recipe for append-prompt bytes, built from the recipe captured at create() plus a freshly resolved team block | none | `_resolveExecDefs` `buildIpcPrompt` `mergeClaudeSystemPrompt` | prompt-refresh-recipe.test.js plugin-scope.test.js team-prompt-dir.test.js |
| `refreshPrompt` | at a clear or compact of a live claude seat, re-stages the snapshot-to-current prompt gap as a delta without rewriting append-prompt.md | staged delta under run/<name>/, shadow log | `_teamBlockFor` `_realIpcFor` `_snapshotBlockFor` `restageAtReset` | prompt-refresh-recipe.test.js prompt-regen-at-clear.test.js prompt-regen-at-compact.test.js prompt-snapshot-baseline.test.js |
| `teamNameFor` | the team name owning a cwd, or null, swallowing resolveTeam throws | none | `resolveTeam` | session-move.test.js session-restore.test.js session-manager.test.js |
| `_teamLiveSeats` | {name, label} for every live agent seat whose `_projectRootFor` equals the given root, with a warmth label | `this.sessions`, `this._proxyPoller` | `_projectRootFor` `peerStatusLabel` | session-manager.test.js |
| `composeRosterFor` | a seat's roster body, reading cwd from persistence when the seat is not in the map yet; null when teamless | sessions.json (read) | `resolveTeam` `formatRoster` `_teamLiveSeats` `_seatGrants` | session-manager.test.js |
| `_stripClaimedTree` | a pre-kill snapshot with its worktree pointer removed iff a different live seat now holds that checkout | none | `_ticketTreeHolder` (team-tickets) | preserve-across-restart.test.js |
| `resumeCwdOf` | the cwd to resume a record in, falling back to the worktree's main (and rewriting the record) when the tree is gone | sessions.json cwd and worktree | none | resume-cwd-tree-fallback.test.js session-restore.test.js |
| `_preserveAcrossRestart` | after kill() and before create(), upserts a stub re-seeding caller-named fields plus ALWAYS_PRESERVE from the pre-kill entry | sessions.json record | `_stripClaimedTree` | preserve-across-restart.test.js preserve-census.test.js keepwarm-restart-preserve.test.js createdat-restart.test.js |
| `_injectRoster` | claude: parks the roster passively, re-bakes the digest, stamps rosterSentAt; others: stash the team ref for `_settleBoot` | `session._pendingRoster`, sessions.json rosterSentAt | `_deliverPassive` `_rebakeDigest` `_markRosterSent` | session-manager.test.js |
| `_settleBoot` | closes the boot window: delivers a stashed roster rendered fresh (stamping on write), then replays tickets | `session._bootSettling`, `session._pendingRoster` | `_deliverMessage` `_markRosterSent` `_teamLiveSeats` | session-manager.test.js ticket-replay.test.js |
| `_notifyComposition` | sends a passive composition delta to the team lead only and re-bakes the digest of every other live claude teammate | teammates' digest files, lead pending store | `_deliverPassive` `_rebakeDigest` `formatCompositionDelta` | session-manager.test.js session-move.test.js reap-seat-descendants.test.js |
| `modelFor` | a seat's effective model from its persistence record, or empty string | sessions.json (read) | `_settingsModelResolver` `effectiveModel` | unpinned |
| `accountFor` | the account label for a seat's CLAUDE_CONFIG_DIR, or default | sessions.json (read) | `_accountResolver` | unpinned |

### Invariants

- `_realIpcFor` is the single recipe shared by create() and `refreshPrompt`, and `_teamBlockFor` the single team-block assembly, because a second copy drifts and stages a phantom delta at every reset.
- `_teamBlockFor` is deliberately not cached, so a team.json or role-prompt edit lands at the seat's next context reset, and it reports a missing role prompt instead of blocking the spawn.
- `refreshPrompt` never rewrites append-prompt.md and refuses a seat with no captured promptRecipe rather than rebuilding one from the persistence entry.
- `_preserveAcrossRestart` carries ALWAYS_PRESERVE (sessionIds) whether or not a caller names it, and counts the seed after `_stripClaimedTree` so a bare name never manufactures a record.
- `_stripClaimedTree` strips only for a live holder other than the seat itself, keeps the pointer on any throw, and is the path every pre-kill snapshot write-back (rename, move, moveToPeer, restart catch arms) runs through.
- `_settleBoot` stamps rosterSentAt only from the write callback and replays tickets outside the roster guard, so a resumed seat with no pending roster still gets its replay.

### Hazards

- `clearHintForRecord` must run before the record is removed and keep its spawnerHintSet gate, or a blind clear wipes an operator's out-of-band /_hint override.
- `_notifyComposition` scopes teammates with findProjectRoot while `_teamLiveSeats` and `_projectRootFor` call themselves the one live-seat scope, so a teamless-repo divergence is possible.
- `_preserveAcrossRestart` returns before the ALWAYS_PRESERVE loop when fields is not an array, so a caller omitting the list loses sessionIds although ALWAYS_PRESERVE exists to carry them.
- `_injectRoster` writing actively into a booting non-claude TUI leaves the roster as an unsubmitted draft; only the stashed team ref rendered by `_settleBoot` is safe.
- `_stripClaimedTree` guards the kill-to-exit window in which a restarting seat is live but named by no record; a wholesale snapshot write-back there puts a second record on a tree another seat is committing in.

## Snapshots, list, workspace queries and the voice engine — list … killVoiceEngine

| symbol | purpose | state | calls | pins |
|---|---|---|---|---|
| `list` | renderer row for every live session (type, pid, voice, effort, posture, team, role, ticket badge, activity, account, model, pending count) | `this.sessions`, `sessions.json` via getPersistence().list, tickets store, per-call memo Maps | `_teamLiveSeatNames`, `_procPid`, `accountFor`, `modelFor` | session-manager.test.js team-seat-rows.test.js ipc-unscoped-listing.test.js accounts-session.test.js |
| `listForWorkspace` | `list` rows filtered to one workspace, live sessions only | `this.sessions` | `list` | workspace-delete-orphans.test.js workspace-count-suffix.test.js session-manager.test.js |
| `savedForWorkspace` | the workspace's persisted rows with no live session (archived or saved-not-running), the count the Delete Workspace confirm shows | `sessions.json`, `this.sessions` | getPersistence().listForWorkspace | workspace-delete-orphans.test.js workspace-count-suffix.test.js |
| `purgeWorkspace` | Delete Workspace teardown: kill live seats, then clear the hint and remove every persisted row still tagged with the workspace | `sessions.json` (remove), proxy hint table, `this.sessions` | `listForWorkspace`, `kill`, `clearHintForRecord`, getPersistence().remove | workspace-delete-orphans.test.js |
| `livePids` | set of PTY pids (stream pids for stream-io seats) across live sessions | `this.sessions` | none | unpinned |
| `pendingCountFor` | parked-DM count for a live claude seat, 0 for anything else | pending store under PENDING_DIR | countPending | compact-indicator.test.js session-restore.test.js |
| `killAll` | app-quit teardown: set quitting, mark every seat shutting down, reap PTY descendants from one ps snapshot, kill every PTY or stream and the voice engine | `s._shuttingDown`, module appQuitting flag | reapFromSnapshot, `killVoiceEngine` | session-manager.test.js voice-engine.test.js spoken-replies.test.js |
| `ensureVoiceEngine` | the live voice engine once ready, or the single in-flight spawn joined or started | `this._voiceEngine`, `this._voiceEnginePending` | `_spawnVoiceEngine` | voice-engine.test.js |
| `_spawnVoiceEngine` | spawns the box-wide `claude` voice-engine PTY, registers it as a wire voice sink, resolves once its prompt mark goes quiet or the boot cap fires | `this._voiceEngine`, wire agent VOICE_ENGINE_NAME, engine.promptWaiters | `_ensureWire`, `windowForWorkspace`, `_voiceEngineSelfStopped`, `voiceEngineTimings` | unpinned |
| `killVoiceEngine` | drops the box-wide voice engine: nulls the field, kills its PTY, unregisters its wire agent | `this._voiceEngine`, `this._wire` | none | voice-engine.test.js |

### Invariants

- `purgeWorkspace` tears a workspace down over persistence, not the live map, because an archived seat is never spawned and so never appears in `listForWorkspace`.
- `purgeWorkspace` calls `clearHintForRecord` before each remove, since dropping the record is the last moment the proxy route id is knowable and the hint table has no TTL.
- `list` resolves a seat's role once per call and reuses it for the ticket badge, so the badge and the row's role cannot disagree about which role a seat holds.
- `list` leaves role and ticket null for non-agent sessions by construction, since a bash session has no registry entry and cannot hold a role.
- `ensureVoiceEngine` keeps exactly one engine per box by sharing the in-flight `_spawnVoiceEngine` promise and clearing it in finally.

### Hazards

- `purgeWorkspace` is a record-dropper behind the Delete Workspace… menu: it calls getPersistence().remove on every row tagged with the workspace, archived and saved rows included, with no undo.
- `list` keys its ticket badge on the team root from resolveTeam, while `_projectRootFor` says a solo seat's board is the repo root, so a teamless seat's open ticket may be missing from first paint.
- `killAll` calls s.stream.kill() and reapFromSnapshot outside any try, so a throw for one seat skips every later seat's kill and `killVoiceEngine`.
- `_spawnVoiceEngine` sends pty-data straight to a window's webContents, so any use of a window handle beyond webContents.send there breaks web-host clients only at runtime.
- `list` must keep its live-seat lookup memoized per root, because it runs per session times ticket and `_teamLiveSeatNames` rebuilds a proxy snapshot per live seat.

## _cleanup, PTY output scan, activity, attention and compaction — _cleanup … _firePostClearContinuation

| symbol | purpose | state | calls | pins |
|---|---|---|---|---|
| `_cleanup` | tears down every per-seat timer, watcher, wire registration, hook file and map entry once the process exits, so nothing fires into a same-named successor | `this.sessions`, ~20 `s._*Timer` fields, `s._compactPending`, `s._postClearContinuation`, `this._intentDeduper`, `this._activity`, `this._reportCache` | `_onCompactEnd`, `_armCtx`, `_scratchDropPendingBegin`, registry.unregister | session-manager.test.js dm-delivery-latch.test.js ipc-prompt-cache-rework.test.js wire-spill-shown-store.test.js |
| `_scanPtyOutput` | line-at-a-time intent scan over raw PTY output (the non-transcript path), handing each parsed intent except escape and end to the router | `session.lineBuffer` (tail capped at 64KB) | parseIntent, `_handleIntent` | session-manager.test.js |
| `_emitActivity` | the single activity-edge sink: stamps state, clears turn latches on a non-idle edge, flushes held injects and drains mail on idle, notifies renderer, remote and OS | `s.activityState`, `s.activityTs`, `s._turnStartedAt`, `s.lastMainStop`, `s._specUnconfirmed`, `s._bootNudgeTimer`, `s._reviewStartTimer` | `_clearDmConfirm`, `_setAttention`, `_maybeFlushInjectQueue`, `_drainPendingAtIdle` | session-manager.test.js dm-delivery-latch.test.js jsonl-activity-turnend.test.js ticket-replay.test.js |
| `_onAttention` | classifies a hook notification (idle dropped), sets attention, broadcasts it and OS-notifies when the owning window is unfocused | `session.needsAttention` | `_setAttention`, `_broadcast`, notifyOS | compact-indicator.test.js |
| `_onCompactStart` | on every PreCompact re-arms the compacting valve; on the first sets the compacting state and announces compact started | `session.compacting`, `session._compactingValveTimer` | `_onCompactEnd`, `_sendToSession` | compact-indicator.test.js |
| `_onCompactEnd` | idempotently clears compacting; outside exit appends a capped notice, bumps the rev and announces compact finished on done | `session.compacting`, `session._compactNotices`, `session._compactNoticeRev` | `_sendToSession`, `_broadcast` | compact-indicator.test.js |
| `_fireCompactContinuation` | compact-landed handler: ends compacting, voids scratch marks, resets memory and hint ledgers, then cold-respawns or re-stages and injects the continuation | `session._compactContinuation`, `session._compactGuard`, `session._compactValveTimer` | `_compactRegen`, `refreshPrompt`, `_handoffText`, `_releaseCompactGuard` | session-manager.test.js handoff-spill.test.js prompt-regen-at-compact.test.js compact-indicator.test.js |
| `_injectHoldReason` | the predicate every inject checks: compact-window, dialog (permission attention), busy (thinking), or null | `session._compactGuard`, `session.needsAttention`, `session.activityState` | none | session-manager.test.js renderer-source-pins.test.js |
| `_armCompactGuard` | holds all non-bypass injects across a Clodex-driven compact, with a fresh inject-hold valve | `session._compactGuard`, `session._injectHoldTimer` | `_armInjectValve` | session-manager.test.js |
| `_armCompactValve` | COMPACT_INFLIGHT_TIMEOUT release valve that clears stuck compact state without retry, announces it, and flushes | `session._compactValveTimer`, `session._compactPending`, `session._compactGuard`, `session._compactContinuation` | `_clearCompactValve`, `_maybeFlushInjectQueue` | session-manager.test.js |
| `_firePostClearContinuation` | on the sessionId-change edge consumes the post-clear continuation, cancels its valve and injects the handoff text after a delay | `session._postClearContinuation`, `session._postClearValveTimer` | `_clearPostClearValve`, `_handoffText`, `_injectText` | session-manager.test.js clear-continuation.test.js handoff-spill.test.js hint-arm.test.js |

### Invariants

- `_cleanup` is reached from `_createReserved`'s process-exit handler after the record disposition, and it never removes parked deliveries or the frozen prompt under any gate, `_userKilled` included, because restart also routes through `kill`.
- `_cleanup` stops the watcher before speaker.stop(), because the watcher's final flush re-enters `_maybeSpeak` and can start a narration for the dead seat.
- `_cleanup` passes the dying session's `_armCtx` to selectionArm.forget, because a name-glob fallback would otherwise keep the attachment matching a same-named replacement.
- `_emitActivity` stamps activityTs from the wire's last event, not Date.now(), so an inferred idle edge cannot make a cold seat look fresh and get its dm delivered instead of held.
- `_emitActivity` clears the spec latch only on a turn attributed to that ticket in the transcript, and a null probe trusts the turn.
- `_scanPtyOutput` is deliberately not fence-aware, since one unclosed fence in a PTY stream would disable intent scanning for the pane's life.

### Hazards

- `_emitActivity` flushes held injects and drains pending mail on any idle edge, while its own comment says idle also fires mid-turn and only notify means turn-end.
- `_emitActivity` clears the plain-dm latch through `_clearDmConfirm` on any non-idle edge with no transcript attribution, unlike the spec latch beside it.
- `_compactRegen` nulls the continuation and clears the valve before `_coldRespawn`, so a failed respawn falls through to `_fireCompactContinuation` with the continuation already gone.
- `_fireCompactContinuation` must reset memLoad and the hint-offer ledger side by side and must not rewrite the frozen prompt file, which the CLI would not re-read.
- `_firePostClearContinuation` must stay on the sessionId-change edge, since a timer would inject into whatever conversation is current.

## Inject valves, queue flush and the boot nudge — _armPostClearValve … _armBootNudge

| symbol | purpose | state | calls | pins |
|---|---|---|---|---|
| `_armPostClearValve` | COMPACT_INFLIGHT_TIMEOUT expiry that drops a post-clear continuation whose clear never landed, logged and announced, no retry | `session._postClearValveTimer`, `session._postClearContinuation` | `_clearPostClearValve`, `_broadcast` | unpinned |
| `_maybeFlushInjectQueue` | releases the held-inject queue once no hold reason remains (or when forced), rerouting to the stream outbox for stream-io seats | `session._injectQueue`, `session._injectHoldTimer`, `session._injectFlushRetry` | `_injectHoldReason`, `_flushInjectRun`, `_streamEnqueueSystem`, `_injectText` | session-manager.test.js handoff-snapshot.test.js handoff-spill.test.js |
| `_flushInjectRun` | writes one run of plain texts and producers as a single inject, turning the whole run into a producer when any entry is one | none | `_injectText` | unpinned |
| `_drainPendingAtIdle` | on idle, enqueues a parkable late-claiming producer that drains an idle claude seat's active parked mail at write time | pending store under PENDING_DIR (claimed in the producer) | `_anyDraftOpen`, `_bornFor`, `_injectText` | session-manager.test.js dictated-draft-protection.test.js |
| `_drainPendingAtBootReady` | boot-ready twin of the idle drain: peeks, then enqueues a late-claiming producer straight onto the PTY inject queue with the park divert | pending store under PENDING_DIR | `_anyDraftOpen`, `_injectQueueFor`, `_parkDivertFor`, `_bornFor` | session-manager.test.js dm-delivery-latch.test.js parked-drain-fallback.test.js dictated-draft-protection.test.js |
| `_recordBootNudgeProbe` | records once the first visible line (up to 32 chars) of a boot-window write as the echo probe and starts the echo buffer | `session._bootNudgeProbe`, `session._bootNudgeEcho` | `bootNudgeProbeOf` | unpinned |
| `_bootNudgeEchoed` | predicate: has the pane echoed the probe (or the paste placeholder) since the write | `session._bootNudgeProbe`, `session._bootNudgeEcho` | `inkVisibleText` | unpinned |
| `_armBootNudge` | once per claude seat, after a boot-window write, sends a bare Enter if no turn starts within BOOT_NUDGE_MS and the echo is seen on a quiet, draft-free pane | `session._bootNudgeArmed`, `session._bootNudgeTimer`, `session._bootReadyAt`, `session._lastPtyDataAt`, `session.firstInputAt` | `_recordBootNudgeProbe`, `_bootNudgeEchoed`, `_anyDraftOpen` | session-manager.test.js |

### Invariants

- `_flushInjectRun` turns a mixed run into one producer so the destructive claim still happens at write time, never eagerly on the hold-release path.
- `_drainPendingAtIdle` and `_drainPendingAtBootReady` claim parked mail only inside the producer, so a seat that dies or opens a draft before the write leaves the delivery parked.
- `_armPostClearValve` expires a continuation without retry, because a later manual clear must not receive a stale briefing.
- `_armBootNudge` only fires when `_bootNudgeEchoed` is true, the pane has been quiet for BOOT_NUDGE_QUIET_MS and no draft is open, otherwise it re-arms every quiet interval until BOOT_NUDGE_MAXWAIT_MS after the write.
- `_armBootNudge` arms only within INJECT_BOOT_MAXWAIT of `_bootReadyAt` and at most once per session, and any non-idle edge in `_emitActivity` cancels its timer.

### Hazards

- `_drainPendingAtIdle` must guard dictated drafts as well as typed ones via `_anyDraftOpen`, or a passive park is re-parked active and wakes the seat.
- `_drainPendingAtBootReady` logs its claimed-but-empty bail apart from the silent deferred bails, and that split is the only evidence left when a boot-window delivery goes missing.
- `_maybeFlushInjectQueue` with force set skips `_injectHoldReason`, so the inject-hold valve writes into a seat that may still be busy or behind a dialog.
- `_recordBootNudgeProbe` depends on the PTY onData handler in `_createReserved` appending to the echo buffer only while it is a string, so nulling it early disables the echo gate and the nudge never fires.
- `_armBootNudge` declares a local arm closure that shadows the factory-scope hint arm used by `_cleanup` and `_fireCompactContinuation`.

## Intent extraction and agent-text publication — _pointerStubOf … _maybeSpeak

| symbol | purpose | state | calls | pins |
|---|---|---|---|---|
| `_expandReceipts` | rewrites unfenced spill stubs and receipt lines into full intent blocks from the seat's spill files, recording spillAt and collecting unresolved receipts | spill files under REGISTRY_DIR (read only) | `_pointerStubOf`, resolveSpill, resolveReceipt, fencedLines | unpinned |
| `_extractIntents` | fence-aware turn-text intent list: optional receipt expansion, then scanIntentLines, near-misses collapsed into one unknown intent with a more count | none | `_expandReceipts`, scanIntentLines | session-manager.test.js intent-scanner.test.js spill-resolve-intent.test.js plugin-text-feed.test.js |
| `_scanJsonlText` | JSONL-watcher junction for one flushed chunk: speak, publish, extract and dispatch intents, close scratch at turn end, nudge a prose-only reviewer verdict | `s._flushTurnEnd`, `s._verdictNudged`, `this._shadow` | `_maybeSpeak`, `_publishAgentText`, `_extractIntents`, `_handleIntent` | session-manager.test.js plugin-text-feed.test.js reviewer-prose-verdict-nudge.test.js |
| `_publishAgentText` | the single consume-only door for main-line turn text to the phone progress nudge and the plugin fireAgentText feed, never throws | none | getRemoteServer().notifyProgress, getPluginHooks().fireAgentText | plugin-text-feed.test.js file-view-api.test.js spill-resolve-intent.test.js session-manager.test.js |
| `_maybeSpeak` | reads a seat's final reply aloud only at turn end, only with speakReplies on, only for the seat holding control, never over a live microphone | uiSettings speakReplies, `this._micTarget`, `this._focusedSession`, `this._lastVoiceRecordingTs` | speakable, speaker.speak | spoken-replies.test.js external-tap-trigger.test.js file-view-api.test.js spill-resolve-intent.test.js |

### Invariants

- `_scanJsonlText` speaks and publishes only when the seat is not a wire-routed seat with a live tee, so a tee-blind Bedrock or Vertex seat keeps this watcher as its only voice and feed.
- `_extractIntents` is fence-aware and turn-bounded, unlike `_scanPtyOutput`, and tags each spill-expanded intent with the spill it came from.
- `_publishAgentText` swallows every throw because its caller is the wire event handler that also dispatches intents.
- `_maybeSpeak` reads speakReplies fresh per turn and gates on the box-wide recording stamp, never the per-seat one.
- `_maybeSpeak` speaks only for `_micTarget` or else `_focusedSession`, because speak() kills the previous utterance and several narrating seats would complete none.

### Hazards

- `_scanJsonlText` calls the async `_handleIntent` with neither await nor catch, so a rejection from a registry or transport await is unhandled and later intents of the same turn can run first.
- `_scanJsonlText` splits authority by kind in shadow mode (jsonl dispatches intents, the wire publishes and speaks), and unifying either half double-delivers or drops.
- `_scanJsonlText` bounces an intent whose body was still open at an interrupt instead of applying the partial body, so removing that check applies truncated bodies.
- `_expandReceipts` keeps an unresolvable spill stub line as-is but turns an unresolvable receipt into an unresolved intent, and `_handleIntent` relies on that intent.receipt to report it.

## _handleIntent routing, shout, spill and reboot — _handleIntent … _turnSinceRebootPark

| symbol | purpose | state | calls | pins |
|---|---|---|---|---|
| `_handleIntent` | central router for a parsed intent: bounces unknowns, drops typed spill pointers, resolves spills, gates per seat, then dispatches dm, resend, who, name, context, scratch, memory, spawn, file, term, exec, remind, shout, team-review, review-done, task, team, team-create, reboot or a plugin verb; records a spawn or team-create on the open scratch marks before its first await, every other watched verb after dispatch | `intent.body`, `intent.spill`, parked files under PENDING_DIR (resend claims and re-parks) | `_gatedDeliver`, `_armDmConfirm`, `_spillTyped`, `_dispatchPluginIntent` | session-manager.test.js dm-delivery-latch.test.js spill-resolve-intent.test.js plugin-surface-contract.test.js |
| `_handleIntentBody` | the router body `_handleIntent` runs, inside the reply scope when a socket caller passed `replyTo` | as `_handleIntent` | as `_handleIntent` | unpinned |
| `_startIntentSocket` | binds the seat's `intent.sock` with its credential and the request handler that dispatches through `_handleIntent` | `session.intentSocket`, `session.intentCred` (non-enumerable) | createIntentSocketServer, createIntentRequestHandler | intent-socket.test.js |
| `_dispatchPluginIntent` | default router arm: runs a plugin-registered handler synchronously against the seat's plugin handle, turning a throw into a parkable error inject | none | pluginRowFor, getPluginHooks().handleFor, `_injectText` | unpinned |
| `_handleShoutIntent` | shout verb: validates a non-empty note up to SHOUT_MAX_BYTES, files it in the operator inbox, raises a note, and archives a fix session on DEPLOY OK | notifications store | `_raiseNote`, `archive`, `_sendToSession` | session-manager.test.js deploy-visible.test.js body-preview.test.js |
| `_spillTyped` | drops an intent whose body the agent typed as a spill pointer or runtime note, bouncing the correction at most once per reqId | `session.spillMimicReq`, shadow log | `_shadowLog`, `_broadcast`, `_injectText` | unpinned |
| `_spillUnresolved` | drops a spill-verb intent whose pointer names no spill file Clodex wrote, raising an operator note and asking the seat to re-emit | none | `_raiseNote`, `_injectText` | unpinned |
| `_raiseNote` | operator attention: an OS notification with a 200-char preview plus a notify ipc-message to the user | none | notifyOS, `_broadcast` | spill-resolve-intent.test.js |
| `_handleRebootIntent` | reboot verb: refuses when the host cannot relaunch or inside REBOOT_MIN_INTERVAL, else persists the notice and hands the host a relaunch with an abandon callback | uiSettings lastRebootAt and pendingRebootNotice, scratch marks | `_bornFor`, `_rebootAbandoned`, `_voidScratchMark`, relaunchApp | headless-reboot.test.js reboot-abandon-stale-seat.test.js |
| `_rebootAbandoned` | undoes a cancelled or timed-out deferred reboot: clears this request's notice only, tells the operator, and tells the requester only if the same generation is live | uiSettings pendingRebootNotice | `_broadcast`, `_injectText` | reboot-abandon-stale-seat.test.js session-manager.test.js |
| `maybeDeliverRebootNotice` | on restore delivers the persisted restarted notice: park plus flush and retry for live claude, direct for live codex, offline park otherwise; drops stale or exhausted notices | uiSettings pendingRebootNotice, parked files under PENDING_DIR, `target._rebootNoticeRetryTimer` | `_buildDeliveryText`, `_armParkCap`, `_armRebootNoticeFlush`, `_armRebootNoticeRetry` | session-manager.test.js |
| `_armRebootNoticeFlush` | the notice's own REBOOT_NOTICE_FLUSH_MS deadline that forces the park out unless the seat took a turn, re-arming while a draft is fresh | `target._rebootNoticeFlushTimer`, `target._rebootNoticeFlushFire`, `target._rebootNoticeDraftStaleMs` | `_turnSinceRebootPark`, `_flushParkedNow` | unpinned |
| `_armRebootNoticeRetry` | stamps an attempt on the notice and arms the in-launch re-offer ladder, clearing the notice once the seat takes a turn | uiSettings pendingRebootNotice.attempts, `target._rebootNoticeRetryTimer` | `_turnSinceRebootPark`, `maybeDeliverRebootNotice` | session-manager.test.js |
| `_turnSinceRebootPark` | predicate both reboot timers check: did the seat take a real (non-seeded) turn after the park | `target.lastMainStop`, `target._turnStartedAt` | none | unpinned |

### Invariants

- `_handleIntent` bounces unknown verbs with a seat-scoped valid list, so it never advertises a plugin the seat does not have.
- `_handleIntent` arms the dm latch at the dm arm through `_armDmConfirm`, not inside `_gatedDeliver`, because that is the one site with a live sender to tell.
- `_handleRebootIntent` captures born and the request time before relaunch, so `_rebootAbandoned` can tell this request from a same-name one up to 30 minutes later.
- `_rebootAbandoned` clears pendingRebootNotice only on a name and timestamp match and leaves lastRebootAt set, so abandon opens no rapid-retry window.
- `maybeDeliverRebootNotice` does not clear the notice after a live claude park, because a park is a promise to deliver, and its age and attempt bounds are checked before any attempt.
- `maybeDeliverRebootNotice` suppresses a duplicate offer while `_armRebootNoticeRetry` has a timer in flight, keyed on that timer rather than a launch flag so the give-up path stays reachable.

### Hazards

- `_handleIntent` claims a parked message destructively on resend, so any new early exit after the claim must re-park it or the message is lost.
- `_handleIntent` answers who, name and dm whenever a session exists, while every other arm requires an agent seat, so a bash pane printing an intent gets a reply injected into its shell.
- `maybeDeliverRebootNotice` clears the notice right after a live codex `_deliverMessage`, so a write lost into a booting codex leaves no durable copy.
- `_armRebootNoticeFlush` re-arms without a round bound while a draft is fresh, relying on `_armParkCap` as the backstop, and adding a bound reinstates the draft splice.
- `_armRebootNoticeFlush` forces out the seat's whole park dir through `_flushParkedNow`, so other parked mail for that seat leaves early with the notice.

## remind, exec, term, file, memory and context intents — _handleRemindIntent … _handleContextIntent

| symbol | purpose | state | calls | pins |
|---|---|---|---|---|
| `_handleRemindIntent` | runs `[agent:remind]` list, cancel or schedule, refusing a `for <ticket>` binding to a missing or terminal ticket | remind scheduler records via sched.add and sched.cancel | parseRemindSpec, ticketTerminalReason, `_injectText`, `_broadcast` | ticket-reminder-binding.test.js session-manager.test.js body-preview.test.js spill-resolve-intent.test.js |
| `_resolveExecDefs` | maps a seat's execCommands grants to name, description and schema prompt shapes, degrading to the bare id string | none (reads team exec defs and REGISTRY_DIR/library/exec) | readTeamJson, isFilenameToken | team-templates-exec.test.js session-rename.test.js intent-checklist-seam.test.js |
| `_handleExecIntent` | runs a granted registry command with the validated payload on stdin, tracking long runs (only once the child has a pid) with status notices, timeout and status query | `session.execRuns`, exec run ledger via `_writeExecLedger`, child process, timeout and status timers | execRunStatusReply, parseAndValidate, childProcess.spawn, `_writeExecLedger` | exec-run-status.test.js exec-run-status-query.test.js exec-run-lost-restart.test.js exec-team-root.test.js |
| `_handleTermIntent` | runs `[agent:term exec]` on the sender's own terminal tab; the result arrives later on the selection queue | none (side effect inside termExec) | termAvailableFor, termExec, `_injectText`, `_broadcast` | term-busy-names-program.test.js host-log-mask.test.js session-manager.test.js |
| `_handleFileIntent` | vets and opens a file externally or shows it in the seat's window, rate-limited to 5 per 30s | `session._fileIntentTs` | vetFileIntent, openPath, `windowForSession` | unpinned |
| `_maybeDeliverDigest` | delivers the memory boot digest as a memory DM to a live idle Claude seat whose current conversation is not yet digested | persistence markDigested, memLoad digest observation | memoryStore.list, composeDigest, `_deliverMessage` | session-manager.test.js worktree-restart-preserve.test.js file-view-api.test.js spill-resolve-intent.test.js |
| `removeMemoryUnit` | the one memory-unit delete path for the intent and host.library.remove, returning an ok or error envelope | memory store, `session.digestNonEmpty`, digest file | memoryStore.forget, writeClaudeDigestFile | session-manager.test.js |
| `setOperatorPin` | toggles a unit's operator pin and rebakes a live Claude seat's digest, returning an ok or error envelope | memory store, `session.digestNonEmpty`, digest file | memoryStore.setOperatorPinned, writeClaudeDigestFile | unpinned |
| `_handleMemoryIntent` | runs `[agent:memory list, remember, recall, pin, unpin, forget]` against the seat's own store and refreshes the boot digest | memory store, `session.digestNonEmpty`, digest file, persistence markDigested, memLoad recall log, run acks file | `_memoryAck`, `removeMemoryUnit`, commonMemoryRecall, `_deliverMessage` | memory-load.test.js session-manager.test.js body-preview.test.js spill-resolve-intent.test.js |
| `_deniedIntentPayload` | builds the disabled-intent reply suffix, spilling the denied body up to DENIED_SPILL_CAP times per seat and verb | `session._deniedSpills`, spilled message files, filed ring | deniedBodyDisposition, spillToFile, `_noteFiled` | unpinned |
| `_promptDeltaPending` | says whether a live Claude seat's freshly composed IPC prompt differs from the baked one, so clear must cold-respawn | reads prompt cache and snapshot, writes out.bytes | `_teamBlockFor`, `_realIpcFor`, ipcDelta | prompt-regen-at-clear.test.js prompt-regen-at-compact.test.js |
| `_coldRespawn` | deferred kill plus create respawn with the persisted spawn config, injecting a handoff as turn one of the fresh process | `session._reloadInFlight`, `this._freshBakeOnce`, `fresh._scratchVoid`, sessions.json strip level, label and failure upsert | `kill`, `create`, `_preserveAcrossRestart`, `_injectReloadHandoff` | resume-cwd-tree-fallback.test.js |
| `_handleContextIntent` | runs `[agent:context reload, compact, clear]`: reload and prompt-changed clear cold-respawn, compact latches or fires, clear injects | `session._compactPending`, `session._postClearContinuation` | `_coldRespawn`, `_executeCompact`, `_promptDeltaPending`, `_voidScratchMark` | clear-continuation.test.js reload-env.test.js prompt-regen-at-clear.test.js session-manager.test.js |

### Invariants

- `_handleExecIntent` takes argv wholly from the registry entry and hands the validated payload to the child only over stdin, which makes argv injection structurally impossible.
- `_handleExecIntent` reports a timeout distinctly from a failure and says the command may still be running, so the caller does not re-fire a lock-taking command.
- `_handleRemindIntent` refuses a ticket binding with the same ticketTerminalReason predicate used at close time, so the refused set and the collected set cannot drift.
- `removeMemoryUnit` and `setOperatorPin` scope the digest rebake to a best-effort try after the permanent store write, so a rebake failure never reports the write as failed.
- `_handleContextIntent` refuses a body-less reload before `_coldRespawn` kills anything, so the live session stays intact.
- `_coldRespawn` defers the kill and create with setImmediate so the JsonlWatcher that triggered it is not torn down inside its own callback.
- `_deniedIntentPayload` never spills past its per-seat, per-verb cap, because a denied seat repeats the verb every turn and the spill sweep bounds file age, not write rate.

### Hazards

- `_coldRespawn` and `_scratchRespawn` each hand-copy the positional create() arguments, so a new create() parameter must be threaded into both or respawned seats silently lose it.
- `_handleMemoryIntent` keeps setPinned and the digest refresh in one try for pin and unpin, so a digest-write throw reports "could not pin" for a pin that was already stored.
- `_maybeDeliverDigest` marks the conversation digested before `_deliverMessage` inside a swallow-all catch, so a throwing delivery leaves a digest marked that never arrived.
- `_handleMemoryIntent` parses directive keys with one regex alternation that stops at the first unknown key, so a new key left out of it strands every directive behind it.

## Scratch cut — _handleScratchIntent … _recordScratchDispatch

| symbol | purpose | state | calls | pins |
|---|---|---|---|---|
| `_handleScratchIntent` | Claude-only dispatcher for `[agent:scratch begin, mark, cancel, end, rewind]`, returning the end promise so a cut can be awaited | none | `_scratchBegin`, `_scratchCancel`, `_scratchEnd` | session-manager.test.js |
| `scratchMark` | operator API that sets a labeled mark at the transcript end, returning ok with nonce and offset or an error broadcast to the IPC log | `session._scratchMarks` via `_scratchMark` | `_scratchBeginTail`, `_scratchBeginSettled`, `_scratchMark` | ipc-scratch-mark.test.js api-contract.test.js session-manager.test.js |
| `_scratchBegin` | entry for begin and mark: queues behind a pending begin, defers an unsettled tail, else marks or refuses now | reads `session._scratchPendingBegin` | `_scratchBeginTail`, `_scratchDeferBegin`, `_scratchMark`, `_scratchBeginRefuse` | unpinned |
| `_scratchDeferBegin` | parks a begin or mark until the transcript reaches the turn end, waking on fs.watch and forcing a decision after SCRATCH_CLOSE_TIMEOUT | `session._scratchPendingBegin` with its watcher and timer | `_scratchWakePendingBegin`, `_scratchDropPendingBegin`, `_scratchSettleRequests` | unpinned |
| `_scratchMark` | creates an episode or labeled mark at a proven turn boundary, capturing offset, tail bytes, leaf uuid and usage, and acks it; refuses when the slot's prior mark has an end or rewind pending | `session._scratch`, `session._scratchMarks`, `session._scratchVoid` | scratchBeginCutAt, scratchNonce, `_scratchUsageAt`, `_scratchMarksOf` | session-manager.test.js |
| `_scratchCancel` | drops a pending begin, a labeled mark or the episode without cutting, and records a cancelled episode row | `session._scratchPendingBegin`, `session._scratchMarks`, `session._scratch`, `session._scratchVoid` | `_scratchDropPendingBegin`, `_scratchRewindTarget`, `_recordScratchEpisode` | unpinned |
| `_scratchEnd` | validates the end or rewind target and summary, then fires the close now or arms a SCRATCH_CLOSE_TIMEOUT re-emit fallback | mark.closing, mark._closeTimer, `session._scratchVoid` | `_scratchRewindTarget`, `_scratchClosingMark`, `_fireScratchClose` | unpinned |
| `_fireScratchClose` | consumes the closing mark's pending close and runs the cut; the trigger when the reply's turn end lands | mark.closing, mark._closeTimer | `_scratchClosingMark`, `_runScratchCut` | session-manager.test.js file-view-api.test.js spill-resolve-intent.test.js |
| `_scratchRespawn` | re-creates the seat on the same sessionId with its full persisted config and sends the reattach context-action | sessions.json strip level and label | `create`, `resumeCwdOf`, `_sendToSession` | resume-cwd-tree-fallback.test.js session-manager.test.js |
| `_runScratchCut` | runs the cut steps and always records the episode row in finally, substituting a failed disposition on a throw | none | `_scratchCutSteps`, `_recordScratchEpisode` | unpinned |
| `_recordScratchEpisode` | appends one scratchCostRecord row per episode outcome to the team or seat cost file and broadcasts a summary line | team scratch-cost.jsonl or the seat's scratch episodes.jsonl | scratchCostRecord, `_scratchCostPath`, `_scratchEpisodeLine` | session-manager.test.js |
| `_scratchCutSteps` | front half of a cut: refuses on no record, unreadable transcript, failed validation or a move in flight, then guards the name | `this._movingNames` | `_scratchValidate`, `_scratchRefusalLine`, `_scratchCutAfterGuard` | unpinned |
| `_scratchCutAfterGuard` | quiesces and recycles the process, revalidates, backs up and atomically truncates the transcript, respawns, briefs and re-arms | `session._holdRearmed`, `session._recycling`, scratch .bak files, the transcript, snapshot cache | `_scratchRecycle`, `_scratchRespawnSafely`, `_injectAfterBoot`, `_scratchReArm` | session-manager.test.js |
| `_scratchCarryMarks` | moves other open marks to the fresh seat only when older than the cut and acked below it | `fresh._scratchMarks`, `fresh._scratch` | `_scratchAckedIn`, `_scratchOpenMarks` | unpinned |
| `_scratchRestore` | copies the backup over the transcript when it exists and reports whether it did | the transcript file | none | unpinned |
| `_scratchRespawnSafely` | restores from backup, respawns and moves open marks to the fresh seat, upserting a stripped record on failure | `fresh._scratchMarks`, `fresh._scratch`, sessions.json | `_scratchRestore`, `_scratchRespawn`, `_stripClaimedTree` | unpinned |
| `_voidScratchMark` | voids every open mark and leaves a tombstone that bounces the next scratch verb, optionally telling the seat | `session._scratch`, `session._scratchMarks`, `session._scratchVoid` | `_scratchOpenMarks`, `_injectText` | session-manager.test.js |
| `_recordScratchDispatch` | appends a dispatched-work token to every open mark so the cut can demand the summary names it | mark.dispatched | `_scratchDispatchToken`, `_scratchOpenMarks` | unpinned |

### Invariants

- `_scratchMark` places a mark only on a turn boundary proven by the transcript tail, and `_scratchBegin` refuses or defers anything else.
- `_runScratchCut` records the episode row in finally, so refused, failed and cut episodes all produce one measurement row.
- `_scratchCutSteps` holds the seat name in `_movingNames` with a finally-delete, so a cut never races a move or rename under one name.
- `_scratchEnd` allows only one pending close at a time through `_scratchClosingMark`, and the first end or rewind is the one that fires.
- `_scratchCarryMarks` keeps another mark only when it is older than the cut and its ack sits below it, since a mark acked above the cut can never validate.
- `_scratchCutAfterGuard` revalidates on the quiet file after the process exits and writes the truncation to a temp file that is fsynced and renamed over the transcript.

### Hazards

- `_scratchCancel` resolves a bare cancel through `_scratchRewindTarget`, so it drops the newest labeled mark instead of the episode that the begin ack says it cancels.
- `_scratchRespawn` and `_coldRespawn` hand-copy create()'s positional arguments and already diverge on workspaceId defaulting, so each must be edited when create() changes.
- `_scratchCutAfterGuard` leaves the .bak in place for `_scratchPruneBaks` to expire by age, while docs/sessions.md says it is removed once the respawned CLI writes its first assistant record.

## Compact, reload and resume handoffs — _executeCompact … _noteFiled

| symbol | purpose | state | calls | pins |
|---|---|---|---|---|
| `_executeCompact` | Sends a compact now (wire system enqueue or hold-bypassing typed command) with its continuation, guard and valve armed | `s._compactContinuation`, `s.sentinel` | _streamEnqueue, _injectText, _armCompactGuard, _armCompactValve | session-manager.test.js |
| `_maybeFireCompactLatch` | Fires a latched compact once canFireCompact sees both inject queues drained, clearing the latch first | `s._compactPending`, `s._injectQueue`, `s._injectPtyQueue` | compact-latch.canFireCompact, _executeCompact, _shadowLog | session-manager.test.js spill-resolve-intent.test.js file-view-api.test.js |
| `_injectReloadHandoff` | Reload-flavoured wrapper that injects a handoff into the respawned CLI after boot | none | _injectAfterBoot | handoff-spill.test.js handoff-snapshot.test.js reload-env.test.js session-manager.test.js |
| `_injectAfterBoot` | Waits for the fresh CLI's transcript symlink plus a settle delay, then injects turn-one text; false if the seat died or never booted | `s._dead`, run/<name>/transcript link | _handoffText, _injectText, _broadcast | session-manager.test.js |
| `_resumeSnapshot` | Builds the capped "State at resume" block (host, trunk HEAD, team role, live seats, open board) | none | gitWorktree.headLogSync, _teamLiveSeats, _taskListText, capResumeSnapshot | unpinned |
| `_handoffText` | Returns a claude seat's oversized handoff as an @spill pointer (body plus resume snapshot), else the body unchanged | spill dir, `s.filedRing` | _resumeSnapshot, writeSpill, _noteFiled | handoff-snapshot.test.js file-view-api.test.js session-manager.test.js |
| `_noteFiled` | Records a filed entry in the live seat's ring and pings the remote server | `s.filedRing` | remote-server.notifyFiled | unpinned |

### Invariants

- `_injectAfterBoot` gates on the transcript symlink via readlink and never on session.sessionId, because sessionId appears only after the first user turn and gating on it deadlocks turn-one injection.
- `_injectAfterBoot` bails and broadcasts the drop rather than inject blind when the seat dies or the link never appears within the timeout.
- `_maybeFireCompactLatch` clears the pending latch before calling `_executeCompact`, so a compact fires at most once per latch.
- `_executeCompact` injects a typed compact with bypassHold, since the compact itself must pass the hold it creates.
- `_handoffText` spills only for claude seats above SPILL_MIN_BYTES and falls back to typing the body if the spill write fails.

### Hazards

- `_maybeFireCompactLatch` swallows every error into the shadow log, so a failed fire leaves no operator-visible trace.
- `_seedFiledRing` seeds every spill-dir file as kind intent while `_handoffText` files the same spills live as kind handoff, so a handoff changes kind in the ring across a restart.
- `_resumeSnapshot` degrades each git and team probe to null silently, so an unpinned snapshot can omit trunk or board without any log line.

## DM delivery, confirm latch and federation — _gatedDeliver … _deliverReminder

| symbol | purpose | state | calls | pins |
|---|---|---|---|---|
| `_gatedDeliver` | Cost/dialog-gated dm entry point returning held, parked or queued, with onWrite fired only when the text is durable | `target.activityState`, `target.activityTs`, pending/<name>/ | dm-gate.shouldHoldDm, _parkHeldDelivery, _parkBehindQueue, _deliverMessage | dm-delivery-latch.test.js review-cost-durable.test.js accept-standing-seat.test.js session-manager.test.js |
| `_armDmConfirm` | Arms the swallowed-dm latch for an injected dm into an idle seat, pegged to the oldest outstanding unit | `s._dmUnconfirmed`, `s._dmConfirmTimer` | _seatTranscriptSize, _overflowDmEntry, _armDmConfirmTimer | dm-delivery-latch.test.js session-manager.test.js |
| `_checkDmConfirm` | Deadline check that reports ripe unconfirmed dms by broadcast and per-sender notice, unless transcript growth refutes the silence | `s._dmUnconfirmed`, `s._dmOverflow`, `s._dmUnconfirmedLast` | didGrow, _armDmConfirmTimer, _broadcast, _injectText | dm-delivery-latch.test.js |
| `_dmLatchEvidence` | Gives the stall sweep a count and oldest time over reported, live and cap-dropped unconfirmed dms, or null | `s._dmUnconfirmedLast`, `s._dmUnconfirmed`, `s._dmOverflow` | none | dm-delivery-latch.test.js session-manager.test.js |
| `_relayViaForOrigin` | Finds a hub whose unexpired relay roster advertises an origin, pruning stale rosters | `this._relayRosters` | none | relay-roster-intake.test.js |
| `_routeFederatedDm` | Routes a name@peer dm directly to an online peer, else via outbox for a known origin, else via a relay hub, else bounces | `this._knownDmOrigins`, outbox dir | _relayViaForOrigin, enqueueOutbox, buildRelayEnvelope, _injectText | relay-roster-intake.test.js session-manager.test.js |
| `_deliverClaimedDms` | Delivers dms claimed from a peer outbox to local seats with a from@origin tag, handing relay envelopes to the hub path | none | _relayClaimedDm, _gatedDeliver, _broadcast | peer-inbox-claim.test.js relay-roster-local.test.js session-manager.test.js |
| `_relayClaimedDm` | Hub side of a relay: checks version, hop budget and relayAllowed on both peers, then forwards a terminal dm whose sender is qualified with the name-shaped origin `_deliverClaimedDms` passes | peer settings | hopRule, _bounceRelaySender, buildTerminalDm | session-manager.test.js |
| `_isDmReachable` | Predicate for whether a reply to a sender could land now; drives the (no reply path) marker | `this._knownDmOrigins`, `this.sessions` | findPeerByOrigin, outboxKnowsOrigin, _relayViaForOrigin | operator-sender.test.js merged-notice-owes-accept.test.js session-manager.test.js |
| `_buildDeliveryText` | Builds the [agent:from] delivery line, spilling bodies over MSG_SPILL_THRESHOLD to an @pointer and marking unanswerable dms | messages dir, `s.filedRing` | _isDmReachable, spillToFile, _noteFiled | messaging-spill-receipt.test.js file-view-api.test.js ticket-replay.test.js session-manager.test.js |
| `_deliverMessage` | Universal delivery: stream enqueue, busy/draft park, or parkable inject, reporting injected or parked to onWrite | pending/<name>/, `target._injectPtyQueue` | _refuseStreamInject, _maybeParkDelivery, _injectText, _writeImageFiles | messaging-spill-receipt.test.js dm-delivery-latch.test.js injected-turn-bit.test.js session-manager.test.js |
| `_writeImageFiles` | Decodes base64 image attachments into the seat's messages dir and files them | `this._imgStamp`, messages dir | seatImageFileName, _noteFiled | unpinned |
| `_deliverReminder` | Fires a reminder to a live seat or parks it for an offline persisted seat; returns delivered, parked, gone or error | pending/<name>/, persistence | _deliverMessage, _buildDeliveryText, _bornFor | session-manager.test.js |

### Invariants

- `_gatedDeliver` fires onWrite for a park but never for a bare held verdict, because a hold reached nobody.
- `_gatedDeliver` returns queued rather than delivered, since only its negative verdicts are decided synchronously.
- `_armDmConfirm` is armed only from the dm arm of the intent handler, never inside `_gatedDeliver`, and only for an injected disposition into an idle seat.
- `_armDmConfirm` pegs the timer to the oldest unit and never restarts it on a later push, so a stream of dms cannot starve the report.
- `_checkDmConfirm` only withdraws on transcript growth past the newest ripe baseline and never content-matches, so it can subtract a report but never manufacture one.
- `_buildDeliveryText` puts the tag only on the spill pointer line and ends a claude @path with a space so the deferred Enter cannot select a different autocomplete file.
- `_armDmConfirm` only detects and reports; it never retries, dedupes, orders or confirms a unit, because a duplicate dm can be expensive and concurrent writes destroy each other's unsubmitted draft.
- `_deliverMessage` callers stamp delivery from onWrite rather than the return value, and arm consumption watchers only on an injected disposition.

### Hazards

- `_checkDmConfirm` sends per-sender notices through an unguarded `_injectText` loop after the ripe units are already consumed, so one throw silences every later sender.
- `_gatedDeliver` parks the raw body on the parkBehindQueue branch without consulting rebody, unlike its hold branch.
- `_deliverMessage` honours rebody on the inject path only when onWrite is also passed, and never on a stream seat.
- `_isDmReachable` splits at the last @ while `_routeFederatedDm` splits at the first, so a two-@ relay sender reads reachable but its reply bounces.
- `_deliverReminder` checks agentType but not _dead, so a dead seat still in the map drops the reminder while reporting delivered.

## Parking and the inject queue — _nextParkSeq … _armParkedDrainFallback

| symbol | purpose | state | calls | pins |
|---|---|---|---|---|
| `_mintParkId` | Mints a 5-char base36 resend id unused in the pending store, widening to 10 chars after 50 collisions | pending/ | pending-store.parkIdInUse | unpinned |
| `_parkHeldDelivery` | Parks a cost- or dialog-held dm with a resend id for the target's next turn, without arming the park cap | pending/<name>/ | _mintParkId, parkDelivery, _bornFor | session-manager.test.js ticket-replay.test.js |
| `_parkBehindQueue` | Parks a dm instead of queueing it when the claude seat's PTY queue is busy or its last unit's turn has not started | pending/<name>/, `target._injectPtyQueue` | _turnStartPending, parkDelivery, _armParkCap | unpinned |
| `_maybeParkDelivery` | Parks a delivery for a claude seat being typed into or busy so the PostToolUse hook drains it mid-loop; false means inject | pending/<name>/, `target.lastUserInputTs`, `target.activityState` | parkDelivery, _armParkCap | dm-delivery-latch.test.js parked-drain-fallback.test.js speaking-defers-inject.test.js session-manager.test.js |
| `_flushParkedNow` | Forces all parked mail through the inject queue as one joined write, claiming the files late inside the producer | `target._rebootNoticeFlushTimer`, pending/<name>/ | countPending, drainPending, _injectText, _broadcast | dm-delivery-latch.test.js session-manager.test.js |
| `flushPending` | Operator flush of a seat's parked mail, refused while an inject hold is active; resets the badge count | `target._parkCapTimer`, `this._lastPendingCounts` | _injectHoldReason, _flushParkedNow | api-contract.test.js ticket-replay.test.js session-manager.test.js |
| `_injectText` | Single PTY write path: stream enqueue, hold as an entry, or enqueue with an optional fire-time park divert and producer | `s._injectQueue`, `s._injectPtyQueue` | _streamEnqueueSystem, _injectHoldReason, _parkDivertFor, _injectQueueFor | dictated-draft-protection.test.js injected-turn-bit.test.js parked-drain-fallback.test.js session-manager.test.js |
| `_turnStartPending` | Predicate: an injected submit into this claude seat has not started its turn within TURN_START_WINDOW_MS | `s._awaitingTurnSince` | none | unpinned |
| `_parkDivertFor` | Builds the write-time divert that parks the text when a turn start is pending or a typed or dictated draft is open | pending/<name>/ | _turnStartPending, _anyDraftOpen, parkDelivery, _armParkCap | dictated-draft-protection.test.js dm-delivery-latch.test.js |
| `_injectQueueFor` | Lazily builds the seat's InjectQueue with quiet, speaking, boot-ready and dead gates and the re-park of undelivered text | `s._injectPtyQueue`, `s._bootReadySeen`, `s._awaitingTurnSince` | inject-queue.InjectQueue, parkDelivery, _armBootNudge | injected-turn-bit.test.js speaking-defers-inject.test.js dictated-draft-protection.test.js session-manager.test.js |
| `_onIncoming` | Socket dispatcher: passive delivery, box-wide voice and team-retire requests, else a normal delivery | none | _deliverPassive, voiceTap, _handleTeamRetire, _deliverMessage | external-tap-trigger.test.js session-manager.test.js |
| `_deliverPassive` | Parks a never-turn-earning passive entry for a claude seat, falling back to normal delivery | pending/<name>/ | _buildDeliveryText, parkDelivery, _deliverMessage | dm-delivery-latch.test.js session-move.test.js session-manager.test.js |
| `_deliverParkedActive` | Parks a turn-earning entry for a booting claude seat so the boot-ready edge drains it, arming the fallback timer | pending/<name>/ | parkDelivery, _armParkedDrainFallback, _deliverMessage | parked-drain-fallback.test.js review-scope-in-prompt.test.js session-manager.test.js |
| `_armParkedDrainFallback` | Second drain edge for an active park whose boot-ready drain never fired, re-checking until the file is claimed | `s._parkedDrainFallbackTimer`, `s._parkedDrainFallbackFiles`, `s._bootDrainTimer` | _drainPendingAtBootReady | parked-drain-fallback.test.js |

### Invariants

- `_parkHeldDelivery` never arms the park cap, because the cap would inject into the cold or dialog-blocked target the hold protects.
- `_injectText` keeps a producer as a callback on every branch, so parked files are claimed only when the write is imminent and a death mid-hold loses nothing.
- `_injectText` diverts to a park only when the caller opts in with parkable, so self-intents that drive the CLI are never parked.
- `_flushParkedNow` drains everything as one joined injection with the hook's blank-line separator, never N sequential writes.
- `_injectQueueFor` treats absent voice evidence as not speaking, so an unreadable screen delivers rather than wedging the seat.
- `_armParkedDrainFallback` either delivers or leaves a timer armed on every pass, and defers to an armed boot drain timer instead of shortening BOOT_DRAIN_SETTLE_MS.
- `_armParkedDrainFallback` scopes each pass to the file it was armed for, because hasActivePending is name-scoped and would force unrelated mail past the hold check in `_injectText`.

### Hazards

- `_deliverPassive` and `_deliverParkedActive` exclude dead and non-claude seats but not stream seats, so a claude stream seat gets a pending-store park instead of a stream enqueue.
- `_armParkedDrainFallback` falls through to a forced drain once its deadline passes even while the boot-ready latch is still missing.
- `_maybeParkDelivery` and `_parkDivertFor` arm `_armParkCap`, which forces the park through `_flushParkedNow` after INJECT_QUIET_MAXWAIT with no submit, so a draft left open that long is spliced subject only to the queue's own gates.

## EXEMPT
