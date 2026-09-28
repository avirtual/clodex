# renderer/renderer.js

The coordinating core of the desktop (and web-bundle) renderer: the `sessions`
Map and `activeSession`, terminal management, the sidebar loop, PTY routing,
the new-session and edit-args dialogs, `popoverApi`, the peers-SETUP dialog,
the global shortcuts and the restore IIFE. Most `window.api.onX(...)` pushes
and every `document.addEventListener` callback are anonymous, so the extractor
records no name for them; each region below names the anonymous handlers it
contains in its Hazards and anchors on the nearest named symbols. Event
payloads are documented in `docs/renderer-events.md`.

## Seat state and per-seat markers — skillAutoSet … refreshTranscriptPanes

| symbol | purpose | state | calls | pins |
|---|---|---|---|---|
| skillAutoSet | the set of library skills auto-enabled for a seat, from each skill's frontmatter scope | none | scope-util.autoEnabledFor | unpinned |
| markSeatIo | records a seat's io kind (stream or pty) and mirrors it onto the sidebar row's `data-io` | `streamSeatNames`, row `data-io` | seatIoKind | exited-seat-row.test.js renderer-source-pins.test.js seat-io-marker.test.js |
| markSeatEffort | sets or clears the row's `data-effort` and refreshes the live-split status line | row `data-effort`, `sessions` entry `liveSplit` | none | exited-seat-row.test.js seat-io-marker.test.js sidebar-account-restart.test.js |
| markSeatPosture | sets `data-posture` for a non-default posture, else clears it, then refreshes the live-split status | row `data-posture` | none | exited-seat-row.test.js seat-io-marker.test.js sidebar-account-restart.test.js |
| refreshTranscriptPanes | re-applies the Preferences transcript-pane view to every live agent seat after a settings change | `sessions` entries' seat view | sessionTypeOf, lib/seat-view.applySeatView | renderer-source-pins.test.js |

### Invariants
- `markSeatIo` must run before `createTerminal` for a seat, because `createTerminal` picks the stream pane or an xterm from `streamSeatNames`.
- `markSeatEffort` and `markSeatPosture` are no-ops when the sidebar row does not exist yet, so callers mark after `addSessionToSidebar`.

### Hazards
- The `sessions` Map declaration comment says entries are `{ terminal, fitAddon, wrapperEl }`, but `createTerminal` also stores `peer`, `stream`, `liveSplit`, `echoRewrite` and the seat-view fields; read `createTerminal`, not the comment.
- `activeSession` is a module `let` reassigned only by `switchSession` and the empty-state branch of `removeSession`; writing it anywhere else skips every surface those two re-point.

## Sidebar resize and new-session field helpers — initSidebarResize … modelAliasHint

| symbol | purpose | state | calls | pins |
|---|---|---|---|---|
| initSidebarResize | IIFE wiring sidebar width drag, double-click reset and fold toggle; returns the fold toggle as `toggleSidebarFold` | `--sidebar-width`, localStorage width/fold keys, settings `sidebarWidth`/`sidebarFolded` | sidebar-width.clampSidebarWidth, window.api.setSettings | sidebar-fold.test.js |
| refreshNameValidity | recomputes the new-session name state against reserved names and paints the field and Create button | `dialogNameState`, `dialogReservedSets` | lib/name-validity.nameFieldState, refreshCreateButton | new-session-modes.test.js new-session-name-validity.test.js |
| setProxyControls | fills the proxy mode select and URL input from a tri-state proxy value | `#input-proxy-*` controls | proxyValueFromControls | new-session-modes.test.js optimized-late-skills.test.js optimized-mode-subset.test.js |
| closePromptEditor | `let` no-op stub reassigned by the `initLibraryDrawers` destructuring and called through the Escape table | module `let` | initLibraryDrawers | dialog-escape-parity.test.js |
| promptText | promise-returning single-line text modal; resolves the string on OK/Enter and null on Cancel/Escape | `.prompt-modal-overlay` on body | none | chord-overlay-guard.test.js dialog-escape-parity.test.js |

### Invariants
- `closePromptEditor`, `closeAgentEditor`, `closeSkillEditor` and `closeExecEditor` are declared as no-op `let`s so the hoisted Escape table can reference them before `initLibraryDrawers` assigns the real closers.
- `refreshNameValidity` treats every name as valid in template mode, because a template name is not a session name.

### Hazards
- `initSidebarResize` persists the width to both localStorage and settings; changing only one leaves the other to win on the next boot.

## Workspace header and sidebar row builders — renderWorkspaceName … accountOfRow

| symbol | purpose | state | calls | pins |
|---|---|---|---|---|
| startWorkspaceRename | inline rename of the workspace from the sidebar header, also fired by the `request-rename-workspace` push | `#workspace-name`, `document.title` | window.api.setWorkspaceName | unpinned |
| addFailedSessionToSidebar | renders a restore- or move-failed seat as a "failed — click to retry" row; ✕ forgets the record | sidebar DOM, `sidebarMeta` | rebuildLiveRow, window.api.retrySpawnSession | exited-seat-row.test.js renderer-source-pins.test.js seat-io-marker.test.js |
| addArchivedSessionToSidebar | renders an archived or moved-to-peer seat as a dimmed row; click unarchives and resumes, ✕ deletes the record | sidebar DOM, `sidebarMeta` | window.api.unarchiveSession, rebuildLiveRow | exited-seat-row.test.js renderer-source-pins.test.js seat-io-marker.test.js |
| rowSnapshot | captures a live row's identity (type, cwd, label, backend, team, effort, posture, io, noWire, fixFor, account) from its dataset | reads row dataset, `streamSeatNames`, `sidebarMeta` | none | exited-seat-row.test.js seat-io-marker.test.js sidebar-account-restart.test.js |
| rebuildLiveRow | recreates the terminal and live row from a snapshot plus the backend's reply after a kill-and-respawn | `sessions`, sidebar DOM, `sidebarMeta` | createTerminal, addSessionToSidebar, markSeatEffort | exited-seat-row.test.js renderer-source-pins.test.js seat-io-marker.test.js |
| exitedRowSnapshot | snapshot of an about-to-be-removed agent row for its exited row; null when no row exists | reads row dataset | rowSnapshot | exited-seat-row.test.js seat-io-marker.test.js |
| addExitedSessionToSidebar | renders an exited agent seat as a row whose click resumes it and whose ✕ forgets its record | sidebar DOM | exitedLabel, rebuildLiveRow | exited-seat-row.test.js seat-io-marker.test.js |
| archivedRowEntry | snapshots a live row's identity with `archivedAt` so `onSessionExit` can rebuild it as an archived row | reads `sidebarMeta` | rowSnapshot | seat-io-marker.test.js |
| archiveSessionRow | ✕ and Cmd+W: stashes the archived entry, then calls `session:archive`; un-stashes and toasts on failure | `archivingSessions`, `movingFailed` | archivedRowEntry, window.api.archiveSession | chord-overlay-guard.test.js session-move.test.js sidebar-account-chip.test.js |
| deleteSessionRow | right-click Delete: confirm, kill, and remove the row locally only when the seat was not live | `movingFailed`, `seatViewMemory` | window.api.confirmKill, window.api.killSession | renderer-source-pins.test.js session-manager.test.js session-move.test.js |
| addSessionToSidebar | builds and inserts the live-seat row (chip, name, badges, buttons) and wires click, rename, flush and context menu | sidebar DOM, row dataset | typeGlyph, insertLocalSessionRow, applyFixChip, startRename | deploy-visible.test.js exited-seat-row.test.js peer-fix-working-line.test.js |

### Invariants
- `archiveSessionRow` stashes into `archivingSessions` BEFORE the archive call, because the `onSessionExit` push that follows is what turns the live row into an archived one.
- `deleteSessionRow` removes the row locally only when the reply says `live === false`; a live seat's row goes through `onSessionExit` like any other exit.
- `insertLocalSessionRow` keeps local rows above the first `[data-peer-ui]` row, which the peer runtime owns.

### Hazards
- `addSessionToSidebar` takes nine positional parameters; a call site that drops `label` or `fixFor` silently loses the displayed label or the fix chip, which is why rebuilds go through `rebuildLiveRow` and `rowSnapshot`.
- `addArchivedSessionToSidebar` and `addExitedSessionToSidebar` wire their own click and ✕ handlers inside the builder; a new row kind needs its own pair, not a flag on `addSessionToSidebar`.

## Row menus: restart, move, rename — restartSessionWithReattach … updateSidebarActive

| symbol | purpose | state | calls | pins |
|---|---|---|---|---|
| restartSessionWithReattach | restarts a seat via `session:restart` and rebuilds its terminal and row from a snapshot taken before the kill | sidebar DOM, `sessions` | rowSnapshot, rebuildLiveRow, switchSession | renderer-source-pins.test.js seat-io-marker.test.js |
| moveSessionWithPicker | Move Session…: picks a directory, calls `session:move`, rebuilds on success or parks a failed row when kept | `movingFailed` | rowSnapshot, rebuildLiveRow, addFailedSessionToSidebar | renderer-source-pins.test.js seat-io-marker.test.js session-move.test.js |
| moveSessionToWorkspace | calls `session:move-to-workspace` and toasts; the old window's row goes via the moved-out push | none | window.api.moveSessionToWorkspace, showToast | session-move.test.js |
| moveSessionToPeerWithDialog | registers a one-shot move closure and opens the peer session dialog in move mode | pending move closures, sidebar DOM | rowSnapshot, rebuildLiveRow, addArchivedSessionToSidebar | renderer-source-pins.test.js seat-io-marker.test.js session-move.test.js |
| startRename | inline-edits a row's name and on commit calls `session:rename` and rebuilds the row under the new name | sidebar DOM, `sessions` | window.api.renameSession, rebuildLiveRow | seat-io-marker.test.js session-rename.test.js sidebar-account-chip.test.js |
| startRename.finish | commit-or-cancel closure of the rename edit, run on Enter, Escape and blur | row name element | window.api.renameSession | unpinned |
| removeSessionFromSidebar | removes a row and its `.session-child` rows, drops activity feeds and meta, then re-lays out | sidebar DOM, `sidebarMeta` | refreshSidebarView | unpinned |

### Invariants
- `restartSessionWithReattach` takes its `rowSnapshot` before calling restart, because the kill-and-respawn wipes the row through `onSessionExit`.
- `moveSessionWithPicker` parks a kept-but-failed seat in `movingFailed` while it is still live, so the exit push rebuilds it as a failed row instead of dropping it.

### Hazards
- The main-process context menu arrives through the anonymous `window.api.onSessionContextAction` switch that sits between `moveSessionToPeerFromDialog` and `startRename`; its archive, delete and move arms call these helpers directly and never go through `popoverApi`, because they act on the local record.
- The "Handle context menu actions from main process" comment sits above `restartSessionWithReattach`, not above the handler it describes.
- `startRename.finish` rebuilds the row with a null label from `rowSnapshot`, so the new name is what the row shows after a rename.

## Sidebar view loop — filterLabels … updateWindowTitle

| symbol | purpose | state | calls | pins |
|---|---|---|---|---|
| groupFor | the group key for a row under the current group mode (project/team, state, date, pr); null for none | reads `sidebarView`, `sidebarMeta` | projectLabel, stateOf, dateBucket | unpinned |
| rowPasses | applies the status, activity-age and search filters to a row | reads `sidebarView`, `sidebarMeta` | stateOf | unpinned |
| refreshSidebarView | the sidebar render loop: repaints row badges, hides filtered rows, re-orders local rows flat or under group headers | sidebar DOM, `collapsedGroups` | rowPasses, groupFor, makeGroupHeader, applyPrBadge | exited-seat-row.test.js plugin-host.test.js plugin-scope.test.js |
| applyFixChip | marks an ad-hoc fix seat's row with `data-fixFor` and a fix chip | row dataset | none | deploy-visible.test.js seat-io-marker.test.js sidebar-account-chip.test.js |
| scheduleSidebarRelayout | 250 ms trailing debounce of `refreshSidebarView` | `relayoutTimer` | refreshSidebarView | plugin-host.test.js seat-io-marker.test.js sidebar-account-chip.test.js |
| makeGroupHeader | builds one collapsible group header; team groups get a right-click that opens the team roles popover | `collapsedGroups` | openTeamRolesPopover | unpinned |
| refreshSidebarMeta | pulls per-session sidebar meta into the cache, re-marks chips, repaints the sidebar and plugin footer buttons | `sidebarMeta` | window.api.sidebarMeta, refreshSidebarView | plugin-dialog-snapshot.test.js plugin-git-branches-renderer.test.js plugin-scope.test.js |
| onViewControlChange | rebuilds `sidebarView` from the filter controls, persists it via `workspace:setView` and repaints | `sidebarView` | window.api.setSidebarView, refreshSidebarView | unpinned |
| initSidebarView | boots the filter state: loads the stored view, runs the one-time status migration, first meta refresh, 30 s timer | `sidebarView`, meta timer | refreshSidebarMeta, applyFilterFolded | exited-seat-row.test.js restore-fit.test.js |
| webAttentionCount | counts rows needing attention for the web tab-title badge | reads sidebar DOM | none | unpinned |
| updateWindowTitle | sets `document.title` to the session count, badged with the attention count only in the web host | `document.title` | webAttentionCount, lib/web-notify.badgeTitle | unpinned |

### Invariants
- `refreshSidebarView` re-orders only local rows and keeps them above the first peer row, moving each row's `.session-child` rows with it.
- `initSidebarView` is called by the restore IIFE after rows exist, so the first `refreshSidebarMeta` has rows to paint.

### Hazards
- `refreshSidebarMeta` queues one re-run while a call is in flight and keeps only the latest options, so a caller cannot force two overlapping fetches.
- `initSidebarView` writes the `statusMigrated` marker only when a stored view exists, so a fresh workspace never records it.
- `updateWindowTitle` overwrites the title `startWorkspaceRename` sets, on every `createTerminal` and `removeSession`.

## Composer and stream seat pane — filePathFromUri … createStreamSeatPane

| symbol | purpose | state | calls | pins |
|---|---|---|---|---|
| attachComposer | shared composer keyboard and auto-height: slash menu, Escape, readline edits, tap-to-talk, Enter to send | textarea height | lib/composer-keys.composerReadlineEdit, lib/composer-keys.composerHeightFor | renderer-source-pins.test.js |
| createStreamSeatPane | builds a stream-io seat's whole UI (transcript, outbox, permission cards, attachments, slash menu, composer) | returned handle stored as `seat.stream` | attachComposer, window.api.transcriptPull | renderer-source-pins.test.js |
| renderPermissions | paints the pending permission cards of a stream seat with their allow and deny actions | pane DOM | window.api.seatPermission | renderer-source-pins.test.js |
| sendComposer | sends the stream composer text as a turn, restoring the draft if the send fails | composer value | window.api.seatSend | renderer-source-pins.test.js |
| pickSlash | runs a picked slash command: control commands through seat control, text commands into the composer | composer value | window.api.seatControl | renderer-source-pins.test.js |

### Invariants
- `createStreamSeatPane` returns a handle with no xterm, so every caller of a `sessions` entry must test `terminal` before measuring or writing.

- `pickSlash` cuts only the command's own range for a control command and restores it if the control call fails.

### Hazards
- `sendComposer` restores a failed send's text only into an empty composer, so text typed during the send is not overwritten.

## Terminal management and switchSession — createTerminal … removeSession

| symbol | purpose | state | calls | pins |
|---|---|---|---|---|
| createTerminal | builds one seat's view (stream pane, or xterm with links, voice, composer and live split) and registers it in `sessions` | `sessions`, `terminalContainer` | createStreamSeatPane, attachComposer, updateWindowTitle | deploy-visible.test.js exited-seat-row.test.js free-identifier-leaks.test.js |
| writePty | writes composer or voice text to a local seat's PTY and tracks typed-since-Enter | `seat.typedSinceEnter` | window.api.writeToSession | pty-composer.test.js |
| remeasureReadonlyPeer | re-fits a read-only peer tab to refresh stale metrics, then snaps back to the owner's size | xterm size | none | unpinned |
| switchSession | makes a seat active: flips wrapper visibility, re-points every active-keyed surface, then measures and focuses | `activeSession` | renderProxyBar, updateSidebarActive, reportFocusedSession | exited-seat-row.test.js external-tap-trigger.test.js restore-fit.test.js |
| switchToNewSession | activation step for a just-created seat; the focus policy decides whether it steals focus | `activeSession` | lib/focus-policy.planNewSession, switchSession, fitSessionInBackground | deploy-visible.test.js peer-fix-working-line.test.js spawn-focus-steal.test.js |
| fitSessionInBackground | measure-and-resize half of `switchSession` for an unfocused seat, guarded against the seat dying mid-frame | PTY size | window.api.resizeSession | restore-fit.test.js spawn-focus-steal.test.js |
| removeSession | tears down a seat's view and every per-seat cache, then picks a new active seat or the empty state | `sessions`, `proxyState`, `ctxPct`, `filesState` | removeSessionFromSidebar, switchSession, refreshQuotaChip | deploy-visible.test.js exited-seat-row.test.js seat-io-marker.test.js |

### Invariants
- `switchSession` hides inactive wrappers with the `visible` class toggle (CSS `visibility`), never `display:none`, so xterm keeps a layout box to measure.
- `fitSessionInBackground` is safe on a hidden wrapper for the same reason, and `display:none` must never be used on `.terminal-wrapper`.
- `remeasureReadonlyPeer` pushes nothing upstream: read-only tabs have no resize wiring to the owner.
- `removeSession` disposes the intent highlight before the terminal, because its decorations hold markers the terminal owns.
- `switchSession` calls `pluginBar.onSeatSwitched` only after `activeSession` is set, because the plugin host answers from it.

### Hazards
- `createTerminal` routes typing on a peer seat to `peerInput` only when the seat is controlled, draining any buffered input first; otherwise the keystroke asks to take control.
- The anonymous `window.api.onPtyData` handler writes through each seat's `echoRewrite`, which `createTerminal` builds; a seat created without it shows raw echo colours.
- `createTerminal` detects the web bundle with `window.__CLODEX_WEB__ || !window.require`; desktop-only paths such as file drop and absolute `require` sit behind that test.

## New-session dialog: type, placement, catalogs — applyTypeDefaults … refreshNewSessionTools

| symbol | purpose | state | calls | pins |
|---|---|---|---|---|
| applyTypeDefaults | reshapes the new-session dialog for the selected CLI type and kicks off the async checklist refreshes | dialog rows, checklist caches | refreshNewSessionPlugins, applySandboxState, refreshNewSessionToolGate | cli-adapters.test.js effort-options.test.js intent-checklist-seam.test.js |
| applyNewSessionToolGate | records the tool gate, paints the missing-CLI notice and refreshes the Create button | `dialogToolGate` | refreshCreateButton | unpinned |
| applyPlacement | reacts to a placement change: rewrites the cwd, then loads the box's catalogs or restores the host's | `#input-cwd` | applySandboxState, restoreHostCatalogs, refreshTeamForCwd | unpinned |
| applySandboxState | for a box placement, greys the rich fields with a reason or fills the checklists from the box's catalogs | `placementCatalogToken` | greyRichFields, populateChecklistsFromCatalogs | unpinned |
| populateChecklistsFromCatalogs | repaints every dialog checklist from a sandbox box's catalogs; plugins, intents and exec stay local | checklist caches | lib/checklists render functions | new-session-modes.test.js optimized-late-skills.test.js placement-cache-restore.test.js |
| restoreHostCatalogs | re-seeds every cache a box stint overwrote with the Mac's own catalogs | checklist caches | populateHostCatalogs, loadPromptLib | new-session-modes.test.js placement-cache-restore.test.js |
| fillSystemPromptSelect | rebuilds a system-prompt select from the library plus ticked plugins' prompt bundles | select options | getPromptLibCache | library-prompt-cache.test.js new-session-modes.test.js optimized-late-skills.test.js |
| applyModeFields | pushes the standard or optimized preset into the Advanced fields; a no-op for custom | dialog fields | modeToolDenySet, modeSkillDenySet | new-session-modes.test.js optimized-mode-subset.test.js |
| refreshNewSessionPlugins | refetches the plugin catalog and renders the plugin checklist for plugin-capable types | plugin catalog cache | repaintNewSessionBundleRows | cli-adapters.test.js intent-checklist-seam.test.js new-session-modes.test.js |
| newSessionSkillDenyList | turns the skill checklist back into a deny list, keeping the deferred keep-list form | skill collector | skills-off.deferredSkillDeny | intent-checklist-seam.test.js new-session-modes.test.js optimized-late-skills.test.js |

### Invariants
- `refreshNewSessionPlugins` fetches the catalog above its type guard, because a type with no Plugins section still saves `defaultPluginTicks()`, which reads that cache.
- `restoreHostCatalogs` reloads the prompt library itself, since `populateHostCatalogs` does not cover prompts.
- `populateChecklistsFromCatalogs` keeps plugins, intents and exec on the local engine even for a box placement.

### Hazards
- `applyTypeDefaults` calls `applySandboxState` regardless of its `skipAsyncRefresh` flag, so applying a template on a box placement schedules the async render that flag is meant to suppress.
- `applySandboxState` bumps `placementCatalogToken` only on the fetch path, so a late fetch reply can un-grey fields a later greyed call just greyed.
- `applyPlacement` rewrites the cwd without an input event and refreshes only the team row, so the worktree row can survive from the old cwd.

## Team, cwd and session:create — refreshWorktreeForCwd … saveTemplateFromForm

| symbol | purpose | state | calls | pins |
|---|---|---|---|---|
| refreshWorktreeForCwd | shows the worktree row only for a git cwd outside template authoring, dropping superseded replies by token | worktree row | window.api.worktreeInfo | new-session-modes.test.js |
| refreshTeamForCwd | decides whether the dialog offers "Join team X" or "Create a team here" for the cwd and prefills the fields | `dialogTeamName`, team rows | window.api.teamForCwd, updateTeamJoinNameSuggestion | new-session-modes.test.js |
| openDialog | resets and opens the New Session dialog, loading settings, accounts, templates, prompts, boxes and reserved names | dialog state, `dialogMode` | applyTypeDefaults, populateHostCatalogs, refreshNameValidity | chord-overlay-guard.test.js new-session-modes.test.js new-session-name-validity.test.js |
| populateHostCatalogs | seeds the dialog caches and checklists from the Mac's own settings and agent library | checklist caches | lib/checklists setters | new-session-modes.test.js optimized-mode-subset.test.js placement-cache-restore.test.js |
| cwdFromTemplate | resolves a template's cwd, expanding `${TEAM_ROOT}`, and returns an unresolved root as a warning | none | team-root-expand.expandTeamRoot | unpinned |
| collectFormConfig | serialises the dialog into the config object shared by spawn and Save as Template | reads dialog fields | collectAppendPromptFiles, newSessionSkillDenyList | intent-checklist-seam.test.js new-session-modes.test.js plugin-dialog-snapshot.test.js |
| doCreate | submits the dialog: validates, then spawns on the host (plain, team create, team join, optional worktree) or in a box | `sessions`, sidebar DOM | window.api.createSession, window.api.teamCreate, createTerminal, switchToNewSession | new-session-name-validity.test.js plugin-source-dialog.test.js |
| submitDialog | routes the dialog's primary action to template save or session create by `dialogMode` | reads `dialogMode` | doCreate, saveTemplateFromForm | dialog-escape-parity.test.js new-session-name-validity.test.js |
| openTemplateEditor | reuses the new-session dialog as a template editor and prefills every field from the template | dialog state | setDialogMode, openDialog | new-session-modes.test.js plugin-prompt-checklist.test.js plugin-scope.test.js |
| saveTemplateFromForm | persists the collected config into the owning store: team template, plugin bundle, rename by id, or upsert | template stores | collectFormConfig, window.api.saveTemplate | new-session-modes.test.js plugin-prompt-checklist.test.js plugin-scope.test.js |

### Invariants
- `collectFormConfig` returns exactly the EDITOR_OWNED keys of `stores.js` `save()`, so a newly omitted key here must also be added there or merge-preserve resurrects it.
- `collectFormConfig` gives a type with no Plugins section the globally enabled set, because an empty list would close that seat to every plugin.
- `cwdFromTemplate` leaves the literal `${TEAM_ROOT}` in the field on an unresolved root instead of substituting a directory, and only the dropdown expands it.
- `openDialog` resets the placement to host before `applyTypeDefaults`, so a stale box value cannot trigger a catalog fetch during open.

### Hazards
- `doCreate` spawns through `session:create` (or the team verbs) and only then calls `createTerminal` and `addSessionToSidebar`; mounting before the reply leaves a row for a seat that never started.
- `doCreate` removes a worktree it just created when the spawn fails; moving the worktree step after the spawn loses that cleanup.

## Voice and PTY event routing — markSeatVoice … applyTicketBadge

| symbol | purpose | state | calls | pins |
|---|---|---|---|---|
| voiceSinkFor | picks where voice text lands for a seat: stream pane, visible PTY composer, or the PTY voice line | none | ptyComposerShown | unpinned |
| voiceEngine | lazily builds the hidden xterm and voice mirror that parse the voice engine PTY | `voiceEngineView` | voice mirror | voice-mirror.test.js |
| seatVoiceRecord | starts or stops recording for a seat and re-arms the shared mirror to it | `voiceArmedSeat`, `voiceRecordingSeat` | window.api.voiceRecord, setSeatRecording | voice-mirror.test.js |
| seatActivity | derives a row's activity from its attention and activity data attributes | reads row dataset | none | unpinned |
| applyPendingBadge | paints the parked-message count badge and enriches its tooltip with previews from main | row badge | window.api.peekPending | unpinned |

### Invariants
- The anonymous `window.api.onPtyData` handler diverts the voice engine's name to `voiceEngine` before any `sessions` lookup.
- The anonymous `window.api.onSessionExit` handler takes the `exitedRowSnapshot` BEFORE `removeSession`, then rebuilds the row as archived, failed or exited from `archivingSessions` and `movingFailed` in that order.
- That exit handler invalidates the tool cache before its archived early return, so closing an installer tab still re-probes `refreshNewSessionToolGate`.

### Hazards
- PTY routing (`onPtyData`, `onSessionExit`, `onSessionActivity`, `onSessionAttention`, `onSessionCtx`, `onPendingCount`, `onSessionTicket`) is anonymous and sits between `seatVoiceFired` and `applyTicketBadge`; search by the channel, not a name.
- The exit toast fires only for agent seats with an unexpected non-zero exit, so an intent-spawned bash seat that fast-fails does not storm toasts; `addExitedSessionToSidebar` is likewise agent-only.
- Detached `pty-data` is buffered by the main process, not here; the renderer replays it once through `mountRestoredSession`.

## Seat predicates, plugin renderers and the proxy bar — sessionTypeOf … applySubagents

| symbol | purpose | state | calls | pins |
|---|---|---|---|---|
| sessionTypeOf | a session's type from its sidebar row, or null when no row exists | reads row dataset | none | adapter-literal-shape.test.js plugin-host.test.js popover-sibling-close.test.js |
| activePeerQueryable | whether the active seat is a peer whose box is online and advertises the query cap | reads `peerStatuses` | none | plugin-host.test.js |
| pluginReachesSession | whether a plugin applies to a named session, from the row's meta plugins and the catalog's shipped flag | reads `sidebarMeta` | seatHasPlugin | plugin-host.test.js plugin-scope.test.js |
| activatePluginRenderer | fetches a plugin's renderer half, loads it for this host, activates it and reports the outcome | plugin bar | requirePluginRenderer, window.api.pluginInvoke | plugin-scope.test.js plugin-web-parity.test.js |
| requirePluginRenderer | resolves a renderer module from the bundled registry, then source eval, then a desktop absolute-path require | none | lib/plugin-module-eval.evalRendererModule | plugin-web-parity.test.js |
| loadPluginRenderers | at boot, fills the plugin catalog cache and activates every enabled plugin's renderer in turn | plugin catalog cache | activatePluginRenderer | plugin-scope.test.js plugin-web-parity.test.js |
| renderSessionActions | paints the proxy-bar action strip for the active seat | `#proxy-actions` | voiceBarActionHtml | unpinned |
| renderProxyBar | renders the whole proxy telemetry bar for the active session and delegates the action strip | `#proxy-bar` | sideChannelSegs, renderSessionActions, buildProxyExtras | plugin-scope.test.js proxy-bar-press-open.test.js |
| buildProxyExtras | builds the keep-warm and wire-strip buttons that trail the action strip | none | none | unpinned |
| applyWarmBadge | paints one row's cache-warmth badge and refusal flag from `proxyState` | row badge | none | unpinned |
| applySubagents | reconciles a parent row's subagent child rows against its latest proxy payload | `.session-child` rows | subagentRows | free-identifier-leaks.test.js renderer-source-pins.test.js |

### Invariants
- `activatePluginRenderer` reports success as well as failure, because only a success clears a stale strike.
- `requirePluginRenderer` returns null on web when neither the registry nor source text supplies the module, since an absolute `require` works only with context isolation off.

### Hazards
- The anonymous `window.api.onSessionProxy` and `onWireQuota` handlers feed `proxyState` and the quota chip and live between `acceptWireQuota` and `applyCompacting`.
- `sessionTypeOf` reads the sidebar row, so it answers null for a seat whose row is not built yet.

## Toasts, bar routing, Create Team and popoverApi — showToast … popoverApi

| symbol | purpose | state | calls | pins |
|---|---|---|---|---|
| showToast | shows a toast with optional click-to-switch; returns a dismiss function carrying `.set(text)` | toast DOM | switchSession | deploy-visible.test.js exited-seat-row.test.js free-identifier-leaks.test.js |
| checkWarmthCooldown | once per warm episode, toasts that a kept-warm cache goes cold soon | `warmWarned` | showToast | unpinned |
| runBarActionOnClick | click router for the proxy bar: wirescope link, plugin segments, core buttons and the keep-warm menu | none | routeSessionAction | proxy-bar-press-open.test.js |
| routeSessionAction | dispatches a session-menu pick to plugin actions, the checklist popovers, the args dialog or restart | none | openArgsDialog, restartSessionWithReattach | plugins-popover.test.js proxy-bar-press-open.test.js |
| openCreateTeamDialog | modal Create Team dialog that creates a seatless team through `team:createBare` | dialog DOM | window.api.teamCreateBare, openTeamRolesPopover | teams-menu.test.js |
| popoverApi | the local-vs-peer data seam: routes ctx, report, bust, files, peek and diff locally or through `peerQuery` | reads `sessions` entry `peer` | window.api.peerQuery | popover-sibling-close.test.js side-pane-toggle.test.js transcript-rows.test.js |

### Invariants
- `popoverApi` drops the options on a remote `ctx`, because utilization opt-in is the owning box's call.
- Every data popover (cost, bust, context, report, files) is handed `popoverApi` at init and never calls `window.api` for a seat directly.

### Hazards
- `routeSessionAction` and the checklist popovers edit or act on the local record and deliberately bypass `popoverApi`; do not route them through it.
- A new data popover that calls `window.api` directly instead of `popoverApi` silently shows the local engine's answer for a peer seat.

## Focus, refit and keyboard chords — refreshSelectionBadge … askOnce

| symbol | purpose | state | calls | pins |
|---|---|---|---|---|
| reportFocusedSession | sends this window's active seat to main as `session:focused` and refreshes the voice core | none | window.api.noteFocusedSession | external-tap-trigger.test.js |
| refitActiveTerminal | fits the active xterm and pushes its size to the PTY, or to the box only for a controlled peer seat | PTY size | window.api.resizeSession, window.api.peerResize | unpinned |
| runCloseChord | Cmd+W and web Alt+W: closes the one open dialog, hides a peer row, or archives the active seat | none | lib/chord-guard.performCloseChord, archiveSessionRow | chord-overlay-guard.test.js |
| askOnce | web-only one-shot gesture listener that asks for notification permission, then removes itself | none | createWebNotifier | unpinned |

### Invariants
- The anonymous Cmd keydown handler runs in the capture phase so xterm never swallows the chords: Cmd+B fold, Cmd+T new, Cmd+W `runCloseChord`, Cmd+1..9 and Cmd+Shift+]/[ `switchSession`, Cmd+F search.
- The Cmd and Alt handlers return early when the drawer has focus, so Cmd+W typed into a drawer tenant cannot archive an unrelated seat via `runCloseChord`.
- Escape closes a dialog only when exactly one overlay is open, through the `ESCAPE_CLOSES` table next to `overlayElementById`.
- `reportFocusedSession` is never called at eval time, only on window focus and from `switchSession` and `removeSession`.

### Hazards
- The web frontend mirrors Cmd+T/W/1-9 onto Alt in a second anonymous keydown handler gated on `window.__CLODEX_WEB__`; a new chord added only to the Cmd handler is missing on web, next to `askOnce`.
- Cmd+1..9 counts `.session-item` rows in DOM order, so a change to `refreshSidebarView` ordering changes what `switchSession` each digit reaches.

## Discovery and Preferences: env, accounts, wirescope — closeDiscovery … renderRemoteStatus

| symbol | purpose | state | calls | pins |
|---|---|---|---|---|
| adoptSession | turns a discovered transcript into a prefilled New Session form, patching an open dialog or opening one | dialog fields | openDialog | new-session-modes.test.js plugin-scope.test.js |
| renderDiscovery | paints the Discover Sessions list: resumable disk transcripts, then live foreign processes | `#discovery-list` | adoptSession, relTime | new-session-modes.test.js |
| refreshPrefsEnv | rebuilds the Preferences environment-variable list for the selected scope | `#prefs-env-list` | window.api.envScopesGet, lib/env-row.buildEnvRow | prefs-env-row.test.js |
| refreshPrefsAccounts | rebuilds the Preferences accounts list with Log in, Move, Re-sync and Remove actions | `#prefs-accounts-list` | window.api.accountsList, startLoginSeat | prefs-account-row.test.js |
| saveRemoteToken | sets or clears the phone-access wire token and repaints its status | none | window.api.remoteSetToken | unpinned |
| previewWsLogs | dry-run prune preview that decides whether the capture-log Clear button is enabled | `#ws-logs-*` | window.api.wirescopePrune | wirescope-popover-shape.test.js |

### Invariants
- `addPrefsEnvVar` refuses an empty secret value, so a Replace cannot blank a stored credential; `refreshPrefsEnv` is what seeds that form.
- `previewWsLogs` drops a reply superseded by a newer age selection.

### Hazards
- `renderRemoteTokenState` paints only a has-token boolean; the token value must never reach the renderer, so `saveRemoteToken` blanks its input.

## Peers SETUP dialog — collapsePeerRow … closePeersDialog

| symbol | purpose | state | calls | pins |
|---|---|---|---|---|
| addPeerRow | builds one collapsible peer editor row (label, destination, port, folder, write-only token) from a stored peer | `#peers-list` | updatePeerDestBadge, peerTestAndSetUp | unpinned |
| peerTestAndSetUp | per-row Test & Set Up: classifies the destination and for ssh probes the port, offering Install when idle | row status | window.api.peerProbe, peerRunDeploy | deploy-visible.test.js peer-fix-working-line.test.js |
| peerRunDeploy | runs the ssh installer and renders its progress markers as a live step list and a sudo tail | row status | window.api.peerDeploy, appendDeployActions | unpinned |
| appendDeployActions | after a failed deploy, adds "Fix with an agent…" (when a log exists) and Re-test buttons | row status | peerTestAndSetUp | deploy-visible.test.js peer-fix-working-line.test.js |
| collectPeers | turns every peer row back into a settings peer record, validating and applying the write-only token rules | none | validatePeerRowInputs, peerCloudDest | stores.test.js |
| renderPeersImport | renders the clodexctl-context import preview and runs the chosen import | `#peers-import-box` | window.api.peerImportApply | unpinned |
| openPeersDialog | loads settings and opens the Peers dialog with one collapsed row per non-box peer | `#peers-overlay` | boxPeerIds, addPeerRow | unpinned |

### Invariants
- `openPeersDialog` keeps sandbox box peers out of the editable list, using `boxPeerIds`.
- `collectPeers` carries through the cloud fields that have no input, so a save does not strip them.
- The token field is write-only: `addPeerRow` never shows a stored token and `collectPeers` keeps it unless the field is filled or the clear box is ticked.

### Hazards
- `peerTestAndSetUp` renders any unrecognised result kind through its ssh-fail arm.
- The live peer runtime (tabs, control, detach) is `peers-ui.js`, not this dialog; `openPeersDialog` only edits settings.

## Plugins dialog — showPluginsRegisterNote … openPluginsSourceUpdate

| symbol | purpose | state | calls | pins |
|---|---|---|---|---|
| closePluginsDialog | hides the dialog and nulls `pluginsUpdateRefresh` so an in-flight refresh cannot repaint it | `pluginsUpdateRefresh` | closePluginReadmePopover | dialog-escape-parity.test.js plugin-readme-popover.test.js plugin-source-dialog.test.js |
| openPluginsDialog | clears the note, closes the library and source sections, arms a refresh token and renders the list | `pluginsUpdateRefresh` | renderPluginsDialog | plugin-readme-popover.test.js plugin-source-dialog.test.js |
| renderPluginsDialog | rebuilds the plugin list from `plugins.status` plus cached update availability and wires every row action | `#plugins-list` | makePluginSettingsPanel, openPluginsSourceUpdate | free-identifier-leaks.test.js plugin-source-dialog.test.js plugin-update-badge.test.js |
| makePluginSettingsPanel | builds a plugin's inline settings panel and its Settings toggle | row DOM | window.api.pluginInvoke | plugin-source-dialog.test.js plugin-update-badge.test.js plugins-dialog-fits.test.js |
| showPluginsFolderListing | web substitute for revealing the plugins folder: shows the engine host's path and listing | `#plugins-folder` | window.api.pluginInvoke | unpinned |
| paintPluginsLibrary | renders the library catalog as rows, each with one Install or Update button | `#plugins-library-list` | lib/plugin-source-dialog.libraryRowAction, installFromLibrary | plugin-source-dialog.test.js |
| installFromLibrary | installs one library row from source, refreshes the list and marks the row installed | `pluginsLibraryCatalog` | window.api.pluginInvoke, renderPluginsDialog | plugin-source-dialog.test.js |
| openPluginsSourceUpdate | turns the source section into update mode for one plugin and previews what would change | `pluginsSourceMode`, `pluginsSourceTarget` | paintPluginsSourceInstall | plugin-loader-source.test.js plugin-source-dialog.test.js plugin-update-badge.test.js |

### Invariants
- `renderPluginsDialog` reads `plugins.status`, not the catalog, because the catalog excludes the broken plugin the operator came to fix.
- `installFromLibrary` mutates a row after its await only while the section is visible and the catalog is unchanged.

### Hazards
- `showPluginsFolderListing` is a different action on web, not a degraded one: revealing a folder there would open the browser machine's folder, not the engine's.

## Sandbox dialog — renderSandboxNotice … saveSandboxConfig

| symbol | purpose | state | calls | pins |
|---|---|---|---|---|
| applyActionGate | applies the docker gate and foreign-owner notice to the Start-Stop, Rebuild and Create-box controls | control disabled state | lib/sandbox-view.sandboxActionGate | sandbox-view.test.js |
| refreshSandboxStatus | the 3 s poll re-reading docker detection and the current box's status and repainting the dialog | `sbRunning` | applySandboxRunning, applyActionGate | sandbox-view.test.js |
| renderBoxList | rebuilds the box list with status dot and per-row Start or Stop | `#sandbox-box-list` | toggleBox | sandbox-view.test.js |
| toggleBox | a row's Start or Stop for any box, serialised through `sbBusy` | `sbBusy` | window.api.sandboxUp, window.api.sandboxDown, renderBoxList | sandbox-view.test.js |
| openSandboxDialog | lists boxes, picks the current one, loads detail and list, shows the overlay and starts the poll | current box | loadBoxDetail, renderBoxList | unpinned |

### Invariants
- `refreshSandboxStatus` updates `sbRunning` before `applyActionGate`, because the gate's Start-versus-Stop choice reads it.
- `collectSandboxConfig` omits ports on purpose; `saveSandboxConfig` returns false with a toast on rejection.

### Hazards
- `applySandboxRunning` puts the box URL in `title`, never in `href`.

## Preferences, setup and Edit args — prefsGroups … closeArgsDialog

| symbol | purpose | state | calls | pins |
|---|---|---|---|---|
| applyPrefsGate | disables the context-hint checkboxes the prefs gate forbids and shows each reason | checkbox state | lib/prefs-gate.prefsGate | prefs-gate.test.js |
| collectPrefsSkillDefaults | rebuilds the default skill deny list, keeping entries the dialog could not toggle and the keep-list form | none | collectSkillChecklist | optimized-late-skills.test.js |
| openPrefs | loads settings once and populates every Preferences control, then shows the overlay and starts polls | `#prefs-overlay` | refreshPrefsEnv, refreshPrefsAccounts, applyPrefsGate | intent-spill-pref.test.js prefs-gate.test.js prefs-groups.test.js |
| openHelp | forwards an open-help request to the help panel, normalising empty name and slug to null | none | openHelpPanel | help-panel.test.js |
| argsSeat | the seat descriptor the bundle-aware checklists render against in the Edit args dialog | none | none | args-dialog-team-append.test.js plugin-bundle-checklist.test.js |
| openArgsDialog | opens the per-seat Edit args dialog, filling every section from local persistence or a peer args source | `argsEditingName`, `argsEditingSource` | argsSeat, lib/checklists render functions | args-dialog-team-append.test.js cli-adapters.test.js effort-options.test.js |
| closeArgsDialog | hides the Edit args dialog and clears the editing name and source | `argsEditingName`, `argsEditingSource` | none | cli-adapters.test.js dialog-escape-parity.test.js effort-options.test.js |

### Invariants
- `openArgsDialog` hides the plugins and exec sections on a peer row, because the peer save omits those keys and a drawn section would discard an untick.
- On save, a hidden section sends undefined (untouched), never an empty list; `openArgsDialog` locally owns env, so an empty env box is a real clear.
- A peer save from `openArgsDialog` never carries exec commands, so a peer edit cannot clear the box's grants.

### Hazards
- The Save handler reads `argsEditingName` and `argsEditingSource` into locals before `closeArgsDialog` clears them; reordering loses the target.
- A restarted seat is rebuilt through `rebuildLiveRow` from a snapshot taken before the save, so the wire-off flag and fix chip survive; a direct `addSessionToSidebar` call there would drop them.

## Restore IIFE and moved-in seats — mountRestoredSession … maybeDiscoverOnStartup

| symbol | purpose | state | calls | pins |
|---|---|---|---|---|
| mountRestoredSession | mounts one live seat from a restore or moved-in snapshot, copying badges and replaying buffered output | `sessions`, `sidebarMeta`, `ctxPct`, `proxyState` | createTerminal, addSessionToSidebar, applyPendingBadge | exited-seat-row.test.js restore-fit.test.js session-move-workspace.test.js |
| restoreSessions | startup IIFE: waits for WebGL, routes each restored entry to a row builder, then switches to the remembered seat | `activeSession` | mountRestoredSession, initSidebarView, switchSession | exited-seat-row.test.js restore-active-tab.test.js restore-fit.test.js |
| maybeFirstRunSetup | opens the first-run setup dialog in the focused window when setup is not done | none | openSetupDialog | first-run-setup.test.js |
| maybeDiscoverOnStartup | startup IIFE: when enabled and focused, shows the discovery overlay if on-disk sessions exist | none | maybeFirstRunSetup, renderDiscovery | first-run-setup.test.js |

### Invariants
- `restoreSessions` and the anonymous `onSessionMovedIn` handler share `mountRestoredSession`, so a moved-in live seat mounts exactly like a restored one.
- `restoreSessions` calls `initSidebarView` on every path, including an empty workspace, and always tags the body `sessions-restored`.
- `maybeDiscoverOnStartup` re-checks window focus after its settle delay, because every workspace window runs the same script.

### Hazards
- `mountRestoredSession` must `markSeatIo` before `createTerminal`, or a stream seat mounts as an xterm.
- The anonymous `onSessionMovedOut` handler calls `removeSession` with `keepPersisted`; without it a peer seat is detached and the seat's io kind is forgotten.

## EXEMPT
