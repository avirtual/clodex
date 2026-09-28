# team-tickets.js

## Sandbox clauses, template env and close-line wording — seedClaudeToken … ticketTaskDirLine

| symbol | purpose | state | calls | pins |
|---|---|---|---|---|
| `seedClaudeToken` | gives a box with no Claude auth token one borrowed from shared, then sandbox, then any other box, as a present/seeded/failed/none result | target box auth token (via setAuthToken) | claudeSeedClause | unpinned |
| `filterTemplateEnv` | the one allowlist filter for every agent-initiated template env, returning sessionEnv (or null) plus separate dropped and badType lists | none (reads REVIEWER_ENV_ALLOWLIST) | none | team-role-account.test.js reviewer-read-token-cap.test.js |
| `ticketCloseVerb` | renders the ready-to-fire task done intent that dispatches, hold notices and the close line embed after a prose prefix | none | none | hold-recovery-single-source.test.js |
| `holdRecoveryText` | the one renderer of who clears a held ticket and with which verb, picked by the verifyHold class (hand, spec or infra) | none | HOLD_RECOVERY.hand, HOLD_RECOVERY.spec, HOLD_RECOVERY.infra | hold-recovery-single-source.test.js ticket-loop-verify.test.js |
| `ticketCloseLine` | the CLOSE WITH dispatch line telling a hand only the task done intent closes a ticket, a dm does not | none | ticketCloseVerb | tickets-viewer-path-parity.test.js hold-recovery-single-source.test.js |
| `ticketTaskDirLine` | the TASK DIR dispatch line for the seat that writes the artifact: fact clause plus the so-create-it imperative | none | taskDirRuleClause, taskDirRelative | tickets-viewer-path-parity.test.js review-verdict-ticket.test.js |

### Invariants
- `filterTemplateEnv` returns null rather than an empty map when nothing survives, because create() treats an empty map as a real empty env.
- `ticketCloseVerb` output is inert only because prose precedes it on its line, and `ticketCloseLine` keeps that prefix.
- `holdRecoveryText` is the single renderer every reader of a held ticket uses, so the escalation body, stall alarm, done bounce and respec route agree.
- `taskDirRuleClause` carries facts only, because the reviewer scope embeds it and that seat is read-only; the imperative lives in `ticketTaskDirLine`.

### Hazards
- Reflowing text so the verb from `ticketCloseVerb` starts a line makes the anchored intent scanner fire task done and a seat closes its own ticket on receipt.
- Merging the dropped and badType buckets of `filterTemplateEnv` sends an operator to seek approval for a key they already have.
- Copying the prose of `ticketTaskDirLine` or `ticketCloseLine` into a fixture drifts silently, since suites pin delivered bodies byte-for-byte.
- An unknown class passed to `holdRecoveryText` falls back to the hand advice, which tells a seat to re-commit against a failure its branch did not cause.

## Module helpers: reviewer model, ages, seat predicates — reviewerModelArgs … ignoreCwdDir

| symbol | purpose | state | calls | pins |
|---|---|---|---|---|
| `reviewerModelArgs` | the only argv a reviewer template may contribute: a rebuilt model flag and name from the first model token, plus a refused spec | none | cli-adapters.adapterFor | team-hand-template-portable.test.js |
| `standingSeat` | true for a persistence record that is neither minted for a ticket nor a reviewer (an absent record counts as standing) | none | mintedForTicket | team-cost-wiring.test.js |
| `seatCwdInTree` | maps a seat cwd under the project root onto the same spot in a ticket worktree, or the tree root when it escapes | none | none | resolve-seat-shape.test.js |
| `ignoreCwdDir` | writes a star .gitignore into a per-seat cwd dir in the hand's worktree so it stays out of git status, only where none exists; an existing different one is left and a note returned; returns a warning, a note or null | seat cwd dir .gitignore on disk | none | worktree-codex-exclude.test.js |

### Invariants
- `reviewerModelArgs` rebuilds the model argv from the parsed name and never passes template tokens through, so no neighbouring flag can ride along.
- `reviewerModelArgs` lets the first model token decide, valid or not, and refuses a value starting with a dash.
- `seatCwdInTree` returns the tree root for a cwd outside the project root, so a seat never lands outside its tree.

### Hazards
- Dropping the refused result from `reviewerModelArgs` silently spawns a reviewer on the default model the operator did not configure.

## Spawn intent and team activity — createTicketMethods … _forgetTeam

| symbol | purpose | state | calls | pins |
|---|---|---|---|---|
| `createTicketMethods` | factory taking deps and shared that returns every ticket, team and merge verb, grafted onto SessionManager.prototype | none in closure; borrows shared.ticketsStore, nameConflict, SPEC_CONFIRM_MS | accountStore, allTemplates | ticket-mixin-surface.test.js tickets-viewer-path-parity.test.js |
| `_handleSpawnIntent` | the agent spawn intent: resolves a template, expands TEAM_ROOT, optionally cuts a worktree, mints the seat with privileged intents stripped | this.sessions, sessions.json (setWorktree), git worktree | _validateSeatName, _templateShape, filterTemplateEnv, _applyTemplatePersistence | spawn-template-env.test.js spawn-template-team-root.test.js spawn-template-plugin.test.js |
| `teamActivity` | read-only snapshot of one team: per-role seats and tickets, reviewer live and last, open and landed rows, 24h counts | none (reads manifest, tickets.json, this.sessions) | ticketsStore.load, matchSeatRole | ticket-loop-verify.test.js accept-standing-seat.test.js reviewer-round-end.test.js |
| `_forgetTeam` | drops every ticket-watch entry whose root matches a deleted team and returns the count | this._ticketWatch | none | teams-menu.test.js ipc-handlers-team.test.js |

### Invariants
- `createTicketMethods` keeps ticket state on the manager instance, never in a factory closure, because a closure leaks across managers in one process.
- `_handleSpawnIntent` creates the worktree before create() so the seat boots in it, and records it with setWorktree only after create() mints the record.
- `_handleSpawnIntent` strips privileged intents on this agent-initiated mint and nulls the proxy base rather than honouring a template-chosen one.

### Hazards
- A core method deleted from the manager that a body of `createTicketMethods` calls through this is a runtime TypeError only the mixin-surface test catches.
- Moving the worktree binding in `_handleSpawnIntent` inside the try makes it invisible to the catch that removes a worktree after a failed spawn.
- Both `_handleSpawnIntent` and `_handleTeamReview` call create() with a long positional argument list, so a signature change must update both in the same order.

## team-review verdict — _handleTeamReview … _writeVerdictBody

| symbol | purpose | state | calls | pins |
|---|---|---|---|---|
| `_handleTeamReview` | the lead-only team-review intent for ad-hoc and loop reviews: shapes, refuses unsafe shapes, reserves a scoped name, spawns the reviewer | sessions.json reviewer stub (upsert), this.sessions, review-start watch | resolveSeatShape, _armReviewStartCheck, _deliverParkedActive, _applyTemplatePersistence | reviewer-ticket-name.test.js resolve-seat-shape.test.js |
| `_landVerdictOnTicket` | parses a line-anchored ACCEPT or REWORK verdict and saves it onto the in-flight ticket, or returns null so it falls through to the lead | tickets.json (verdict, mustFix, reviewRound, rounds, loopStep cleared) | ticketInFlight, extractMustFix, recordEvent, _reconcileTickets | review-verdict-ticket.test.js reviewer-round-end.test.js |
| `_writeVerdictBody` | writes the full verdict prose beside the reviewed diff in the task dir and stamps the round's verdictFile, returning ok and path | task dir verdict file, tickets.json rounds | _ticketDiffDest, _stampRoundFile | review-verdict-ticket.test.js |

### Invariants
- `_handleTeamReview` refuses a busy verify ticket only when no ticket id was passed, since the loop's own reviewer spawn arrives for a ticket in verify.
- `_handleTeamReview` makes every refusal before the synchronous persistence upsert, because that upsert is the name reservation.
- `_landVerdictOnTicket` counts the round on the ticket, not the reviewer name index, and deletes loopStep in the same save that makes the verdict durable.
- `_landVerdictOnTicket` excludes quoted lines from the verdict match, because the previous round's verdict arrives quoted in the new body.

### Hazards
- Letting the onReply diversion in `_handleTeamReview` suppress a reply loses the template and tool-cap refusals the loop turns into escalations.
- Deriving the round in `_handleTeamReview` from the mint index instead of the ticket bills a later round's spend to an earlier round's label.
- Un-anchoring the verdict regex in `_landVerdictOnTicket` lands the old round's quoted ACCEPT on a ticket the reviewer just sent back.

## Seat ledger and cost stamps — _seatLedger … _stampSeatCost

| symbol | purpose | state | calls | pins |
|---|---|---|---|---|
| `_seatLedger` | a seat's lifetime spend from persisted wire-totals rows plus a gated live overlay for its current session id | none (reads wire-totals.json, this._wireTelemetry) | teamCost.sumSessions | team-cost-wiring.test.js review-cost-durable.test.js |
| `_stampSeatCost` | at a seat boundary, appends a standing seat's spend since its last stamp to the team ledger and advances its cursor | team ledger file, cost-cursor.json | _seatLedger, _readSeatCursors, _appendTeamLedger, _writeSeatCursor | team-cost-wiring.test.js |

### Invariants
- `_seatLedger` applies the live overlay only when the wire's session id matches the record and the cost is a finite number.
- `_stampSeatCost` must run before the seat's persistence record is removed, because no record means no stamp.
- `_readSeatCursors` returns null on an unreadable cursor file, and `_stampSeatCost` then drops the stamp rather than re-billing every seat.

### Hazards
- Dropping the session-id gate in `_seatLedger` bills a dead round's ledger to a live seat that reuses the counter name.
- `_stampSeatCost` appends the ledger row before `_writeSeatCursor`, so a failed cursor write means the next stamp re-counts that delta.

## Verdict routing — _writeReviewCost … _notifyLeadOfVerdict

| symbol | purpose | state | calls | pins |
|---|---|---|---|---|
| `_writeReviewCost` | prices one review round and appends it to the ticket's review-cost artifact and the team ledger before the reviewer is torn down | task dir review-cost file, team ledger file | _seatLedger, _ticketDiffDest, _appendTeamLedger | review-cost-durable.test.js team-cost-wiring.test.js |
| `_dispatchReworkFromVerdict` | turns a REWORK verdict into a rework hand-off carrying the must-fix list and saved verdict path, returning ok false instead of throwing | tickets.json (via the reject) | _rejectTicketFromLoop | unpinned |
| `_notifyLeadOfVerdict` | tells the lead a verdict landed as a short summary plus the saved verdict path, after the verdict is durable | task dir verdict file, lead inbox | _writeVerdictBody, _verdictBriefLines, _gatedDeliver | merged-notice-owes-accept.test.js ticket-marker-surface.test.js |

### Invariants
- `_writeReviewCost` takes the seat record as an argument captured before the reap and never re-resolves it by name.
- `_writeReviewCost` returns on every failure arm, so pricing a review can never cost the verdict or strand the seat.
- `_notifyLeadOfVerdict` runs after `_landVerdictOnTicket` has saved, and is fully wrapped so a throw cannot unwind a durable verdict.

### Hazards
- Giving an ACCEPT a step line in `_notifyLeadOfVerdict` invites an accept that destroys the worktree the auto-merge is about to read.
- Hoisting `_notifyLeadOfVerdict` above the verdict save lets a notify throw lose the verdict.
- Re-resolving the record by name inside `_writeReviewCost` looks like a tidy-up and captures nothing once kill() has removed it.

## Auto-merge — _queueAutoMerge … _notifyMergeLanded

| symbol | purpose | state | calls | pins |
|---|---|---|---|---|
| `_queueAutoMerge` | serializes every ACCEPT auto-merge process-wide on one promise chain, counting and listing what is held | this._mergeChain, this._mergePending, this._mergeHeld | _autoMergeTicket | ticket-auto-merge.test.js |
| `inFlightRestartHolds` | the work that should hold a restart: in-flight exec runs followed by the running and queued merges | reads this._mergeHeld | inFlightExecRuns, inFlightMerges | headless-reboot.test.js ticket-auto-merge.test.js |
| `_requeueWaitingMerges` | boot recovery: finds done ACCEPT tickets stamped waiting behind a suite, waits for their leads, and requeues each | tickets.json (all teams) | _awaitBootLeads, _requeueOneWaiting, _queueAutoMerge | ticket-auto-merge.test.js |
| `_suiteLockHolder` | the live pid holding the root checkout's suite lock, or null when absent or dead | reads .test-digest.lock pid file | isAlive | ticket-auto-merge.test.js |
| `_stampMergeError` | re-load, mutate and save of the board's mergeError: a step sets it with a merge-failed event, null clears it | tickets.json (mergeError, escalationUndelivered) | recordEvent | ticket-auto-merge.test.js task-respec.test.js |
| `_stampMergeWaiting` | re-load, mutate and save of a deferred merge's mergeWaiting reason, kept apart from mergeError | tickets.json (mergeWaiting) | none | task-respec.test.js |
| `_autoMergeTicket` | gates an ACCEPTed branch, merges it with --no-ff, runs the suite on the merged trunk, then reverts and stamps MERGE FAILED or closes out | tickets.json, merge message file, git commits in the team root, retry timer | _runTicketSuite, _closeOutMergedTicket, _mergeTouchedChangelog, _notifyMergeLanded | ticket-auto-merge.test.js clodex-team.test.js |
| `_mergeTouchedChangelog` | measures whether the merged range touched the root CHANGELOG.md (a header naming it on either side, so a move out of the root reads as touched) and whether it exists, known false for anything unproven | none (reads diff text, stats CHANGELOG.md) | gitWorktree.diffText | ticket-auto-merge.test.js |
| `_notifyMergeLanded` | one lead DM for a landed merge: sha, tip drift, close-out or step owed, suite, union and CHANGELOG state; stamps merged | tickets.json (merged stamp), lead inbox | _stampMerged, _gatedDeliver, closeOutDetail | merged-notice-owes-accept.test.js ticket-auto-merge.test.js |

### Invariants
- `_queueAutoMerge` runs one merge at a time process-wide, with the catch inside each link so one rejected merge cannot break the chain.
- `_autoMergeTicket` leaves mergeWaiting set only on the defer arm, clearing it for every other exit in its finally.
- `_autoMergeTicket`'s `fail` re-reads the ticket before any merge ran and logs ABANDONED instead of stamping when it is gone, reopened, rejected or closed out.
- `_autoMergeTicket` retries only the suite-in-flight arm, scheduling the retry through `_scheduleMergeRetry` and re-entering via `_queueAutoMerge`.
- `_suiteLockHolder` keeps the liveness probe outside the read's catch, so a probe fault reaches the catch-all rather than reading as no suite running.

### Hazards
- Adding an await in `_autoMergeTicket` between the last state re-read and the merge reopens the window where a task reject lands and the merge still goes on the trunk.
- Letting the evidence dump in `_autoMergeTicket` throw before the revert reaches the catch-all, which escalates without reverting a red trunk.
- A reflow or multi-line interpolation in `_notifyMergeLanded` that puts the task accept verb at column 1 makes the lead auto-accept and destroy the worktree.
- Turning a known-false path of `_mergeTouchedChangelog` into a claim either ships a release without notes or trains the lead to skip the line.

## review-done intent — _handleReviewDone … _handleReviewDone

| symbol | purpose | state | calls | pins |
|---|---|---|---|---|
| `_handleReviewDone` | Closes out a review-done verdict: lands it on the ticket (else to the lead), books spend, retires the seat, kicks merge or rework | ticket record, verdict body file, review cost row, reviewer persistence record (dropped by kill) | _landVerdictOnTicket, _queueAutoMerge, _dispatchReworkFromVerdict, _notifyLeadOfVerdict | review-verdict-ticket.test.js review-cost-durable.test.js ticket-auto-merge.test.js |
| `_handleReviewDone.bookReview` | Books the review's cost row once, called right before each kill because both teardowns destroy the record joining spend to ticket | closure booked latch, review cost ledger | _writeReviewCost, _loadTicket | review-verdict-ticket.test.js |

### Invariants
- A ticket review's verdict lands on the ticket record through `_landVerdictOnTicket`, falling through to lead delivery only when the ticket cannot be resolved or the verdict does not parse.
- `bookReview` is bound to each kill rather than run once up front, which is the fix for a double-booked re-fired review.
- On ACCEPT, `_handleReviewDone` queues the merge through `_queueAutoMerge` unawaited and only after the verdict is durable and the reviewer is retired.

### Hazards
- In `_handleReviewDone` the broadcast and context-action sends between the landed verdict and `kill` are unwrapped, so a throw there strands a live reviewer on a decided ticket.
- Calling `bookReview` in the undelivered-verdict arm of `_handleReviewDone` (where the seat stays live) books a row that a re-fire books again.
- Widening the return of `_landVerdictOnTicket` to carry the team is warned against; `_handleReviewDone` re-resolves the team from the reviewer's cwd instead.

## Team verbs: create, team, trunk, sandbox, role templates — _classifyTeamRoot … _hostIsThisTeamsCode

| symbol | purpose | state | calls | pins |
|---|---|---|---|---|
| `_classifyTeamRoot` | Classifies a would-be team root as new-absent, new-empty or takeover, or refuses it (parent-missing, is-file, files-no-repo, no-commits) | none (stats and reads the root) | gitWorktree.repoToplevel, gitWorktree.hasCommit | team-create-root.test.js team-kits.test.js |
| `_handleTeamCreate` | Validates, dry-runs createTeam, creates and git-inits a NEW root (a takeover root is untouched), writes team and brief, spawns the lead | root dir and its git repo, team dir files, team-project append prompt, new lead seat | _classifyTeamRoot, createTeam, teamPromptSave, _handleSpawnIntent | team-manifest.test.js team-hand-template-portable.test.js session-manager.test.js |
| `_handleTeam` | Lead-only dispatcher for team verbs: role add/set/rm/rename, gather, set-lead, watchdog, template and prompt save or rm, trunk, sandbox | team.json, team templates and prompts dirs, app menu | _deriveRoleModelTemplate, _deriveRoleEffortTemplate, _handleTeamTrunk, _handleTeamSandbox | team-file-intents.test.js team-role-kvs.test.js team-gather.test.js |
| `_handleTeamTrunk` | Reports the team's trunk (explicit or repo default) or sets it after checking the branch exists locally | team.json trunk | gitWorktree.mergeTargetFor, gitWorktree.localBranches, setTeamTrunk | ticket-auto-merge.test.js |
| `_shipTeamIntoBox` | Copies the team's prompts, templates and exec into the box state dir, then a translated team.json last (an existing box manifest is kept) | box state dir teams copy | ensureDirMode700, atomicWriteFileSync | team-sandbox-verb.test.js |
| `_handleTeamSandbox` | Lead verb sandbox up, rebuild, down or status for the team's dedicated box; reports or removes a stale record when there is no box | sandbox manager registry, box container, sandbox.json (unlinked on down) | _teamSandboxFile, _bringUpTeamBox | unpinned |
| `_bringUpTeamBox` | Brings a team box up or rebuilds it: config, token seed, ship the team, write sandbox.json, wait healthy, seed a bash seat and the lead | box config and container, sandbox.json with tokens, in-box sessions | _shipTeamIntoBox, _teamSandboxFile, seedClaudeToken, seedSandboxSessions | team-sandbox-verb.test.js teams-menu.test.js |
| `_deriveRoleModelTemplate` | For a role add or set with model, saves a team template named after the role with the model pinned, returning an undo restoring prior bytes | team templates dir file | _rolesNaming, teamTemplateSave, deriveModelTemplate, _refreshAppMenuQuietly | unpinned |
| `_deriveRoleEffortTemplate` | Effort-only role edit (reviewer carve-out): saves a role-named team template with the effort, returning undo, reply clause and reserved flag | team templates dir file | _rolesNaming, teamTemplateSave, deriveEffortTemplate, _refreshAppMenuQuietly | unpinned |
| `_staleHostSuffix` | Builds the stale-host NOTE suffix for task replies, returning empty on any throw | reads run dir under REGISTRY_DIR | hostNotice | session-manager.test.js |
| `_hostIsThisTeamsCode` | True only when the team root realpaths to this module's own directory, i.e. the team edits the running host's source | none | none | session-manager.test.js |

### Invariants
- `_handleTeamCreate` runs every refusal, including a createTeam dry run, before it creates or git-inits the root, because neither later failure arm undoes the root.
- `_deriveRoleModelTemplate` and `_deriveRoleEffortTemplate` refuse a role-named stem that `_rolesNaming` shows other roles already point at, so an edit never re-models a shared template.
- `_shipTeamIntoBox` writes the team manifest last and atomically, because its presence means already shipped.
- `_staleHostSuffix` swallows every throw because instrumentation must never break the reply it rides on.

### Hazards
- In `_handleTeam` the trunk and sandbox verbs are async and escape the outer try, so each must keep its own catch into reply around `_handleTeamTrunk` and `_handleTeamSandbox`.
- In `_handleTeam` the derivations write the template before the role mutator runs, so every later failure path must run the composed undo from `_deriveRoleEffortTemplate` then `_deriveRoleModelTemplate`.
- `_bringUpTeamBox` writes remote and web tokens into the sandbox.json named by `_teamSandboxFile`, so that file must stay in a 0700 dir and be written atomically.
- `_shipTeamIntoBox` reads the team dir from the team object while `_teamSandboxFile` derives it from teamsDir plus name, and the two derivations must not diverge.

## task intent and assignee resolution — _handleTask … _repinTicketToSeat

| symbol | purpose | state | calls | pins |
|---|---|---|---|---|
| `_handleTask` | Entry point for task intents: resolves team or solo context, adds the stale-host suffix, dispatches the sub-verb with a parkable reply | none directly (verbs mutate the board) | _soloContext, _staleHostSuffix, _taskAccept, _taskAdd | task-start.test.js solo-tickets.test.js session-manager.test.js |
| `_resolveAssignee` | Returns who if it is a team role key or a live seat name on the team root, else null | none | _teamLiveSeatNames | task-start.test.js task-respec.test.js accept-standing-seat.test.js |
| `_ticketAssigneeSeat` | The one ticket-to-seat resolver: role to first live seat, live pin to itself, else mint-pending or role degradation off-worktree | reads live seats and persistence | _seatMintPending, matchSeatRole | stores.test.js team-cost-wiring.test.js task-start.test.js |
| `_repinTicketToSeat` | Re-pins a role-assigned or dead-pinned ticket in memory to the seat delivery will reach; never pins the lead; caller saves | ticket role and assignee (in memory) | _ticketAssigneeSeat | ticket-replay.test.js task-start.test.js tickets-viewer-plugin.test.js |

### Invariants
- `_handleTask` treats no team as the solo case and refuses only outside a git repo, deliberately without a cwd fallback because a wrong board is silent forever.
- `_ticketAssigneeSeat` gates degradation on a ticket having no worktree, so a worktree ticket is never handed to a sibling in another branch's checkout.
- `_repinTicketToSeat` resolves through `_ticketAssigneeSeat`, the same resolver delivery uses, so the pin can never name a seat other than the one the spec reached.

### Hazards
- Dropping the catch on the accept arm of `_handleTask` leaves `_taskAccept` rejections floating and the lead waiting on a confirmation that never comes; its reply names the error only, since a throw after the teardown has already removed things.
- Letting `_repinTicketToSeat` pin to the lead reads downstream as an exact seat pin and bills one ticket for the lead's whole ledger via `_costSeatFor`.
- A second copy of the role-or-name match outside `_ticketAssigneeSeat` lets pin, delivery and queue disagree invisibly.

## Spec delivery, displacement and owed specs — _deliverTicketSpec … _drainOwedSpec

| symbol | purpose | state | calls | pins |
|---|---|---|---|---|
| `_deliverTicketSpec` | Renders and sends a ticket dispatch (fresh, REPLAY or RESPEC head plus context) to the resolved seat and arms the spec latch | seat latch via hook, spill file under messages dir | _ticketAssigneeSeat, _gatedDeliver, _armSpecConfirm, _ticketTaskDirRender | tickets-viewer-path-parity.test.js ticket-replay.test.js task-start.test.js |
| `_armSpecConfirm` | At write time arms, keeps or drops the per-seat spec latch, carrying the retry budget and owing redelivery for a displaced ticket | session spec latch (byte anchor and the resolved transcript file) and confirm timer, owed-spent set | _oweDisplacedSpec, _pruneOwedSpent, _seatTranscriptSize, _armSpecConfirmTimer | ticket-replay.test.js |
| `_redirectDeliveryText` | One builder for a seat-bound rejection or must-fix redirect, optionally with a REDELIVERY head | none | ticketCloseLine | unpinned |
| `_armSpecConfirmTimer` | Arms the unref'd confirm-window timer that runs the spec check inside a logging try | session confirm timer | _checkSpecConfirm | dm-delivery-latch.test.js ticket-replay.test.js |
| `_oweDisplacedSpec` | For a latch displaced by another ticket's write: escalates if its budget is spent, else queues one owed redelivery and arms the drain | session owed queue | _escalateTicket, _armSpecOwedTimer, _soloOpenerTeam | ticket-replay.test.js |
| `_pruneOwedSpent` | Releases one ticket-and-kind key from the owed-spent budget set | session owed-spent set | none | unpinned |
| `_drainOwedSpec` | Redelivers one owed spec or redirect per timer pass, or drops or escalates it when redelivery is moot | session owed queue, owed-spent set, in-flight flag; tickets.json via escalation | _deliverTicketSpec, _deliverRedirectReplay, _seatTranscriptHas, _escalateTicket | ticket-replay.test.js |

### Invariants
- `_deliverTicketSpec` arms the latch from the durable write, never from its queued return, and runs the arm before the caller's hook with a finally so neither can skip the other.
- `_armSpecConfirm` replaces rather than stacks latches, so at most one latch is ever live, and keeps the retry budget only for the same ticket and kind.
- `_pruneOwedSpent` is called only at the three release sites (attributed turn, deadline re-probe, park), never on escalation exits and never wholesale.
- `_drainOwedSpec` delivers exactly one redelivery per pass and never while a latch or in-flight redelivery owns the composer.

### Hazards
- Giving `_armSpecConfirm` a default disposition arms a latch over text never written, since the unsafe value is injected.
- Shifting the owed entry in `_drainOwedSpec` before the team resolves drops the ticket on a transient failure and hands it back to the stall watchdog.
- Clearing the in-flight flag in `_drainOwedSpec` only on an injected write latches the drain shut for the life of the seat.
- Dropping the try in `_armSpecConfirmTimer` or `_armSpecOwedTimer` turns a spill failure into an unhandled exception in the host process.

## Spec confirm, review-start check and replay — _armReviewStartCheck … _replayTicketsOnce

| symbol | purpose | state | calls | pins |
|---|---|---|---|---|
| `_armReviewStartCheck` | Arms a one-shot unref'd check that a freshly spawned reviewer took its first turn, anchoring arm time and transcript size on the first arm | session review-start armed-at, size and timer | _seatTranscriptSize, _checkReviewStarted | review-scope-in-prompt.test.js session-manager.test.js |
| `_checkReviewStarted` | At the reviewer start deadline re-arms on a dialog, re-sends the start nudge once, then escalates to the lead with the measured age | session nudge-retried flag | _seatTurnSince, _armReviewStartCheck, _deliverParkedActive | review-scope-in-prompt.test.js |
| `_seatTranscriptHas` | Three-valued probe for whether a ticket dispatch marker appears in the seat transcript after a byte offset, reading the anchored file from the offset and a repointed current file from 0 | reads seat transcript | _seatTranscriptTail | ticket-replay.test.js |
| `_checkSpecConfirm` | At the spec-confirm deadline re-arms, confirms from transcript, drops, escalates, or redelivers once then escalates after two silent writes | session spec latch; tickets.json via escalation | _seatTranscriptHas, _ticketAssigneeSeat, _deliverTicketSpec, _escalateTicket | ticket-replay.test.js solo-tickets.test.js |
| `_deliverRedirectReplay` | Re-sends a redirect from the latch snapshot as a REDELIVERY with the same return shape and arm-on-write hook as spec delivery | seat latch via hook | _redirectDeliveryText, _gatedDeliver, _armSpecConfirm | ticket-replay.test.js |
| `_openTicketsFor` | The single resolver of a seat's open, assigned, unparked, started tickets, FIFO by openedAt then numeric id | reads tickets.json | _ticketAssigneeSeat, ticketStarted | session-rename.test.js task-start.test.js session-manager.test.js |
| `_advanceSeat` | On a started ticket's close hands the seat its next open ticket, re-pinning and delivering it REPLAY-marked | tickets.json role and assignee of the next ticket | _openTicketsFor, _repinTicketToSeat, _deliverTicketSpec | ticket-reminder-binding.test.js rework-context-gate.test.js ticket-replay.test.js |
| `_stampSpecDelivered` | Write-time hook stamping deliveredTo seat and incarnation, optionally re-pinning, only if the ticket still resolves to that seat | tickets.json deliveredTo, role and assignee | _ticketAssigneeSeat, _repinTicketToSeat | session-manager.test.js |
| `_replayOpenTickets` | After a respawn redelivers the first open ticket whose record cannot show this incarnation got its spec; returns whether the pass finished | tickets.json via stamp hook | _openTicketsFor, _deliverTicketSpec, _stampSpecDelivered | ticket-replay.test.js task-start.test.js session-manager.test.js |
| `_replayTicketsOnce` | Runs the per-process ticket replay once whichever boot edge fires first, keeping the one-shot armed when the pass was held | session replay-pending flag | _replayOpenTickets | ticket-mixin-surface.test.js ticket-replay.test.js session-manager.test.js |

### Invariants
- `_armReviewStartCheck` stamps the arm time and transcript size on the first arm only, so the escalation's age is measured rather than a constant.
- `_seatTranscriptHas` matches the dispatch marker, never the bare id, and returns null only when the transcript cannot be read.
- `_stampSpecDelivered` rides the write, never the return, and loads the board itself rather than taking a caller snapshot.
- `_replayOpenTickets` redelivers one ticket per respawn and keys on the in-memory incarnation, not a persisted timestamp.

### Hazards
- Loosening the strict true test on `_seatTranscriptHas` in `_checkSpecConfirm` or `_drainOwedSpec` lets an unreadable transcript swallow a real redelivery.
- In `_checkSpecConfirm` a team-resolve failure returns with the latch still set and no timer re-armed, which also stalls `_drainOwedSpec` behind that latch.
- `_advanceSeat` delivers the next spec with no missing-spec guard and ignores the delivery result, unlike `_replayOpenTickets` which skips spec-less records.
- `_replayTicketsOnce` spends the one-shot on a throw despite its comment saying only an outcome that reached the seat spends it.

## Dispatch: seat shape, worktree minting, _spawnTicketSeat — _ticketDispatchMode … _spawnTicketSeat

| symbol | purpose | state | calls | pins |
|---|---|---|---|---|
| `_ticketDispatchMode` | the one resolver for what dispatching a role-addressed ticket does, standing or spawn or worktree, fail-closed to standing | none | none | session-manager.test.js |
| `_mintTicketSeat` | derives the one-shot seat name and branch (a recorded branch wins), refusing an illegal or taken name with the name attached | reads this.sessions and persistence | branchSlug, titleLine | ticket-loop-verify.test.js session-manager.test.js |
| `_ticketTaskDirRefusal` | refuses start or assign of a non-solo ticket with no task dir before any seat or tree is minted | none | none | tickets-viewer-path-parity.test.js |
| `_ticketTreeHolder` | live agent session whose persisted worktree path realpath-equals the tree, or null | reads this.sessions and persistence records | none | preserve-tree-handoff.test.js worktree-restart-preserve.test.js |
| `_existingTicketTree` | the ticket's recorded worktree when git still lists it, it is on disk, unlocked, unprunable and unheld, else null | reads git worktree list and the filesystem | gitWorktree.listWorktrees, _ticketTreeHolder | preserve-tree-handoff.test.js rework-context-gate.test.js |
| `_templateShape` | a template name resolved into the create() seat shape with env allowlisted and privileged intents stripped | reads team templates and the library | readTeamJson, filterTemplateEnv, withoutPrivilegedIntentsFor | resolve-seat-shape.test.js team-templates-exec.test.js |
| `_resolveRoleCwd` | the absolute boot dir for a role's cwd, falling back to the team root with a printed reason; never throws or creates | reads the filesystem | _roleCwdRel, resolveTeam | unpinned |
| `resolveSeatShape` | the ONE seat shape both team spawn paths hand create(), with the review purpose adding the reviewer cap and allowlists | reads persistence for the lead's extraArgs | _templateShape, _resolveRoleCwd, resolveAccount, reviewerModelArgs | resolve-seat-shape.test.js reviewer-read-token-cap.test.js |
| `_spawnTicketSeat` | the one-shot seat spawner behind start, assign and rework: acquire or reuse the tree, spawn, deliver the spec, roll back on failure | persistence seat stub and worktree, tickets.json worktree and pin, git worktree on disk | _existingTicketTree, resolveSeatShape, _deliverTicketSpec, _linkWorktreeNodeModules | preserve-tree-handoff.test.js ticket-loop-verify.test.js session-manager.test.js |
| `_spawnTicketSeat.claimTree` | writes this seat's worktree record and clears every other record naming the same tree by realpath | persistence worktree records | none | preserve-tree-handoff.test.js worktree-restart-preserve.test.js |

### Invariants
- `_ticketDispatchMode` resolves any unrecognized dispatch value, and the lead and reviewer roles, to standing, never to spawn.
- `_mintTicketSeat` returns a recorded branch over the derived one, because a branch is an identity minted once.
- `_spawnTicketSeat` reserves the persistence stub synchronously before any await, and on spawn mode skips tree acquisition entirely so no git call sits on the dispatch path.
- `claimTree` writes the seat's worktree and runs the one-tree-one-record realpath scan together, not gated on reuse.

### Hazards
- Falling back to the team root when createWorktree fails in `_spawnTicketSeat` has the hand commit onto the operator's checked-out branch.
- Dropping the realpath compare, the prunable filter or the holder check in `_existingTicketTree` silently mints duplicate trees or hands a seat a dead path.
- Letting an unknown purpose fall to the ticket arm of `resolveSeatShape` spawns a reviewer with no read-only cap.
- Moving the task-dir gate from `_ticketTaskDirRefusal` into the spec delivery funnel strands spec replay to respawned seats.

## Verbs: add, start, assign, done — _reviewerTemplateNames … _resumeOrphanedVerify

| symbol | purpose | state | calls | pins |
|---|---|---|---|---|
| `_reviewerTemplateNames` | names of library templates whose prompt is a reviewer prompt, or empty on any throw | none | allTemplates | resolve-seat-shape.test.js |
| `_taskAdd` | the task add verb: files a ticket, optionally parked or with a reviewer template, dispatching only via _taskStart | tickets.json new record and add event | _resolveAssignee, extractTaskDir, _taskStart | free-identifier-leaks.test.js tickets-viewer-plugin.test.js |
| `_taskStart` | the task start verb: one-shot dispatch of an assigned unstarted ticket, minting a seat or delivering to a live standing seat | tickets.json startedAt, assignee, role, parked | _ticketDispatchMode, _mintTicketSeat, _spawnTicketSeat, _deliverTicketSpec | task-respec.test.js tickets-viewer-path-parity.test.js session-manager.test.js |
| `_taskAssign` | the task assign verb: moves a ticket to a role or seat, re-sending, minting and spawning, or delivering to the answering seat | tickets.json assignee, role, startedAt, assign event | _ticketDispatchMode, _mintTicketSeat, _spawnTicketSeat, _gatedDeliver | task-respec.test.js tickets-viewer-path-parity.test.js session-manager.test.js |
| `_taskDone` | the task done verb: closes a ticket or re-enters a held verify, persists the report, advances the seat, fires the loop | tickets.json state, report, rounds, loopStep, verifyHold, runnerPid | _gatedDeliver, _advanceSeat, _reapRunner, _runTicketLoop | ticket-loop-verify.test.js ticket-reminder-binding.test.js |
| `_liveReviewerSeat` | the live agent reviewer seat for the ticket's next review round, or null | reads this.sessions | none | ticket-loop-verify.test.js |
| `_resumeOrphanedVerify` | after a host restart, re-fires the loop for done tickets at verify with no hold, no live reviewer and no loop this process | this._verifyLooped, tickets.json lastActivityAt and runnerPid | _liveReviewerSeat, _runTicketLoop | ticket-loop-verify.test.js |

### Invariants
- `_taskAdd` writes the ticket and dispatches nowhere but `_taskStart`, never by growing a second spawn path.
- `_taskStart` and `_taskAssign` run every refusal above the mint and above every write, so a refused verb changes nothing.
- `_taskDone` gates re-entry on the verify hold rather than on the verify step alone, so a running check never gets a second loop.
- `_taskDone` stamps the verify step and clears the hold in the same save that closes the ticket, not later in `_runTicketLoop`.

### Hazards
- Moving the general already-started refusal in `_taskStart` above the not-live and occupancy diagnoses makes them unreachable.
- Re-stamping startedAt on a re-send or un-pinning a live own seat in `_taskAssign` routes the WORK IN line to another ticket's hand.
- Letting a re-entry in `_taskDone` overwrite the first close or re-run `_advanceSeat` moves the recorded close or re-delivers the next spec.
- The reviewer name `_liveReviewerSeat` builds must match what `_spawnTicketReview` mints, or `_resumeOrphanedVerify` re-runs verify beside a live reviewer.

## Ticket loop and suite run — _runTicketLoop … _runTicketSuite

| symbol | purpose | state | calls | pins |
|---|---|---|---|---|
| `_runTicketLoop` | the verify step: commits, ancestry, task dir, diff, full suite with one re-measure, then reject, hold, or advance to review | this._verifyLooped, tickets.json verifyHold, loopStep, runnerPid, suite stamps | _runTicketSuite, _rejectTicketFromLoop, _spawnTicketReview, _escalateTicket | ticket-loop-verify.test.js ticket-auto-merge.test.js |
| `_runTicketLoop.fail` | the hold arm: stamps a verify hold for a verify step, escalates to the lead, and notices the hand for the hand class only | tickets.json verifyHold | _stampVerifyHold, _escalateTicket, _notifyHandOfHold, holdRecoveryText | ticket-loop-verify.test.js |
| `_linkWorktreeNodeModules` | symlinks the root's node_modules into a ticket tree, returning null on success or an error sentence | worktree node_modules symlink | none | ticket-loop-verify.test.js |
| `_runTicketSuite` | runs the branch's own suite in the tree under the root checkout's test lock and classifies never-ran, green, red, slow-only | child process group, root test lock dir | _linkWorktreeNodeModules, gitWorktree.currentBranch, _killRunner | ticket-loop-verify.test.js ticket-auto-merge.test.js |

### Invariants
- `_runTicketLoop` reaches the lead only through `_escalateTicket` and tears nothing down on any arm.
- `_runTicketLoop` clears the verify hold in its finally on every non-fail, non-superseded exit rather than at each arm.
- `_runTicketLoop` re-loads after each await and bails when the step left verify or the rework round moved, reaping its runner via `_reapRunner`.
- `_runTicketLoop` stamps the verify phase before each suite run and before the review step, and `fail`, a spawned or refused reviewer, a landed verdict and `_rejectTicketFromLoop` clear it.
- `_runTicketSuite` pins the lock to the root checkout while tests run in the tree, and reports could-not-run as ran false, which the loop escalates rather than rejects.

### Hazards
- Spawning the reviewer before the suite or rejecting on a suite that could not run in `_runTicketLoop` is the expensive mistake the order exists to prevent.
- Rethrowing a preservation failure from `_writeTicketSuiteFailure` inside `_runTicketLoop` turns a red suite into an escalation and eats the rejection.
- Swapping the isMerged arguments in `_runTicketLoop` asks the inverse ancestry question.
- Letting `_runTicketSuite` fall back to the root's runner or rename its dependency reader to deps shadows the factory seams or verifies the wrong runner.

## Loop rejection, holds, stamps and review spawn — _reworkSeatName … _spawnTicketReview

| symbol | purpose | state | calls | pins |
|---|---|---|---|---|
| `_reworkSeatName` | first free replacement seat name for a rework, or null when none is legal | reads this.sessions and persistence | none | rework-context-gate.test.js |
| `_reworkSeatFor` | replaces an ephemeral hand past the compact threshold with a fresh seat on the same tree, else returns the seat unchanged | caller ticket role, assignee, seatReplacements; old seat's persistence worktree | _reworkSeatName, _spawnTicketSeat, archive | unpinned |
| `_rejectTicketFromLoop` | the loop's own reject: reopens a done ticket to its seat, bumps the rework round, retires the reviewer, delivers the rework | tickets.json state, reworkRound, rework reasons, loopStep | _reworkSeatFor, _gatedDeliver, _retireReviewSeatsFor, _notifyLeadOfLoopRejection | ticket-loop-verify.test.js rework-context-gate.test.js ticket-rework-reasons.test.js |
| `_notifyLeadOfLoopRejection` | the lead's non-urgent summary of a delivered loop rejection, never the suite dump | none | _gatedDeliver | hold-recovery-single-source.test.js ticket-loop-verify.test.js |
| `_taskRejectFollowUp` | a lead reject on a ticket already open for rework, sent as a follow-up into the running round | tickets.json lastActivityAt, rework reasons, reject event | _reworkSeatFor, _gatedDeliver, _seatReplacedClause | ticket-rework-reasons.test.js reviewer-round-end.test.js |
| `_notifyHandOfHold` | best-effort urgent notice to the hand that its ticket is held at verify, with the hand recovery text | none | _ticketAssigneeSeat, holdRecoveryText, _gatedDeliver | hold-recovery-single-source.test.js ticket-loop-verify.test.js |
| `_stampVerifyHold` | re-load, set or clear the verify hold and its event, null being a no-op when absent | tickets.json verifyHold | recordEvent | hold-recovery-single-source.test.js ticket-loop-verify.test.js |
| `_slowTestsOwned` | the slow test names that appear in files under the runner's TEST_ROOTS the branch changed since its merge base or recorded base | none | _slowTestsOwnedFrom, gitWorktree.mergeBase | ticket-loop-verify.test.js |
| `_reapRunner` | kills an abandoned suite runner pid that is still alive, never this process | none | _killRunner | sigkill-pid-census.test.js |
| `_stampVerifyPhase` | re-load, set or clear the verify phase the board renders (suite run 1 or 2, reviewer spawn), null being a no-op when absent | tickets.json verifyPhase | none | ticket-loop-verify.test.js |
| `_setLoopStep` | re-load, set or clear the loop step and end the stall episode | tickets.json loopStep, lastActivityAt, nudgedAt | none | ticket-loop-verify.test.js |
| `_writeTicketSuiteFailure` | preserves a red run's output as a per-ticket per-round stamped file in the task dir, written aside and renamed | task dir suite-failure file | _ticketDiffDest, ensureDir | ticket-loop-verify.test.js ticket-auto-merge.test.js |
| `_writeTicketDiff` | writes the round's review diff into the confined task dir and stamps it on the round | task dir review diff, tickets.json rounds | _ticketDiffDest, _stampRoundFile | review-verdict-ticket.test.js ticket-loop-verify.test.js |
| `_spawnTicketReview` | spawns the loop's reviewer as the lead through the team-review path with a built scope, turning refusals into escalations | none | buildReviewScope, _ticketTaskDirRender, _handleTeamReview, _escalateTicket | review-verdict-ticket.test.js ticket-loop-verify.test.js review-cost-durable.test.js |

### Invariants
- `_rejectTicketFromLoop` resolves the seat before any write, so with no seat the ticket stays done for the lead to escalate on.
- `_rejectTicketFromLoop` keeps its reopen field-for-field with the lead's reject, bumping the round before filing the reason.
- `_taskRejectFollowUp` bumps nothing that implies a fresh review round and stamps activity only once the follow-up is away.
- `_spawnTicketReview` diverts rather than suppresses the team-review reply, so an unbriefed or refused reviewer becomes an escalation.

### Hazards
- Hoisting `_notifyLeadOfLoopRejection` above the save, or unwrapping it, lets a notice throw unwind a rejection.
- Merging `_stampVerifyHold` into the loop step or saving a caller's snapshot across the loop's awaits loses the hold or overwrites fresher writes.
- `_reworkSeatFor` discards the `_spawnTicketSeat` result after detaching and archiving the old seat, so a failed replacement spawn is still reported as queued.
- Sending `_notifyHandOfHold` to the lead or arming the spec-confirm latch invites the wrong action on a done ticket.

## Escalation and ticket cost — _escalateTicket … _writeTicketCost

| symbol | purpose | state | calls | pins |
|---|---|---|---|---|
| `_escalateTicket` | the loop's one channel to the lead: deliver an ESCALATED body, then release, watch or keep the loopStep hold by delivery outcome | tickets.json loopStep or escalationUndelivered, lead `_parkedEscalations` | _gatedDeliver, _setLoopStep, _watchParkedEscalation, _stampEscalationUndelivered | ticket-loop-verify.test.js reviewer-round-end.test.js ticket-auto-merge.test.js |
| `_watchParkedEscalation` | record a parked escalation's ticket and step on the live lead session so the hold can be released once the parked text drains | lead session `_parkedEscalations` Map | ticketsStore.load | unpinned |
| `_releaseDrainedEscalations` | for one session, clear loopStep on each watched escalation whose ESCALATED tag is no longer in its parked texts | session `_parkedEscalations`, tickets.json loopStep | parkedTexts, _setLoopStep | unpinned |
| `_costSeatResolve` | decide which seat's ledger a closing ticket's cost belongs to, as seatName, entry and attribution, preferring a declared unknown to a guess | none (reads persistence records) | mintedForTicket, matchSeatRole, getPersistence | unpinned |
| `_costSeatFor` | extend the resolved seat's session ids with every seatReplacements prev seat, collapsing to unknown if a prev record is missing | none | _costSeatResolve, entrySessionIds | team-cost-wiring.test.js rework-context-gate.test.js |
| `_writeTicketCost` | write the per-ticket COST.json rollup at close, deferred and best-effort, and append the team ledger row | taskDir COST.json, team ledger, reads wire-totals.json | _costSeatFor, teamCost.costRecord, gitWorktree.commitsOnBranch, _appendTeamLedger | team-cost-wiring.test.js rework-context-gate.test.js ticket-reminder-binding.test.js |

### Invariants
- `_escalateTicket` delivers first and only then clears the hold, and on a failed delivery the hold stays so the watchdog re-surfaces the ticket.
- `_escalateTicket` keeps the hold under keepHold because a live reviewer may still land a verdict, and only an undelivered escalation logs an error.
- `_costSeatResolve` never uses the first-live-seat resolver, excludes the lead outright, and returns unknown rather than a guessed seat.
- `_writeTicketCost` resolves the taskDir and refuses loudly on an escaping path, and a rollup failure never stops a ticket closing.

### Hazards
- A disposition that turns parked after the delivery call returns is re-held in `_escalateTicket` from the step its reached branch saved, so dropping that save releases a hold `_releaseDrainedEscalations` should have watched.
- `_costSeatFor` merges prev seats' whole-life session ids while keeping the current seat's attribution, and only `_reworkSeatFor`'s ephemeral check keeps a standing seat out of seatReplacements, so dropping it inflates a ticket labelled exact.
- `_writeTicketCost` counts commits against the mint-time fork SHA, and dropping the baseSha argument makes it fall back to a merge-base.

## Verbs: reject, respec, cancel, accept — _taskReject … _taskAccept

| symbol | purpose | state | calls | pins |
|---|---|---|---|---|
| `_taskReject` | lead verb that reopens a done ticket for rework, or routes a rework-open ticket to the follow-up path | tickets.json state, reworkRound, rework reasons, strips close, accept, loop, verify and merge stamps | _taskRejectFollowUp, _reworkSeatFor, _retireReviewSeatsFor, _gatedDeliver | ticket-rework-reasons.test.js reviewer-round-end.test.js ticket-auto-merge.test.js |
| `_taskRespec` | lead verb that replaces an open ticket's spec, keeps the superseded body, re-derives title and taskDir, and re-delivers only if dispatched | tickets.json spec, title, taskDir, respecs, nudgedAt | _deliverTicketSpec, _resolvableAssignTarget, _ticketDeliverySuffix, _reconcileTickets | hold-recovery-single-source.test.js ticket-loop-verify.test.js |
| `_taskCancel` | lead verb that closes an open ticket as cancelled, tells a started seat (with a default line when no reason is given), advances it, writes cost and drops bound reminders | tickets.json state, closedAt, closedBy, events | _advanceSeat, _writeTicketCost, _cancelTicketReminders, _gatedDeliver | ticket-reminder-binding.test.js team-cost-wiring.test.js |
| `_cancelTicketReminders` | drop remind-scheduler entries bound to a ticket on a terminal close and return a report fragment or empty string | remind scheduler | getRemindScheduler | ticket-rework-reasons.test.js ticket-loop-verify.test.js |
| `_stampTicketRevival` | write the write-once revival link (seat, session id, branch, worktree, baseSha) onto a ticket before teardown | tickets.json revival, lastActivityAt | getPersistence, ticketsStore.save | accept-standing-seat.test.js review-cost-durable.test.js |
| `_acceptSeatFacts` | the one source of seat name, record, branch and ephemeralSeat that both accept paths read | none (reads persistence record) | getPersistence | unpinned |
| `_finishAccept` | shared tail of every accept arm: stamp acceptance, end the loop hold, clear answered merge marks, retire reviewers, reap reminders | tickets.json acceptedAt, closedOut, loopClosedOut, mergeError, mergeWaiting | _retireReviewSeatsFor, _cancelTicketReminders, recordEvent | ticket-auto-merge.test.js |
| `_taskAccept` | lead accept verb: validate, no-op on a loop close-out, own the no-branch arm, else hand off to the shared close-out | archives a one-shot seat, board via callees | _acceptSeatFacts, _stampTicketRevival, _finishAccept, _closeOutMergedTicket | accept-standing-seat.test.js ticket-auto-merge.test.js stores.test.js |

### Invariants
- `_taskReject` bumps reworkRound and never clears it, since that counter is the only mark separating a rejection-reopened ticket from one that never closed.
- `_taskRespec` delivers only to a started, unparked ticket and never stamps a start, so `task start` stays the one dispatch verb.
- `_finishAccept` takes closedOut from the calling arm and clears mergeError by compare-and-clear against the stamp that accept acted on.
- `_acceptSeatFacts` reads the branch and the one-shot flag from the seat's persistence record, and a missing record never licenses a teardown.

### Hazards
- `_taskReject` retires the ended round's reviewer after the save, and moving `_retireReviewSeatsFor` above it leaves the board wrong if teardown throws.
- `_stampTicketRevival` is write-once, so a field that must change on an already-stamped ticket needs its own targeted write, as `_closeOutMergedTicket` does.
- `_cancelTicketReminders` must get the lead, because `_finishAccept` also runs on loop-driven accepts whose by is not the reminder owner.

## Accept teardown, park and list — _closeOutMergedTicket … _taskListText

| symbol | purpose | state | calls | pins |
|---|---|---|---|---|
| `_closeOutMergedTicket` | shared accept teardown for lead and loop, gating archive, destroy and branch delete on merge, seat kind, tree dirtiness and liveness | tickets.json revival mergeVetoed or mergedInto, seat worktree and branch | _acceptSeatFacts, _finishAccept, gitWorktree.isMerged, gitWorktree.isDirty | ticket-auto-merge.test.js merged-notice-owes-accept.test.js |
| `_closeOutMergedTicket.seatClause` | the reply fragment saying what happened to the seat, split on one-shot first, then liveness, then record | none | none | accept-standing-seat.test.js |
| `_taskPark` | lead toggle of parked on an open ticket, never re-delivering the spec on unpark | tickets.json parked, nudgedAt | _reconcileTickets, _resolvableAssignTarget | task-start.test.js |
| `_taskList` | task list verb: validate the filter and reply with the rendered board | none | _taskListText | clodex-team.test.js |
| `_taskListText` | render the board: filtered rows by numeric id, plus a capped recently-closed block and done and cancelled counts on the open view | none (reads tickets.json) | ticketsStore.load, humanizeAge | clodex-team.test.js |

### Invariants
- `_closeOutMergedTicket` treats a merge check that could not run as not merged, so absence of evidence never deletes unmerged work.
- `_closeOutMergedTicket` destroys only a seat that `_acceptSeatFacts` reports one-shot and whose tree reads clean, and downgrades to archive on a dirty or unreadable tree.
- `_closeOutMergedTicket.seatClause` splits on seat kind before liveness, never on whether an archive ran, so a gone one-shot seat is not called standing.
- `_taskListText` must stay behaviourally identical to the second implementation in scripts/clodex-team.js, so the two change together.

### Hazards
- `_closeOutMergedTicket` counts commits before destroy and the branch delete, and moving the count below them turns every reply into the unknown case.
- Letting the board save after `_closeOutMergedTicket`'s teardown throw uncaught makes the accept reply claim nothing was removed after the tree and branch are gone.
- `_closeOutMergedTicket` re-reads the board for the mergeError veto after its awaits, and reading the entry snapshot lets a stamp landed mid-accept be torn down.
- The dirty-tree arm of `_closeOutMergedTicket` skips the branch delete on purpose, since the second accept it invites reads the branch back through isMerged.

## Watchdog: stall, nudge, sweeps and team retire — _reconcileTickets … _handleTeamRetire

| symbol | purpose | state | calls | pins |
|---|---|---|---|---|
| `_reconcileTickets` | per-team pass setting each live seat's ticket watch and session-ticket badge from its first open unparked ticket, no-op on solo | `this._ticketWatch`, session-ticket broadcast | _teamLiveSeatNames, _ticketAssigneeSeat, matchSeatRole | session-manager.test.js ticket-reminder-binding.test.js |
| `_touchTicketActivity` | on a watched seat's activity edge, stamp lastActivityAt and clear nudgedAt on every open ticket it holds | tickets.json lastActivityAt, nudgedAt | _ticketAssigneeSeat, resolveTeam | ticket-mixin-surface.test.js session-manager.test.js |
| `startTicketWatchdog` | idempotently start the unref'd sweep interval and the boot requeue of waiting merges | `this._ticketWatchdogTimer`, `this._bootRequeue` | _sweepTickets, _requeueWaitingMerges | ticket-auto-merge.test.js |
| `_sweepTickets` | one watchdog pass: stall sweep once per board root, reconcile and orphaned-verify resume once per team file | none directly | _sweepTeamTickets, _reconcileTickets, _resumeOrphanedVerify | team-manifest.test.js ticket-loop-verify.test.js session-manager.test.js |
| `_stallEvidence` | gather last tool, API error, branch commit count and tree dirtiness for a stall alarm, dropping any field whose probe fails | none | readTail, gitWorktree.commitsOnBranch, gitWorktree.isDirty | session-manager.test.js |
| `_liveReviewSeatsFor` | every live ephemeral reviewer seat for a ticket id, scoped to the team's project root | none | _projectRootFor, getPersistence | reviewer-round-end.test.js review-cost-durable.test.js |
| `_retireReviewSeatsFor` | book and discard-retire live reviewer seats when the lead ends a round by reject or accept, never throwing | review-cost ledger, kills reviewer sessions | _liveReviewSeatsFor, _writeReviewCost, kill | rework-context-gate.test.js accept-standing-seat.test.js review-cost-durable.test.js |
| `_sampleSeatLiveness` | sample transcript size and pty-tree CPU, classify against the last sweep's sample, report wedged only on a second consecutive reading | session review or stall sample and wedged-once fields | _samplePtyTreeCpuMs, classifyReviewSeat | stall-evidence.test.js session-manager.test.js |
| `_wakeSeatEligible` | the single structural gate for a rung-2 wake, checked at sweep time and again inside the wake's produce | none (reads session fields) | isDraftOpen, _seatTranscriptSize | unpinned |
| `_wakeStalledSeat` | rung 2: queue one hedged wake line into a wedged seat, re-checking eligibility and the stall episode inside produce | tickets.json wakeAt, session `_stallWakeAt` | _wakeSeatEligible, _wakeText, _injectText | unpinned |
| `_probeReviewSeat` | sample every live reviewer of a review-step ticket and return a moving or unknown one first, else the first wedged | session review samples via callee | _liveReviewSeatsFor, _sampleSeatLiveness | unpinned |
| `_sweepUndeliveredMergeErrors` | re-send a merge-error escalation stamped undelivered and clear the stamp once it queued or parked | tickets.json escalationUndelivered | _gatedDeliver | unpinned |
| `_sweepMergedUnaccepted` | nudge the lead once when a merged done ticket sits unaccepted past the nudge window, stamping only from the delivery callback | tickets.json mergedNudgedAt | _gatedDeliver | rework-context-gate.test.js |
| `_sweepTeamTickets` | per-team stall pass: run both sub-sweeps, then stay silent, wake the seat, or alarm the lead on a geometric ladder | `this._stallProbing`, tickets.json nudgedAt, orphanNudgedAt | _stallEvidence, _probeReviewSeat, _wakeStalledSeat, _gatedDeliver | merged-notice-owes-accept.test.js ticket-loop-verify.test.js session-manager.test.js |
| `_handleTeamRetire` | team-retire handler: decide discard or archive from manifest and record, downgrade on a dirty tree, book reviewer cost, tear down | seat worktree and record via destroy or archive, review-cost ledger, revival stamp | matchSeatRole, gitWorktree.isDirty, _stampTicketRevival, _writeReviewCost | accept-standing-seat.test.js review-cost-durable.test.js |

### Invariants
- `_sweepTickets` dedups the stall sweep per board root and the reconcile per team file, because collapsing them under one key breaks whichever loses.
- `_sampleSeatLiveness` needs two consecutive wedged verdicts before an alarm, and an unknown sample neither confirms nor clears the wedge.
- `_wakeStalledSeat` re-runs `_wakeSeatEligible` and stamps wakeAt with the sweep's instant inside produce, so a seat that moved is never written to.
- `_handleTeamRetire` discards only a seat outside the manifest or one whose record is one-shot, and downgrades to archive on a dirty or unreadable tree.

### Hazards
- `_sweepTeamTickets` stamps nudgedAt only from the delivery callback on a re-loaded board, so saving its own snapshot would undo those stamps.
- `_retireReviewSeatsFor` must price each round before kill drops the record, and is called only where a lead transition drops the hold, never from `_escalateTicket` keepHold arms.
- `_liveReviewSeatsFor` is project-scoped because ticket ids repeat across projects, and an unscoped walk lets another project's reviewer suppress `_probeReviewSeat` alarms.
- `_sweepUndeliveredMergeErrors` skips any ticket with closedOut set, although `_sweepMergedUnaccepted` notes that loop tree-keeping arms set it without closing out.

## EXEMPT

