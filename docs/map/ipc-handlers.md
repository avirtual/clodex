# ipc-handlers.js

## Module helpers, the registrar and session mint — envLockedSettings … handle:session:create

| symbol | purpose | state | calls | pins |
|---|---|---|---|---|
| `envLockedSettings` | map of settings keys whose value an env var pins (remotePort, remoteBasePath), so Preferences can show them locked | process.env | service-ports.coercePort, remote.coerceRemoteBasePath | remote-base-path-pref.test.js |
| `recentCwdsFor` | recent cwds for one workspace, falling back to the legacy flat list for the default workspace | ui-settings recentCwdsByWorkspace | none | unpinned |
| `registerIpcHandlers` | registers every channel on the injected handle/on seams; the single entry the Electron host and web-host both call | deps (manager, persistence, stores, seams) | handle, on | drawer-services-seam.test.js plugin-kill-switch.test.js transcript-pull-outbox.test.js |
| `refreshMenusAfterWrite` | rebuilds app/tray menus after a landed write, logging instead of throwing so the write still reports ok | none | refreshAppMenu, refreshTrayMenu | unpinned |
| `spawnFromParams` | the mint front door: refuses a live or persisted name clash, seeds deny lists and strip level, then creates the session | sessions via manager, persistence strip level | session-manager.nameConflict, manager.create, agentDefaults | session-manager.test.js teams-menu.test.js create-mint-census.test.js |
| `handle:session:create` | {ok, session} for a new seat in the sender's workspace, or {ok:false,error} | sessions via manager | spawnFromParams | api-shim.test.js drawer-services-seam.test.js plugin-template-spawn.test.js |

### Invariants
- `spawnFromParams` is the one mint door every OPERATOR create transport (session:create, team:create, team:join) funnels through, and refuses a name held by a live OR a persisted record.
- `handle:session:create` registers with `handle`, so the renderer awaits an {ok, session} or {ok:false, error} reply rather than a thrown rejection.
- `registerIpcHandlers` must not require electron: every native touch (dialogs, popupMenu, openExternal) arrives as an injected dep, which is what lets web-host register the same channels.
- `spawnFromParams` stamps the workspace from `workspaceOfSender`, never from a renderer-supplied id.

### Hazards
- Routing a resume path (restore, unarchive, restart) through `spawnFromParams` makes it refuse its own persisted name; those call manager.create directly.
- Adding an electron require to `registerIpcHandlers` breaks the web-host, which calls the same registrar over its WebSocket transport.
- `refreshMenusAfterWrite` swallows a menu rebuild failure on purpose; letting it throw would report a landed write as failed and the retry hits already-exists.

## Team manifest channels — handle:team:create … handle:team:rolePrompts

| symbol | purpose | state | calls | pins |
|---|---|---|---|---|
| `handle:team:create` | writes the team manifest, then spawns its lead seat; {ok:false} if the write refuses, menu refreshed on any landed write | team.json, sessions via manager | createTeam, spawnFromParams, refreshAppMenu | teams-menu.test.js team-frontdoor-seam.test.js create-mint-census.test.js |
| `createBareTeamBox` | creates (or reuses) the team-<name> sandbox box and brings it up with the team root as workDir, returning webUrl and log lines | sandbox manager boxes | manager._bringUpTeamBox | unpinned |
| `handle:team:createBare` | writes a team manifest with no seat (lead defaults to <team>-lead), optionally building its sandbox box | team.json, sandbox boxes | createTeam, team-manifest.defaultLeadSeat, createBareTeamBox | teams-menu.test.js create-mint-census.test.js session-manager.test.js |
| `handle:team:join` | spawns a seat into an existing role, minting only an absent role, refusing roles that dispatch per ticket | team.json roles, sessions via manager | loadManifest, addRole, spawnFromParams | team-frontdoor-seam.test.js team-hand-template-portable.test.js team-role-template-copy.test.js |
| `accountPatchError` | the account-label refusal for a role def or patch that names an unknown account, or null | none (reads accounts) | accounts.resolveAccountLabel | unpinned |
| `handle:team:setRole` | patches one role's def as the operator and returns the saved team, refusing an unknown account label and a reviewer template whose system prompt is not clodex-team-reviewer* | team.json roles | accountPatchError, reviewerTemplateError, setRole, fmtPatch | team-frontdoor-seam.test.js ipc-handlers-team.test.js team-gather.test.js |
| `handle:team:removeRole` | removes a role (operator opt-in allows reviewer) unless a live seat or an open or in-loop ticket (by role or assignee) uses it, returning blockedBy | team.json roles | manager._roleInUse, removeRole | team-frontdoor-seam.test.js |
| `handle:team:deleteCheck` | what deleting the team would discard, for the confirm dialog | none | teamDeleteCheck | ipc-handlers-team.test.js |
| `handle:team:delete` | deletes the team through the gated deleter and rebuilds app and tray menus on success | team dir on disk | teamDeleteGated, refreshMenusAfterWrite | ipc-handlers-team.test.js |
| `handle:team:renameRole` | renames a role unless a seat or an open or in-loop ticket uses it | team.json roles | manager._roleInUse, renameRole | team-frontdoor-seam.test.js |
| `handle:team:gather` | collects the team's library files into its dir, with byte payloads stripped from the reply lists | team dir on disk | gatherTeam, stripBytes | team-gather.test.js team-uses.test.js |
| `handle:team:setWatchdog` | sets the team's watchdog interval and returns the saved team | team.json | setTeamWatchdog | team-frontdoor-seam.test.js |
| `handle:team:trunk` | the team's configured trunk, the repo-derived merge target and the effective one | team.json (read) | loadManifest, git-worktree.mergeTargetFor | unpinned |
| `handle:team:setTrunk` | sets or clears the trunk after checking the branch exists in the team root | team.json | git-worktree.localBranches, setTeamTrunk | unpinned |
| `handle:team:setLead` | re-points the manifest's top-level lead seat name (not a role edit) | team.json lead | setLead | team-frontdoor-seam.test.js |
| `handle:team:preflight` | the team's preflight findings table (missing templates, prompts, exec defs) with disk probes bound here | none (reads team dir, libraries) | team-preflight.teamPreflight, readTeamJson, execLibrary.raw | team-frontdoor-seam.test.js team-templates-exec.test.js team-prompt-dir.test.js |
| `handle:team:names` | every team name | none | listTeams | team-frontdoor-seam.test.js |
| `handle:team:forCwd` | the team (name, root) whose root contains a cwd, or nulls | none | resolveTeam | team-frontdoor-seam.test.js |
| `handle:team:get` | one team's manifest | team.json (read) | loadManifest | team-frontdoor-seam.test.js |
| `handle:team:stockRoles` | the stock role keys with their default dispatch | none | team-manifest.STOCK_ROLE_DEFS | team-frontdoor-seam.test.js |
| `handle:team:activity` | the team's live seats and ticket activity | sessions via manager | manager.teamActivity | ipc-handlers-team.test.js team-roles.test.js team-roles-popover-layout.test.js |
| `handle:team:addRole` | adds a role, substituting the stock def when an absent stock role arrives with an empty def | team.json roles | isEmptyDef, accountPatchError, addRole | team-frontdoor-seam.test.js ipc-handlers-team.test.js team-role-schema-legibility.test.js |
| `handle:team:rolePrompts` | the append-rail prompt offering, every system prompt, and the team-owned subset for the roles popover | none (reads prompt library, team dir) | prompt-rails.appendRailPrompts, listAllPrompts | team-prompt-save-ipc.test.js team-frontdoor-seam.test.js |

### Invariants
- `handle:team:create` writes the manifest before spawning, and refreshes the menu gated on the write, not on the spawn's result.
- `handle:team:join` adopts an existing role exactly as the team defines it and refuses a role whose dispatch is spawn or worktree, since the ticket loop mints those seats.
- `handle:team:addRole` substitutes the stock def only when the role is absent and the caller's def is empty, so the written def is never a blend.
- `handle:team:removeRole` and `handle:team:renameRole` refuse while `manager._roleInUse` reports a live seat or an open or in-loop ticket.
- `handle:team:createBare` forwards the root verbatim so createTeam's absolute-path refusal is the single gate.

### Hazards
- Moving the menu refresh inside the try of `handle:team:create` or `handle:team:createBare` turns a landed write into {ok:false} when the rebuild throws.
- Passing the operator opt-in from `handle:team:join` would let a join mint a reserved role such as reviewer.
- Caching the exec listing across calls in `handle:team:preflight` hides a file the operator installed after the last run.

## Worktrees, cwd suggestions and session lifecycle — handle:worktree:create … handle:session:setAutoCompact

| symbol | purpose | state | calls | pins |
|---|---|---|---|---|
| `handle:worktree:create` | creates a git worktree on a branch for the new-session dialog | git worktrees on disk | git-worktree.createWorktree | unpinned |
| `handle:worktree:info` | whether a cwd is a repo and its branches | none | git-worktree.repoInfo | unpinned |
| `handle:worktree:remove` | removes a worktree | git worktrees on disk | git-worktree.removeWorktree | workbench-plugin.test.js plugin-host-engine.test.js |
| `handle:session:cwdSuggestions` | recent and popular cwds, both scoped to the sender's workspace | ui-settings (read), sessions via manager | recentCwdsFor, manager.listForWorkspace | ipc-unscoped-listing.test.js |
| `handle:session:noteCwd` | records a cwd at the front of the sender workspace's recent list (max 12) | ui-settings recentCwdsByWorkspace | recentCwdsFor, uiSettings.set | ipc-unscoped-listing.test.js |
| `handle:session:markWorktree` | records the worktree a persisted session lives in | sessions.json via persistence | persistence.setWorktree | session-manager.test.js |
| `handle:session:list` | the sessions of the sender's workspace only | sessions via manager | manager.listForWorkspace, workspaceOfSender | drawer-services-seam.test.js deploy-visible.test.js ipc-unscoped-listing.test.js |
| `handle:session:reservedNames` | every live and persisted session name, global by design since names are keyed globally | none | persistence.list | new-session-name-validity.test.js |
| `handle:session:kill` | kills the seat and removes the worktree its record names | sessions via manager | manager.destroy | session-manager.test.js api-shim.test.js preserve-across-restart.test.js |
| `handle:session:move` | moves a session to a new cwd | sessions via manager | manager.move | unpinned |
| `handle:session:move-to-peer` | moves a session onto a peer host | sessions via manager | manager.moveToPeer | unpinned |
| `handle:session:move-to-workspace` | moves a session into another workspace | sessions via manager | manager.moveToWorkspace | unpinned |
| `handle:session:rename` | renames a session | sessions via manager | manager.rename | unpinned |
| `handle:session:scratch-mark` | places a labelled scratch mark at the current end of a Claude seat's turn, refused outside the sender's workspace | seat scratch marks via manager | manager.scratchMark | ipc-scratch-mark.test.js |
| `handle:session:flushPending` | delivers the seat's parked messages now | inject queue via manager | manager.flushPending | unpinned |
| `handle:session:peekPending` | the seat's parked messages without delivering them | inject queue via manager | manager.peekPendingFor | unpinned |
| `handle:session:resize` | resizes the seat's PTY | pty via manager | manager.resize | unpinned |
| `handle:session:setLabel` | stores a display label for the session | sessions.json via persistence | persistence.setLabel | unpinned |
| `handle:session:setAutoCompact` | toggles auto-compact for the session | sessions.json via persistence | persistence.setAutoCompact | unpinned |

### Invariants
- `handle:session:list` is workspace-scoped from the sender, and no handler in the registrar may call an unscoped manager list; ipc-unscoped-listing.test.js greps for it.
- `handle:session:cwdSuggestions` builds both lists from the sender's workspace, since popular cwds would leak other workspaces' paths.
- `handle:session:reservedNames` is deliberately global and returns names only, because session names share one namespace.
- `handle:session:kill` delegates to manager.destroy so the worktree cleanup has one implementation.

### Hazards
- web-host dispatches any registered channel by name, so a new lister added beside `handle:session:list` without the sender scope hands a workspace-bound connection every workspace.
- Scoping `handle:session:reservedNames` to one workspace would offer names that then fail to create.
- `handle:session:move-to-workspace` takes the target id from the renderer, so it is the one session verb that crosses the workspace boundary on purpose.

## App shell: directory dialog, updates, diagnostics, tool checks — handle:dialog:selectDirectory … handle:tools:invalidate

| symbol | purpose | state | calls | pins |
|---|---|---|---|---|
| `handle:dialog:selectDirectory` | the directory the operator picked in a native open dialog, or null on cancel | none | showOpenDialog | unpinned |
| `handle:update:check` | runs an update check now and returns its result | update info cache | checkForUpdate | unpinned |
| `handle:update:info` | the cached update info (latest version, url) | update info cache (read) | getUpdateInfo | unpinned |
| `handle:update:releases` | the cached releases list | releases cache (read) | getReleasesCache | unpinned |
| `handle:update:open` | opens the cached update's release url in the external browser | none | openExternal | unpinned |
| `handle:app:getVersion` | the app version string | none | getAppVersion | unpinned |
| `handle:diagnostics:get` | system diagnostics plus warning, summary and whether a missing CLI is the cause | none | collectSystemDiagnostics, diagWarning, diagSummary | unpinned |
| `handle:tools:check` | which external tools are installed, empty on failure | tool cache | checkTools | tool-gate.test.js |
| `handle:tools:invalidate` | drops the tool-check cache so the next check re-probes | tool cache | invalidateToolCache | unpinned |

### Invariants
- `handle:update:open` only opens the url of the update info main already fetched, never a renderer-supplied one.
- `handle:diagnostics:get` sets cliMissingIsCause only when the warning disappears with both CLIs marked present.

### Hazards
- `handle:dialog:selectDirectory` rides the injected showOpenDialog seam: on the web host that is a browser prompt whose answer counts only if it names a directory on the host.
- `handle:update:check`, `handle:update:info` and `handle:update:releases` are desktop-only in effect: web-host stubs checkForUpdate and answers null for the caches.
- `handle:tools:check` swallows a probe failure into an empty result, so an empty list does not prove no tools are installed.

## Libraries: templates, prompts, agents, skills, exec defs, notifications — handle:templates:list … handle:notifications:unreadCount

| symbol | purpose | state | calls | pins |
|---|---|---|---|---|
| `handle:templates:list` | every seat template, library and team-owned | templates store (read) | listAllTemplates | team-roles.test.js |
| `handle:templates:save` | saves a template and returns `{ok, templates}`; a store throw answers `{ok:false, error, templates}` | templates store | templates.save, refreshAppMenu | app-menus-plugins.test.js library-template-save-ipc.test.js |
| `handle:templates:saveByName` | saves a template keyed by name, returning it and the list; a store throw answers `{ok:false, error, templates}` | templates store | templates.saveByName, refreshAppMenu | app-menus-plugins.test.js library-template-save-ipc.test.js |
| `handle:templates:remove` | deletes a template and returns `{ok, templates}`; a refused name, or an id still listed after the store's remove (a swallowed EROFS in a box), answers `{ok:false, error, templates}` | templates store | templates.remove, refreshAppMenu | app-menus-plugins.test.js library-template-save-ipc.test.js |
| `handle:templates:saveTeam` | writes a template into a team's own dir | team templates dir | team-prompt-dir.teamTemplateSave, teamTemplateList | team-template-save-ipc.test.js team-file-intents.test.js |
| `handle:templates:removeTeam` | deletes a team-owned template | team templates dir | team-prompt-dir.teamTemplateRemove, teamTemplateList | team-template-save-ipc.test.js |
| `handle:templates:exportFromSession` | saves a persisted session's spawn config as a named template, writing opt-out fields only when set; a store throw answers `{ok:false, error, templates}` | templates store, sessions.json (read) | persistence.get, templates.saveByName | app-menus-plugins.test.js library-template-save-ipc.test.js |
| `handle:prompts:list` | the prompt library for a kind, team prompts included | prompt library (read) | listAllPrompts | library-prompt-cache.test.js |
| `handle:prompts:save` | saves a system or append prompt | prompt library | promptLibrary.save, refreshAppMenu | app-menus-plugins.test.js |
| `handle:prompts:remove` | deletes a prompt | prompt library | promptLibrary.remove, refreshAppMenu | app-menus-plugins.test.js |
| `handle:prompts:saveTeam` | writes a prompt into a team's own dir | team prompts dir | team-prompt-dir.teamPromptSave, teamPromptList | team-prompt-save-ipc.test.js |
| `handle:prompts:removeTeam` | deletes a team-owned prompt | team prompts dir | team-prompt-dir.teamPromptRemove, teamPromptList | team-prompt-save-ipc.test.js |
| `handle:agents:list` | the subagent library | agent library (read) | agentLibrary.list | unpinned |
| `handle:agents:get` | one subagent definition's raw text | agent library (read) | agentLibrary.raw | unpinned |
| `handle:agents:save` | saves a subagent definition | agent library | agentLibrary.save, refreshMenusAfterWrite | ipc-handlers-team.test.js |
| `handle:agents:remove` | deletes a subagent definition | agent library | agentLibrary.remove, refreshAppMenu | unpinned |
| `handle:skilllib:list` | the skill library | skill library (read) | skillLibrary.list | unpinned |
| `handle:skilllib:get` | one skill's raw text | skill library (read) | skillLibrary.raw | unpinned |
| `handle:skilllib:save` | saves a skill | skill library | skillLibrary.save, refreshMenusAfterWrite | ipc-handlers-team.test.js |
| `handle:skilllib:remove` | deletes a skill | skill library | skillLibrary.remove, refreshAppMenu | unpinned |
| `handle:exec:list` | every registered exec command def | exec library (read) | execLibrary.list | unpinned |
| `handle:exec:get` | one exec def's raw text | exec library (read) | execLibrary.raw | unpinned |
| `handle:exec:save` | validates and saves an exec def, refusing bad JSON or a def the dispatcher would refuse | exec library | exec-schema.validateExecDef, execLibrary.save | app-menus-plugins.test.js |
| `handle:exec:remove` | deletes an exec def | exec library | execLibrary.remove | app-menus-plugins.test.js |
| `handle:notifications:list` | the operator inbox | notifications store (read) | notifications.list | unpinned |
| `handle:notifications:page` | one page of the inbox | notifications store (read) | notifications.page | unpinned |
| `handle:notifications:markRead` | marks one inbox note read | notifications store | notifications.markRead | unpinned |
| `handle:notifications:markAllRead` | marks every inbox note read | notifications store | notifications.markAllRead | unpinned |
| `handle:notifications:remove` | deletes an inbox note | notifications store | notifications.remove | unpinned |
| `handle:notifications:unreadCount` | the unread inbox count | notifications store (read) | notifications.unreadCount | unpinned |

### Invariants
- `handle:exec:save` is operator-only by construction: no intent verb writes exec defs, so an agent cannot register or grant itself a command.
- `handle:exec:save` refuses any def `validateExecDef` rejects, so the library never holds a def the dispatcher would refuse at run time.
- `handle:templates:exportFromSession` writes intents, noWire, stripLevel and autoCompact only when the seat restricts them, so an all-default seat exports no such keys.
- `handle:agents:save` and `handle:skilllib:save` rebuild the menu through `refreshMenusAfterWrite`, so a failed rebuild cannot report the landed save as failed.

### Hazards
- Writing `intents: []` from `handle:templates:exportFromSession` for an all-enabled seat freezes every intent off onto the template.

## Seat reads, transcript and wire telemetry — handle:prompts:inject … handle:proxy:setStripLevel

| symbol | purpose | state | calls | pins |
|---|---|---|---|---|
| `handle:prompts:inject` | types a prompt body into a live seat | seat PTY via manager | manager._injectText | unpinned |
| `handle:session:draftOpen` | whether the seat has an unsent draft, false for an unknown or dead seat | none | proxy-util.isDraftOpen | spawn-focus-steal.test.js |
| `handle:transcript:pull` | the agent seat's transcript records since a rev, merged with compact notices, outbox and permission items | transcript spike reader | transcriptSpike.pull, compact-notices.mergeCompactNotices, manager.seatOutbox | transcript-pull-outbox.test.js web-host.test.js |
| `handle:proxy:snapshot` | the proxy poller's snapshot for a session, as a copy stamped with a host-relative ageMs | proxy poller (read) | proxyPoller.snapshot, proxy-util.stampServedAge | proxy-served-age.test.js |
| `handle:wire:quota` | the persisted account plan quota before any turn is forwarded | quota store via manager | manager.quotaStore, manager._quotaPayload | wire-quota-seam.test.js |
| `handle:proxy:context` | the proxy's context breakdown for a session | none | fetchProxyContext | unpinned |
| `handle:proxy:report` | the proxy's report for a session | none | fetchProxyReport | unpinned |
| `handle:proxy:bust` | asks the proxy to bust the session's cache | proxy session | fetchProxyBust | unpinned |
| `handle:proxy:subagentFeed` | rows of one subagent's wire feed after the caller's seq, cursor advancing to the store head | seat subagentStore (read) | subagent-ring.feedSince | unpinned |
| `handle:app:openExternal` | opens an http(s) url in the external browser; any other scheme is dropped | none | openExternal | unpinned |
| `handle:app:openWirescope` | opens the wirescope window on a url | none | openWirescopeWindow | unpinned |
| `handle:proxy:hold` | arms a proxy-side keep-warm hold, reporting armed vs skipped | proxy session | ProxyClient.hold, proxyPoller.snapshot | unpinned |
| `handle:wire:hold` | arms, arms perpetually or disarms in-process keep-warm and persists the deadline or always flag | sessions.json holdUntil and keepWarmAlways | manager._holdKeeper.arm, persistence.setHoldUntil, persistence.setKeepWarmAlways | wire-hold-ipc.test.js keepwarm-restart-preserve.test.js preserve-census.test.js |
| `handle:proxy:setStripLevel` | sets strip-thinking level 0-2 on the proxy after checking its capability, persisting it first | sessions.json stripLevel, agent defaults | ProxyClient.stripThinking, proxyPoller.noteStripAsserted | unpinned |

### Invariants
- `handle:app:openExternal` opens only http or https urls, so a renderer cannot launch a file or custom-scheme handler through it.
- `handle:wire:hold` keeps holdUntil and keepWarmAlways mutually exclusive, clearing one whenever it writes the other.
- `handle:proxy:hold` returns skipped separately from armed, so a declining 200 never reads as success.
- `handle:session:draftOpen` answers false for an unknown name rather than erroring, since the focus decision must not turn a miss into a refusal.

### Hazards
- Relaxing the scheme check in `handle:app:openExternal` hands the desktop renderer a way to open arbitrary local handlers; web-host forwards the url to the browser as an open-external event instead.
- `handle:proxy:setStripLevel` persists the level before the proxy call, so a failed call leaves the persisted level ahead of the proxy.
- `handle:app:openWirescope` opens a native window on the desktop only; web-host maps openWirescopeWindow to openExternal, so the browser gets a link instead.

## Session history, info panel, discovery and sidebar meta — handle:session:getArgs … handle:sidebar:meta

| symbol | purpose | state | calls | pins |
|---|---|---|---|---|
| `handle:session:getArgs` | the persisted spawn args of a session for the edit dialog | sessions.json (read) | readSessionArgs | unpinned |
| `claudeHistoryLayout` | locates a claude seat's transcript dir (via its registry link, else the project dir) and lists recent session files | none (reads ~/.claude projects) | clodex-paths.pathFor, claudeProjectDir | unpinned |
| `codexHistoryLayout` | locates a codex seat's CODEX_HOME and resolves rollouts by session id or by cwd since a cutoff | none (reads codex sessions dir) | seat-config.findCodexRollout, seat-config.codexRolloutsForCwd | unpinned |
| `handle:session:history` | the agent's past conversation ids with title and activity, tracked ids plus ones inferred from the last 7 days | sessions.json (read) | claudeHistoryLayout, codexHistoryLayout, readSessionMeta | session-history-codex.test.js |
| `handle:session:info` | the info panel payload, with the live wire ledger overlaid only when its session id and cost agree | sessions.json (read), wire telemetry | sessionInfo.collect, manager._wireTelemetry | session-info-live-overlay.test.js |
| `handle:discovery:scan` | adoptable agent sessions on disk and live untracked CLI processes, each disk row flagged liveInCwd | none | session-discovery.discoverAdoptable, session-discovery.discoverLiveProcesses | unpinned |
| `handle:sidebar:meta` | per-row sidebar meta (git, PR, team, archive stamps, plugin grants) for the sender workspace's sessions | sessions.json (read) | sessionMeta.metaFor, manager.teamNameFor, workspaceOfSender | meta-tiers.test.js plugin-host.test.js plugin-scope.test.js |

### Invariants
- `handle:sidebar:meta` lists only `persistence.listForWorkspace` of the sender's workspace, so meta never leaks another workspace's cwds.
- `handle:sidebar:meta` claims the record tier on each row, so an omitted pluginGrants key means none granted rather than unchanged.
- `handle:sidebar:meta` copies plugins whenever it is an array, since an empty array means no plugins and absence means all.
- `handle:session:info` overlays the live ledger only when the wire's session id matches the record and its cost is finite.

### Hazards
- Pushing onto the shared `_tiers` array in `handle:sidebar:meta` instead of copying re-tiers the whole batch, since metaFor freezes one instance.
- Dropping the finite-cost check in `handle:session:info` replaces a recorded spend with null and the lifetime total goes down.
- `handle:session:info` streams tens of MB of transcript per call, so wiring it into a poll would stall the main process.

## Archive, file peeks and plugin bundle writes — handle:session:archive … handle:plugins:writeBundleFile

| symbol | purpose | state | calls | pins |
|---|---|---|---|---|
| `handle:session:archive` | archives a live session: stamps it archived and kills its process | sessions.json via manager | manager.archive | unpinned |
| `handle:session:unarchive` | clears the archived stamp so the operator's respawn does not re-inherit it | sessions.json via persistence | persistence.setArchived | unpinned |
| `handle:session:files` | the files a session touched | none | fetchSessionFiles | unpinned |
| `handle:file:peek` | a file's contents for the peek viewer | none | fetchFilePeek | plugin-template-spawn.test.js |
| `handle:file:diff` | a file's git diff in the session's repo | none | fetchFileDiff | unpinned |
| `handle:file:write` | writes an edited peek back, confined to the session's cwd and guarded by the expected mtime | file on disk | writeFilePeek | unpinned |
| `handle:file:resolve` | whether a path-shaped string in a session's output names a real file, and its resolved path | none | resolveFilePath | unpinned |
| `handle:file:open` | opens a file with the OS default app | none | openPath | unpinned |
| `handle:file:reveal` | reveals a file in the OS file manager | none | showItemInFolder | unpinned |
| `handle:plugins:writeBundleFile` | writes a template or prompt file into a plugin's bundle | plugin bundle on disk | getPluginLoader, loader.writeBundleFile | plugin-template-spawn.test.js |

### Invariants
- `handle:file:write` takes a session name because the session's cwd is what confines the write; there is no nameless form.
- `handle:session:unarchive` clears the stamp before the operator's respawn upsert, which would otherwise re-inherit archivedAt.

### Hazards
- `handle:file:open` and `handle:file:reveal` act on the host desktop; web-host forwards them to the browser as open-path and show-item-in-folder events, so nothing opens on the host.
- `handle:file:peek` takes a bare path with no session scope, so any confinement lives in fetchFilePeek, not here.

## Per-seat tools, skills, agents, intents, voice and args — handle:session:setTools … handle:session:restart

| symbol | purpose | state | calls | pins |
|---|---|---|---|---|
| `handle:session:setTools` | stores the seat's disabled tools | sessions.json disabledTools | persistence.setDisabledTools | unpinned |
| `handle:session:setSkills` | stores the seat's disabled and injected skills | sessions.json skills | applySessionSkills | unpinned |
| `handle:session:setAgents` | stores the seat's subagents and denied builtins | sessions.json agents | persistence.setAgents | unpinned |
| `handle:session:setIntents` | stores the seat's intent allowlist, collapsed to the all-enabled default here; applies without restart | sessions.json intents | intent-registry.allowlistFromChecked, persistence.setIntents | intent-checklist-seam.test.js |
| `handle:session:agentCatalog` | the subagents visible to a seat, which are enabled and the denied builtins | sessions.json (read), agent library | agentLibrary.listFor, sessionScopeCtx | unpinned |
| `handle:session:skillCatalog` | the skills visible to a seat | none | readSkillCatalog | codex-skills-popover.test.js default-skill-catalog.test.js |
| `handle:settings:skillCatalogFor` | the skills visible for a cwd and agent type before any seat exists | none | readSkillCatalog | default-skill-catalog.test.js optimized-late-skills.test.js template-editor-deny-roundtrip.test.js |
| `handle:settings:voiceMode` | the voice mode of a seat (or the focused one), the trigger and whether the host can record | none | manager.voiceModeFor, readVoiceTrigger, readVoiceCapability | voice-trigger-ipc.test.js voice-core.test.js |
| `handle:settings:setVoiceMode` | sets the voice mode globally or for one seat | voice mode via manager | manager.voiceMode | unpinned |
| `handle:session:setVoice` | sets one seat's voice mode | voice mode via manager | manager.setVoice | unpinned |
| `handle:settings:toolCatalogFor` | the effective tool overrides for a cwd | none | readEffectiveToolState | template-editor-deny-roundtrip.test.js |
| `handle:session:setArgs` | rewrites a seat's spawn config, optionally restarting it, in the sender's workspace | sessions.json via applySessionArgs | applySessionArgs, workspaceOfSender | api-shim.test.js plugin-scope.test.js resume-cwd-tree-fallback.test.js |
| `handle:session:restart` | restarts a seat in the sender's workspace | sessions via manager | restartSession, workspaceOfSender | unpinned |

### Invariants
- `handle:session:setIntents` collapses the checked set to the allowlist in main, because only the engine knows the live intent rows.
- `handle:session:setArgs` and `handle:session:restart` pass the sender's workspace, so a restart cannot land a seat in another workspace.

### Hazards
- Collapsing intents in the renderer instead of `handle:session:setIntents` freezes today's row set onto the seat and hides every intent added later.
- `handle:session:setTools` and `handle:session:setAgents` refuse a name with no persisted record, so they cannot pre-seed a seat that does not exist yet.

## Settings, setup, remote token, env scopes and accounts — handle:settings:get … handle:envDefaults:restore

| symbol | purpose | state | calls | pins |
|---|---|---|---|---|
| `handle:settings:get` | an explicit whitelist of ui-settings plus catalogs, defaults, env-locked keys and peers with tokens reduced to hasToken | ui-settings (read), agent defaults | envLockedSettings, listSpeakVoices, hasRemoteToken | peer-shell-grant.test.js remote-base-path-pref.test.js default-session-mode.test.js |
| `handle:setup:state` | the first-run setup marker | setup marker (read) | setupMarker.read | first-run-setup.test.js |
| `handle:setup:complete` | records the first-run choice (and default session mode unless skipped), throwing on an unknown choice | setup marker, ui-settings defaultSessionMode | stores.SETUP_CHOICES, setupMarker.write | first-run-setup.test.js |
| `handle:settings:set` | merges a settings patch and resyncs terminal reports, status scripts, wirescope, remote server and peers | ui-settings | syncTerminalReports, rebuildAllStatusScripts, syncRemoteServer, syncPeerManager | terminal-reports-pref.test.js default-session-mode.test.js |
| `handle:remote:status` | whether the remote server runs, its port and last error | ui-settings (read) | getRemoteServer, getRemoteError | unpinned |
| `handle:remote:setToken` | sets or clears the operator wire token and rebuilds the server gate, returning only hasToken | remote token file | setRemoteToken, refreshRemoteToken | unpinned |
| `handle:envScopes:get` | a global or workspace env scope's vars, secrets returned as hasValue without the value | env scopes store (read) | envScopes.getScope | env-scopes-ipc.test.js |
| `handle:envScopes:set` | sets one var in a global or workspace scope, optionally secret | env scopes store | envScopes.set | env-scopes-ipc.test.js |
| `handle:envScopes:delete` | removes one var from a scope | env scopes store | envScopes.remove | env-scopes-ipc.test.js |
| `handle:accounts:list` | the configured Claude accounts | accounts store (read) | accounts.list | accounts-ipc.test.js drawer-services-seam.test.js |
| `handle:accounts:add` | adds an account (label, email, plan, configDir) | accounts store | accounts.add | accounts-ipc.test.js drawer-services-seam.test.js |
| `handle:accounts:remove` | removes an account by label | accounts store | accounts.remove | accounts-ipc.test.js drawer-services-seam.test.js |
| `handle:accounts:resync` | re-reads one account's config dir | accounts store | accounts.resync | accounts-ipc.test.js drawer-services-seam.test.js |
| `handle:accounts:move-by-model` | moves the sender workspace's seats on a model onto an account, reporting moved and skipped | sessions via moveAccountByModel | moveAccountByModel, workspaceOfSender | accounts-ipc.test.js drawer-services-seam.test.js accounts-move-reattach.test.js |
| `handle:envDefaults:get` | the shipped env defaults | env defaults store (read) | envDefaults.list | env-scopes-ipc.test.js |
| `handle:envDefaults:restore` | restores the shipped env defaults | env defaults store | envDefaults.restore | env-scopes-ipc.test.js |

### Invariants
- `handle:settings:get` is a whitelist, not a spread: a serving-side flag the renderer reads must be named there or it arrives undefined and reads as off.
- `handle:settings:get` never returns a peer token, only hasToken; the Peers dialog saves the array back and sanitizePeers carries the omitted token forward.
- `handle:remote:setToken` and `handle:envScopes:get` are write-only for secrets: no reply carries the token or a secret value.
- `handle:settings:set` reads terminalReports before the write, because the revocation sweep in `syncTerminalReports` needs the previous value.
- The accounts channels from `handle:accounts:list` to `handle:accounts:move-by-model` register only when enableAccounts is set, so a host without it has no such channels at all.

### Hazards
- Spreading ui-settings into `handle:settings:get` would ship every stored peer token to the renderer and to web clients.
- `handle:accounts:list` and the other accounts channels are desktop-only: web-host sets enableAccounts false, so they are absent there, not refused.
- Guarding `syncTerminalReports` with a typeof check in `handle:settings:set` makes an unwired revocation silently never sweep.

## Plugins, help corpus, intent catalog and plugin grants — pluginRefusal … handle:session:pluginGrants

| symbol | purpose | state | calls | pins |
|---|---|---|---|---|
| `pluginRefusal` | the shaped no-such-method envelope a missing plugin host answers with | none | plugin-api.errorEnvelope | unpinned |
| `handle:plugin:invoke` | one multiplexed call into a plugin method, carrying the caller surface | plugin host | host.dispatch, surfaceOfSender | plugin-surface-gate.test.js plugin-boundary.test.js plugin-kill-switch.test.js |
| `handle:plugin:catalog` | the plugin catalog, empty with no host | plugin host (read) | host.catalog | plugin-kill-switch.test.js plugin-fake.test.js |
| `handle:plugin:setEnabled` | enables or disables a plugin | plugin host | host.setEnabled | plugin-kill-switch.test.js |
| `handle:help:index` | the in-app help index | help corpus (read) | getHelpCorpus | ipc-handlers-help.test.js |
| `handle:help:page` | one help page's title and content | help corpus (read) | getHelpCorpus | ipc-handlers-help.test.js |
| `handle:intents:catalog` | the intent checklist rows for a seat's plugins, a live override, or the global set | sessions.json (read) | intent-registry.catalogRows | plugin-scope.test.js api-shim.test.js plugin-kill-switch.test.js |
| `handle:session:setPlugins` | stores a seat's plugin list (ids filtered) and prunes intents and grants that no longer apply | sessions.json plugins, intents, pluginGrants | plugin-api.isValidPluginId, intent-registry.pruneForPlugins | plugin-scope.test.js plugins-popover.test.js api-shim.test.js |
| `handle:session:setPluginGrants` | stores sanitized grants and drops verbs of revoked session-scoped plugins from the intent allowlist | sessions.json pluginGrants, intents | plugin-api.sanitizeGrants, intent-registry.pruneForPlugins | plugin-scope.test.js api-shim.test.js plugin-text-feed.test.js |
| `handle:session:pluginGrants` | the session-scoped plugins a seat can grant, the capability list, and what it has granted | sessions.json (read), plugin host | host.status, plugin-api.seatHasPlugin | plugin-scope.test.js api-shim.test.js |

### Invariants
- `handle:plugin:invoke` is one channel for every plugin because the injected transport has no removeHandler, so a per-plugin channel could never be disposed.
- `handle:plugin:invoke` passes `surfaceOfSender` per call, and an undefined surface is treated as untrusted rather than as the desktop.
- `handle:session:setPluginGrants` is a separate channel from `handle:session:setIntents`, so a checklist save that omits grants cannot revoke them.
- `handle:intents:catalog` reads the intent registry directly, not through the plugin host, so the checklist survives a missing host.

### Hazards
- Gating `handle:plugin:invoke` by registration absence, like the drawer services, would take plugins away from the web renderer entirely.
- Dropping the intent prune from `handle:session:setPluginGrants` leaves a seat firing verbs into a plugin it no longer holds a capability on.
- Listing global plugins in `handle:session:pluginGrants` invites the operator to withhold something that is not withheld.

## Peers: probe, deploy, import and remote seat control — handle:peer:probe … on:peer:input

| symbol | purpose | state | calls | pins |
|---|---|---|---|---|
| `handle:peer:probe` | what an ssh host answers on the remote port (kind plus detail), using a typed or saved token | ui-settings peers (read) | probePeer | unpinned |
| `handle:peer:deploy` | runs the deploy script on a peer over ssh, streaming lines to the sender, returning exit, timeout and needSudo | none (remote host) | sshRun, classifyDeployFolder | deploy-visible.test.js web-host.test.js |
| `handle:peer:deployFix` | spawns a local claude seat in the host's fix dir and briefs it with the failed deploy log | sessions via manager, fix dir on disk | manager.create, buildDeployFixBriefing, manager._deliverMessage | deploy-visible.test.js create-mint-census.test.js |
| `handle:peer:list` | every peer connection's status with its ssh and web tunnel status | none | getPeerManager, getTunnelManager, getWebTunnelManager | web-tunnel.test.js |
| `handle:peer:importPreview` | peer candidates from the contexts file, with the token-bearing peer field stripped | none (reads contexts file) | peer-import.loadContexts, peer-import.collectCandidates | unpinned |
| `handle:peer:importApply` | adds the chosen candidates to the peers list, reporting imported vs rejected | ui-settings peers | peer-import.applyCandidates, syncPeerManager | unpinned |
| `handle:peer:openWeb` | opens a peer's web UI through its tunnel | web tunnel | openPeerWeb | unpinned |
| `handle:peer:closeWeb` | closes a peer's web UI tunnel | web tunnel | closePeerWeb | unpinned |
| `handle:peer:attach` | attaches a far seat and remembers the attachment | ui-settings peerAttached | conn.attach | unpinned |
| `handle:peer:detach` | detaches a far seat and forgets its attach and control records | ui-settings peerAttached, peerControlled | conn.detach, forgetPeerAttached, forgetPeerControlled | unpinned |
| `handle:peer:attachedNames` | the remembered attachments per peer | ui-settings peerAttached (read) | none | unpinned |
| `handle:peer:forgetAttached` | forgets one remembered attachment | ui-settings peerAttached | forgetPeerAttached | unpinned |
| `handle:peer:setDisabled` | pauses or resumes a peer without deleting its attachments | ui-settings peers | manager._broadcast, syncPeerManager | peer-disable.test.js peer-shell-grant.test.js |
| `handle:peer:setRelayAllowed` | allows or disallows relaying through a peer | ui-settings peers | none | unpinned |
| `handle:peer:setShellAllowed` | the box-wide peer-terminal grant; revoking closes open far shells | ui-settings peerShellEnabled | manager._broadcast, syncRemoteServer | peer-shell-grant.test.js |
| `handle:peer:visible` | which far seats are visible per peer | ui-settings peerVisible (read) | none | unpinned |
| `handle:peer:setVisible` | sets or clears one peer's visible seat names (names validated) | ui-settings peerVisible | none | unpinned |
| `handle:peer:control` | takes or releases input control of a far seat and remembers it | ui-settings peerControlled | conn.control, rememberPeerControlled | unpinned |
| `handle:peer:controlledNames` | the remembered controlled seats per peer | ui-settings peerControlled (read) | none | unpinned |
| `handle:peer:forgetControlled` | forgets one controlled record | ui-settings peerControlled | forgetPeerControlled | unpinned |
| `handle:peer:resize` | resizes a far seat's terminal | none (far host) | conn.resize | unpinned |
| `handle:peer:restart` | restarts the far Clodex | none (far host) | conn.restart | unpinned |
| `handle:peer:createSession` | creates a seat on the far host | none (far host) | conn.createSession | unpinned |
| `handle:peer:catalogs` | the far host's catalogs for the new-session dialog | none (far host) | conn.getCatalogs | unpinned |
| `handle:peer:killSession` | kills a far seat | none (far host) | conn.killSession | unpinned |
| `handle:peer:restartSession` | restarts a far seat | none (far host) | conn.restartSession | unpinned |
| `handle:peer:sessionArgs` | a far seat's spawn args | none (far host) | conn.sessionArgs | unpinned |
| `handle:peer:setSessionArgs` | patches a far seat's spawn args | none (far host) | conn.setSessionArgs | unpinned |
| `handle:peer:skillCatalog` | a far seat's skill catalog | none (far host) | conn.skillCatalog | unpinned |
| `handle:peer:setSessionSkills` | sets a far seat's disabled and injected skills | none (far host) | conn.setSessionSkills | unpinned |
| `handle:peer:query` | a generic keyed read against a far seat | none (far host) | conn.query | unpinned |
| `on:peer:input` | fire-and-forget keystrokes into a far seat | none (far host) | conn.input | drawer-services-seam.test.js |

### Invariants
- `handle:peer:deploy` classifies the folder before any ssh, since that value becomes a remote shell word.
- `handle:peer:importPreview` strips the peer field from each candidate, so an imported token never round-trips through the renderer.
- `handle:peer:setDisabled` broadcasts before `syncPeerManager` and never forgets attachments, so re-enabling restores them.
- `handle:peer:setShellAllowed` takes no peer id and calls `syncRemoteServer`, which closes running far shells on revoke.
- `on:peer:input` uses `on`, not `handle`, so a keystroke never waits on a network reply.

### Hazards
- Dropping `syncRemoteServer` from `handle:peer:setShellAllowed` leaves a revocation on paper until the next restart.
- A per-line log inside `handle:peer:deploy` would bury the run; the drop is logged once on purpose.
- `handle:peer:setVisible` validates names against the seat grammar; loosening it lets a dot-only or path-shaped name into ui-settings.
- `handle:peer:deployFix` reaches create()'s fixFor by position (24 positionals); deploy-visible.test.js pins fixFor's index in create()'s declared signature to the index its create stub reads, so a parameter inserted before fixFor must move both.

## Peer terminals, drawer-gated — peerSeat … on:peer:wtermInput

| symbol | purpose | state | calls | pins |
|---|---|---|---|---|
| `peerSeat` | splits a composite name@peerId key into the peer connection and the bare far seat name | none | peer-shell.wireSeatFor, getPeerManager | unpinned |
| `wtermOwner` | the strict workspace id of the sender window that owns a far shell | none | workspaceOfSenderStrict | unpinned |
| `handle:peer:wtermOpen` | opens a far shell for a seat owned by the sender's workspace, refused with no workspace | far wterm streams | peerSeat, wtermOwner, conn.wtermOpen | drawer-services-seam.test.js |
| `handle:peer:wtermResize` | resizes a far shell | none (far host) | peerSeat, conn.wtermResize | drawer-services-seam.test.js |
| `handle:peer:wtermClose` | closes a far shell for its owner, refused on the same input as the open | far wterm streams | peerSeat, wtermOwner, conn.wtermClose | drawer-services-seam.test.js peer-shell-detach.test.js |
| `on:peer:wtermInput` | fire-and-forget keystrokes into a far shell | none (far host) | peerSeat, conn.wtermInput | drawer-services-seam.test.js |

### Invariants
- `handle:peer:wtermOpen` and its three siblings register only under enableDrawerServices, which the web host turns off, so the desktop is their only registrar.
- `peerSeat` is the one splitter of the composite key, so the name that reaches the wire is always bare.
- `handle:peer:wtermOpen` and `handle:peer:wtermClose` both refuse an unresolved sender through `wtermOwner`, never falling back to the default workspace.

### Hazards
- Resolving `wtermOwner` with the non-strict helper creates an owner no dropper ever matches, stranding the far shell.
- Passing an @-bearing name past `peerSeat` becomes null at the far side, which is the key of the seatless workspace shell.
- A host that leaves workspaceOfSenderStrict undefined turns `wtermOwner` and `wtermWorkspace` back into the loose helper with no error.

## Default deny lists, theme and wirescope — handle:defaults:setToolDeny … handle:wirescope:prune

| symbol | purpose | state | calls | pins |
|---|---|---|---|---|
| `handle:defaults:setToolDeny` | sets the default disabled-tools list new seats are seeded with, returning it | agent defaults | agentDefaults.setDefaultDeny | unpinned |
| `handle:defaults:setSkillDeny` | sets the default disabled-skills list | agent defaults | agentDefaults.setDefaultSkillDeny | default-set-seeding.test.js |
| `handle:defaults:setBuiltinDeny` | sets the default denied builtin subagents | agent defaults | agentDefaults.setDefaultBuiltinDeny | default-set-seeding.test.js |
| `handle:theme:set` | applies a UI theme to the sender's window | ui theme | setUiTheme | sender-token-contract.test.js |
| `handle:wirescope:status` | the bundled wirescope proxy's status | wirescope process (read) | wirescope.status | unpinned |
| `handle:wirescope:start` | starts the wirescope proxy | wirescope process | wirescope.start | unpinned |
| `handle:wirescope:stop` | stops the wirescope proxy | wirescope process | wirescope.stop | unpinned |
| `handle:wirescope:restart` | restarts the wirescope proxy | wirescope process | wirescope.restart | unpinned |
| `handle:wirescope:pruneInfo` | what a wirescope prune would remove | none | ProxyClient.pruneInfo | unpinned |
| `handle:wirescope:prune` | prunes wirescope captures older than a cutoff, refusing without olderThan | wirescope capture store | ProxyClient.prune | unpinned |

### Invariants
- `handle:defaults:setToolDeny` and its two siblings only change what `spawnFromParams` seeds a new seat with; existing seats keep their own lists.
- `handle:wirescope:prune` refuses without an olderThan cutoff, so an empty options object cannot prune everything.

### Hazards
- `handle:theme:set` reaches setUiTheme, which the web host stubs to a no-op, so a web client's theme change never lands main-side.

## Sandbox boxes — withBox … handle:sandbox:deleteBox

| symbol | purpose | state | calls | pins |
|---|---|---|---|---|
| `withBox` | runs a callback against one sandbox box, or a no-such-sandbox refusal | none | getSandbox | unpinned |
| `handle:sandbox:detect` | whether docker is usable, host-wide and not box-scoped | none | sandbox manager detect | engine-sandbox-seam.test.js |
| `handle:sandbox:self` | whether this engine runs inside a box, its label (CLODEX_BOX_LABEL or SELF_LABEL) for the login-expired banner, and whether the library templates dir is writable there | none | runningInSandboxBox, templates.dirWritable | engine-sandbox-seam.test.js |
| `handle:sandbox:status` | one box's status | box container (read) | withBox | unpinned |
| `handle:sandbox:openWeb` | opens a box's web UI with its token in the external browser | none | withBox, openExternal | sandbox-open-web.test.js |
| `handle:sandbox:getConfig` | one box's config | box config (read) | withBox | unpinned |
| `handle:sandbox:setConfig` | patches one box's config | box config | withBox | unpinned |
| `handle:sandbox:translatePath` | maps a host path into the box's filesystem | none | withBox | unpinned |
| `handle:sandbox:up` | brings a box up | box container | withBox | unpinned |
| `handle:sandbox:rebuild` | rebuilds a box's image and container | box container | withBox | unpinned |
| `handle:sandbox:down` | stops a box | box container | withBox | unpinned |
| `handle:sandbox:logsTail` | the last lines of a box's logs | none | withBox | unpinned |
| `handle:sandbox:setToken` | stores a box's Claude auth token, returning only hasToken | box auth token | withBox | unpinned |
| `handle:sandbox:clearToken` | clears a box's auth token | box auth token | withBox | unpinned |
| `handle:sandbox:listBoxes` | every sandbox box | sandbox manager (read) | getSandboxManager | engine-sandbox-seam.test.js |
| `handle:sandbox:createBox` | creates a box record | sandbox manager boxes | getSandboxManager | create-mint-census.test.js |
| `handle:sandbox:deleteBox` | deletes a box | sandbox manager boxes | getSandboxManager | unpinned |

### Invariants
- `handle:sandbox:detect` does not go through `withBox`, since deleting the last box leaves nothing to resolve and the dialog would misreport docker as missing.
- `handle:sandbox:setToken` lets the token cross in but never back out; the reply is a hasToken flag only.

### Hazards
- Routing `handle:sandbox:detect` through `withBox` renders "no such sandbox" as "Docker isn't installed".
- `handle:sandbox:openWeb` puts the box web token in the url it opens, so logging that url leaks the token.

## Markdown export and native context menus — handle:session:exportMarkdown … on:peer:header-menu

| symbol | purpose | state | calls | pins |
|---|---|---|---|---|
| `handle:session:exportMarkdown` | writes an agent seat's transcript as markdown to a path chosen in a save dialog | file on disk | showSaveDialog, jsonlToMarkdown | unpinned |
| `on:session:context-menu` | pops the session row menu; items answer on session:context-action or edit prompt refs in place | sessions.json prompt refs | popupMenu, persistence.setPromptRefs, movePeerItem, moveWorkspaceItem | session-move.test.js api-shim.test.js ipc-scratch-mark.test.js |
| `on:peer:context-menu` | pops a far seat's menu; each item answers on peer:context-action | none | popupMenu | session-move.test.js |
| `deployTargetFor` | the ssh host, port and deploy folder for a peer, or null without an ssh host | ui-settings peers (read) | resolveDeployFolder, getPeerManager | unpinned |
| `handle:peer:deployConfig` | a peer's deploy target for the update flow | none | deployTargetFor | unpinned |
| `on:peer:header-menu` | pops a peer header's menu (new session, restart, rebuild, update, pause) answering on peer:context-action | none | popupMenu, deployTargetFor, updateApplies | peer-header-menu.test.js |

### Invariants
- `on:session:context-menu` opens a Terminal only through the injected `openInTerminal`; web-host forwards it to the browser as an open-in-terminal event, so nothing opens on the host.
- `on:session:context-menu`, `on:peer:context-menu` and `on:peer:header-menu` are fire-and-forget, and every item answers by sending a context-action event back to the sender rather than a reply.
- `on:peer:header-menu` offers Pause offline as well as online, since the info popover only renders its pause for an online peer with a version.

### Hazards
- A desktop `openInTerminal` behind `on:session:context-menu` that uses exec instead of execFile with an argv routes an agent-supplied cwd through /bin/sh, where $(...) runs.
- `handle:session:exportMarkdown` writes wherever the save dialog answers; on the web host that is the exports dir, not the operator's desktop.

## Confirm dialogs — handle:dialog:confirmPeerRestart … handle:dialog:confirmKill

| symbol | purpose | state | calls | pins |
|---|---|---|---|---|
| `handle:dialog:confirmPeerRestart` | true if the operator confirms restarting a peer's Clodex | none | showMessageBox | unpinned |
| `handle:dialog:confirmPeerUpdate` | true if the operator confirms re-running the deploy script on a peer | none | showMessageBox | unpinned |
| `handle:dialog:confirmDeployFix` | true if the operator confirms opening a deploy-fix agent seat | none | showMessageBox | unpinned |
| `handle:dialog:confirmPeerKill` | true if the operator confirms killing a far seat | none | showMessageBox | unpinned |
| `handle:dialog:confirmPeerReload` | true if the operator confirms a fresh-conversation reload of a far seat | none | showMessageBox | unpinned |
| `handle:dialog:confirmKill` | true if the operator confirms deleting a session, warning when it will remove a worktree | sessions.json (read) | showMessageBox, persistence.get | unpinned |

### Invariants
- `handle:dialog:confirmPeerRestart` and every sibling confirm default to and cancel on Cancel, so a dismissed dialog answers false.
- `handle:dialog:confirmKill` names the worktree branch and path when the record carries one, since delete runs a forced worktree remove.

### Hazards
- Changing defaultId in `handle:dialog:confirmKill` makes Enter delete a session whose conversation cannot be resumed.

## Seat input, stream-seat controls and voice reports — on:pty-input … on:session:focused

| symbol | purpose | state | calls | pins |
|---|---|---|---|---|
| `on:pty-input` | fire-and-forget keystrokes into a local seat's PTY | pty via manager | manager.write | api-shim.test.js |
| `handle:seat:send` | sends a stream seat a turn with validated images; desktop surface and sender workspace only | stream seat via manager | validateSeatImages, manager.seatSend | seat-send-images.test.js |
| `handle:seat:image-upload` | writes validated images for an agent seat in the sender's workspace, returning their paths | seat image files | validateSeatImages, manager._writeImageFiles | api-shim.test.js seat-image-upload.test.js |
| `handle:seat:commands` | a stream seat's slash commands; desktop only | none | manager.seatCommands | transcript-pull-outbox.test.js |
| `handle:seat:control` | sends a stream seat a control subcommand; desktop only | stream seat via manager | manager.seatControl | transcript-pull-outbox.test.js |
| `handle:seat:permission` | answers a stream seat's permission prompt; desktop only | stream seat via manager | manager.seatPermission | transcript-pull-outbox.test.js renderer-source-pins.test.js |
| `handle:seat:interrupt` | interrupts a stream seat's turn; desktop only | stream seat via manager | manager.seatInterrupt | transcript-pull-outbox.test.js |
| `on:seat:draft` | reports a stream seat's composer draft; desktop only, dropped otherwise | seat draft via manager | manager.seatDraft | session-manager.test.js |
| `handle:voice:record` | starts, stops or toggles recording for a seat in the sender's workspace | voice recorder via manager | manager.voiceRecord | voice-engine.test.js |
| `on:log:voice` | appends one bounded voice log line | log | log.info | unpinned |
| `on:voice:markOrigin` | arms the voice-origin hint for a seat's next submit | voice origin via manager | manager.markVoiceOrigin | unpinned |
| `on:voice:unmarkOrigin` | withdraws the armed voice-origin hint | voice origin via manager | manager.unmarkVoiceOrigin | unpinned |
| `on:voice:recording` | reports the recorder lit on a seat, stamped by main's clock | voice state via manager | manager.noteVoiceRecording | speaking-defers-inject.test.js |
| `on:voice:draft` | reports a dictated unsent draft on a seat, stamped by main's clock | voice state via manager | manager.noteVoiceDraft | unpinned |
| `on:session:focused` | records the seat the operator is looking at, with the strictly resolved sender window | focused seat via manager | manager.noteFocusedSession, manager.windowForWorkspace | external-tap-trigger.test.js |

### Invariants
- `handle:seat:send`, `handle:seat:commands`, `handle:seat:control`, `handle:seat:permission`, `handle:seat:interrupt` and `on:seat:draft` refuse unless `surfaceOfSender` answers desktop, and every one also checks the seat is in the sender's workspace; `handle:seat:image-upload` drops only the surface gate — it keeps the workspace and agent-type checks — because the web shim uploads through it.
- `on:voice:markOrigin` and `on:voice:unmarkOrigin` carry no text or id, so a doctored payload cannot choose what the agent is told or which hint is cleared.
- `on:voice:recording` and `on:voice:draft` carry no timestamp; main stamps its own clock so a renderer cannot hold injection open.
- `on:session:focused` resolves the sender strictly, so a dying window's last report maps to no window instead of the default workspace's.

### Hazards
- `on:pty-input`, `on:voice:markOrigin`, `on:voice:unmarkOrigin`, `on:voice:recording`, `on:voice:draft`, `handle:console:read` and `handle:console:live`, like `handle:prompts:inject`, take any seat name with no workspace check; the seat:* handlers and `handle:voice:record` check it.
- Resolving `on:session:focused` with the loose helper lets a closing window move the microphone of whatever window holds the default workspace.

## Restore, retry, forget and workspaces — handle:app:restore-sessions … handle:workspace:setName

| symbol | purpose | state | calls | pins |
|---|---|---|---|---|
| `handle:app:restore-sessions` | restores the persisted sessions of the sender's workspace | sessions via manager | restoreSessionsForWorkspace | session-restore.test.js |
| `handle:session:retrySpawn` | re-spawns a persisted record (not a mint) in the sender's workspace, returning its io | sessions via manager | manager.create, manager.resumeCwdOf | resume-cwd-tree-fallback.test.js exited-seat-row.test.js renderer-source-pins.test.js |
| `handle:session:forget` | drops a session record and kills its workbench shell | sessions.json, drawer ptys | persistence.remove, manager.clearHintForRecord | session-forget-ipc.test.js peer-shell-attached.test.js session-manager.test.js |
| `handle:workspace:list` | every workspace | workspaces.json (read) | workspaces.list | unpinned |
| `handle:workspace:current` | the sender's workspace id | none | workspaceOfSender | unpinned |
| `handle:workspace:getView` | the sender workspace's saved view | workspaces.json (read) | workspaces.get | unpinned |
| `handle:workspace:setView` | saves the sender workspace's view | workspaces.json | workspaces.setView | stores.test.js |
| `handle:workspace:setName` | renames the sender's workspace and rescopes workspace-scoped library files | workspaces.json, library files | workspaces.setName, renameWorkspaceScope | unpinned |

### Invariants
- `handle:session:retrySpawn` calls manager.create with mint false, because a retry re-spawns an existing record and must not hit the mint name check.
- `handle:workspace:setName` rewrites workspace-scoped skills and agents in the same motion, since they key off the display name.
- `handle:session:forget` kills the seat's workbench shell itself, since nothing else reaps it.

### Hazards
- Routing `handle:session:retrySpawn` through `spawnFromParams` refuses the retry as a clash with its own persisted record.
- `handle:workspace:setView` and `handle:workspace:setName` act on the sender's workspace, so taking an id argument instead would let a web connection edit another workspace.
- `handle:session:retrySpawn` finds the record by name alone and spawns it into the sender's workspace, so a retry naming another workspace's record rehomes it (create's upsert rewrites `workspaceId`).
- `handle:session:forget` reaps the drawer shell only in the sender's workspace, so a forget naming another workspace's seat drops the record and orphans that seat's shell.

## Gated services: ctl, drawer, console, local terminal, new workspace — handle:ctl:run … handle:workspace:new

| symbol | purpose | state | calls | pins |
|---|---|---|---|---|
| `handle:ctl:run` | runs one clodexctl line, returning output and exit code | none | getCtlService, svc.run | drawer-services-seam.test.js |
| `handle:ctl:context` | the ctl tab's context | none | svc.context | drawer-services-seam.test.js |
| `handle:ctl:help` | the ctl tab's cheat sheet | none | svc.helpIndex | drawer-services-seam.test.js |
| `handle:drawer:armSelection` | arms the drawer selection as a tail hint on a seat's next request, text capped at 64 KiB | seat route hints via manager | manager.armSelection | drawer-services-seam.test.js |
| `handle:drawer:inspectSelection` | the armed selection for a seat | none | manager.inspectSelection | unpinned |
| `handle:drawer:releaseSelection` | releases the armed selection | seat route hints via manager | manager.releaseSelection | drawer-services-seam.test.js |
| `handle:console:read` | a bash seat's console records since a cursor, with name and cursor validated | none (reads registry console) | bash-console.readBashConsole | drawer-services-seam.test.js bash-console.test.js |
| `handle:console:live` | a bash seat's live console lines | none | getBashLive | drawer-services-seam.test.js |
| `wtermWorkspace` | the strict workspace id of the sender for local drawer terminals | none | workspaceOfSenderStrict | unpinned |
| `seatOf` | a seat key validated to the name grammar, or null | none | none | peer-shell.test.js peer-shell-detach.test.js |
| `handle:wterm:spawn` | spawns a local drawer shell for the sender's workspace and a seat | drawer ptys | getDrawerPtys, wtermWorkspace, seatOf | drawer-services-seam.test.js |
| `handle:wterm:write` | writes into a local drawer shell | drawer ptys | wtermWorkspace, seatOf | drawer-services-seam.test.js |
| `handle:wterm:resize` | resizes a local drawer shell | drawer ptys | wtermWorkspace, seatOf | drawer-services-seam.test.js |
| `handle:workspace:new` | persists a new workspace record, opens its window and returns the id | workspaces.json | workspaces.upsert, createWindow | workspace-new.test.js |

### Invariants
- The drawer channels from `handle:drawer:armSelection` to `handle:drawer:releaseSelection` are gated at registration by enableDrawerServices, which web-host sets false, because a registered channel is reachable by name.
- `handle:wterm:spawn` sits under enableLocalTerminal, not the drawer gate, because `handle:session:create` already hands a web client a shell on this box.
- `wtermWorkspace` resolves strictly and the wterm handlers refuse an unresolved sender, so a closing window's keystroke never lands in another workspace's shell.
- `handle:workspace:new` upserts the record itself, since the web host stubs createWindow.

### Hazards
- Converting the enableDrawerServices gate into a body check turns `handle:drawer:armSelection` into a prompt-injection channel for any web connection.
- Taking the workspace from the payload in `handle:wterm:write` would let a connection type into another workspace's shell; only `seatOf` comes from the payload.

## EXEMPT
