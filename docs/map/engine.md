# engine.js

## Host contract: createEngine's argument, its seams, the module exports — diagWarning … createEngine

| symbol | purpose | state | calls | pins |
|---|---|---|---|---|
| `createEngine` | builds the whole electron-free module graph from `{ userDataPath, seams, log }` and returns the flat engine handle a host adapter drives | every engine singleton (closure) | resolveRegistryDir, session-manager.createSessionManager, stores.initStores, shutdown | engine-registry-dir-seam.test.js drawer-services-seam.test.js engine-sandbox-seam.test.js |
| `resolveRegistryDir` | the `~/.clodex` root: `seams.registryDir` if given, a throw under `node --test`, else `defaultClodexHome()` | none (pure; reads NODE_TEST_CONTEXT) | clodex-paths.defaultClodexHome | engine-registry-dir-seam.test.js |
| `resolveSelfLabel` | this box's peer wire label: a trimmed `CLODEX_LABEL` that `validOrigin` accepts, else the hostname minus `.local` | none (pure) | peer-outbox.validOrigin | instance-label.test.js |
| `diagWarning` | the single highest-priority startup banner text for a diagnostics object, or null | none (pure) | none | diag-tools.test.js |
| `diagLines` | the diagnostics object rendered as the console block, ending with the `diagWarning` text | none (pure) | diagWarning | deploy-visible.test.js |

What a host passes. `createEngine` destructures exactly three names from its
argument — `userDataPath`, `seams`, `log` — and reads every seam as its own
`const` with a default, so a host omits what it lacks. `—` means the host does
not pass it and gets the default.

```
name                      main.js (Electron)                 headless-main.js                        default when omitted
userDataPath              app.getPath('userData')            CLODEX_DATA_DIR or platform default     (required)
log                       the main-process log               the headless log                        (required)
seams.openPath            shell.openPath                     log-only no-op                          no-op
seams.openExternal        shell.openExternal                 —                                       logs the URL minus query/hash
seams.notifyOS            new Notification(opts).show()      log line                                no-op
seams.setAppQuitting      sets main's appQuitting            sets headless appQuitting               no-op
seams.appVersion          app.getVersion()                   —                                       package.json version
seams.isPackaged          () => app.isPackaged               —                                       () => false
seams.pathMergeFailed     login-shell PATH merge outcome     same                                    false
seams.logFile             LOG_FILE                           LOG_FILE                                null
seams.refreshAppMenu      late-bound forwarder               —                                       no-op
seams.scheduleAppMenuRefresh  late-bound forwarder           —                                       no-op
seams.refreshTrayMenu     late-bound forwarder               —                                       no-op
seams.scheduleTrayRefresh late-bound forwarder               —                                       no-op
seams.restartHost         restartClodex()                    restartNow (exit 64)                    no-op
seams.restartHostWhenIdle idleWaiter.arm(...)                headlessRestart.restartHostWhenIdle     seams.restartHost
seams.restartUnavailable  —                                  headlessRestart.restartUnavailable      () => null
seams.enableSandbox       —                                  !runningInSandboxBox(env)               true
seams.enableDrawerServices —                                 —                                       true
seams.enableCtl           —                                  —                                       true
seams.enableLocalTerminal —                                  —                                       true
seams.enableConsole       —                                  —                                       true
seams.enableAccounts      —                                  —                                       true
seams.webInfo             —                                  () => webHost ? webHost.info : null     () => null
seams.registryDir         — (tests only)                     — (tests only)                          defaultClodexHome(); throws under node --test
seams.noSeed              — (tests only)                     — (tests only)                          false; true throws outside node --test
seams.skillLister         — (tests only)                     — (tests only)                          muse-skills.createSkillLister
```

### Invariants

- `createEngine` reads each seam as a separate `const` rather than a destructure-with-defaults, so every seam name is visible to the leak scanner's own-definitions pass.
- `createEngine` is required by exactly two hosts, main.js and headless-main.js; web-host.js is handed the engine headless-main.js already built, and sandbox.js is required BY engine.js, not the reverse.
- `resolveRegistryDir` throws under NODE_TEST_CONTEXT before it falls back to the home root, so a test that forgets `seams.registryDir` fails instead of sweeping the operator's live `~/.clodex`.
- `createEngine` refuses `seams.noSeed` outside NODE_TEST_CONTEXT, so a production host can never boot with the seed resources redirected to empty dirs.
- `createEngine` must never require electron: test/electron-boundary.test.js reds any electron require in it or the modules it bootstraps, and every electron touch arrives as a seam.
- `createEngine` sits in both lists of test/free-identifier-leaks.test.js: it is part of MAIN_SCOPE (so an extracted module using an engine name it was not injected fails the forward scan), it is in SCANNED_MODULES (scanned against main.js), and it is in the reverse dangling-reference loop (a name that moved out of it without a destructured binding fails).

### Hazards

- `createEngine` is the place for wiring: constructing a manager, store or watcher in main.js instead drags the electron-free graph back into one host and leaves headless-main.js without it.
- `createEngine` seams are optional per host, so a new seam passed only by main.js silently takes its default on headless-main.js; every new seam needs a deliberate answer in both hosts and a default that is safe there.
- `createEngine` getter seams such as `seams.webInfo` exist because the value is assigned after `createEngine` returns; turning one into a plain value freezes it at null.
- `resolveRegistryDir` moving its throw after the CLODEX_HOME fallback would let a developer's exported CLODEX_HOME absorb a seam-less test's registry cleanup and legacy sweep.
- `diagWarning` checks the darwin spawn-helper faults first because they sink every session; reordering lets a PATH or single-CLI warning mask them, and a single missing CLI is deliberately not a banner.

## Spill-file GC (module level) — referencedSpillNames … sweepSeatMessages

| symbol | purpose | state | calls | pins |
|---|---|---|---|---|
| `referencedSpillNames` | every spill or seat-image filename still named by a parked delivery, so the sweep can exempt it | reads `pending/` | pending-store.allParkedTexts | unpinned |
| `linksToSeatDir` | true only when a `messages/` entry is a symlink resolving to that seat's own messages dir | none (reads fs) | none | unpinned |
| `sweepSpilledMessages` | deletes spill and image files older than their age limits under `messages/<recipient>/`, sparing parked references | `~/.clodex/messages/` | referencedSpillNames, linksToSeatDir | messaging-spill-receipt.test.js seat-layout.test.js |
| `sweepSeatMessages` | the production binding of `sweepSpilledMessages`: 30 min for bodies, 24 h for images | `~/.clodex/messages/` | sweepSpilledMessages | messaging-spill-receipt.test.js |

### Invariants

- `referencedSpillNames` matches the filename grammar, not the pointer prose, because two pointer wordings already exist and over-matching only keeps a file one extra sweep.
- `sweepSpilledMessages` never deletes a file a parked dm still points at, because that spill file is the only copy of an over-threshold body.
- `sweepSpilledMessages` stays at module level with the `allParkedTexts` require beside it, so its exemption is testable without constructing an engine.

### Hazards

- `sweepSpilledMessages` grows disk for a seat that never returns, by design; a disk cap belongs in a `pending/` expiry shared with parking, not in a second policy here.
- `linksToSeatDir` is what lets the sweep follow a seat-dir symlink; widening it to any symlink lets the sweep walk and unlink outside `messages/`.

## Startup diagnostics — whichBin … logStartupDiagnostics

| symbol | purpose | state | calls | pins |
|---|---|---|---|---|
| `whichBin` | the absolute path of an executable regular file on PATH (or the given path), else null | none (reads PATH, fs) | none | diag-tools.test.js |
| `machoArch` | names a file's Mach-O arch from its first 8 bytes (universal, arm64, x86_64…) or says why it cannot | none (reads fs) | none | unpinned |
| `spawnHelperPath` | the node-pty spawn-helper path, first existing of node-pty's own candidate dirs, asar-unpacked | none (reads fs) | unpackAsar | unpinned |
| `detectRosetta` | whether this darwin process runs translated under Rosetta; any failure reads false | none | child_process.execSync | unpinned |
| `collectSystemDiagnostics` | the diagnostics object: arch, Rosetta, versions, claude/codex on PATH, the PATH-merge seam, helper existence/exec bit/arch | none | whichBin, spawnHelperPath, machoArch, detectRosetta | diag-tools.test.js |
| `diagSummary` | a one-line proc/helper/version summary for logs | none | collectSystemDiagnostics | session-manager.test.js |
| `logStartupDiagnostics` | prints `diagLines` to stdout at bootstrap and returns the diagnostics object | stdout | collectSystemDiagnostics, diagLines | unpinned |

### Invariants

- `spawnHelperPath` walks node-pty's own candidate order (build/Release, build/Debug, prebuilds) with the asar rewrite, because a narrower check names a helper node-pty never launches.
- `collectSystemDiagnostics` carries the host's `pathMergeFailed` seam, so the PATH-merge banner comes from the host that did the merge.
- `logStartupDiagnostics` runs once in the bootstrap tail, after the stores exist and after the reminder scheduler starts.

### Hazards

- `spawnHelperPath` picks the first dir where the helper exists, while node-pty picks the dir where `pty.node` loads, so a partial electron-rebuild can make the banner describe a different helper than the one that fails.
- `whichBin` is also handed to the SessionManager and the tool cache, so changing what it accepts changes the missing-CLI diagnosis on exit as well as the banner.

## Record predicates, prompt and template resolution, team gather — stripLevelOf … gatherTeam

| symbol | purpose | state | calls | pins |
|---|---|---|---|---|
| `stripLevelOf` | a persisted record's thinking-strip level 0/1/2, mapping the legacy `stripThinking: 'on'` to 1 | none (pure) | none | preserve-census.test.js proxy-poller-autocompact.test.js |
| `autoCompactOf` | auto-compact is on unless the record says exactly `autoCompact: false` | none (pure) | none | proxy-poller-autocompact.test.js |
| `isDigested` | whether a record's `digested` list already holds this sessionId | none (pure) | none | memory-load.test.js |
| `pluginBundles` | the loaded plugin bundles, or [] with no plugin host or when it throws | `pluginHost` | plugin-host-engine bundles | unpinned |
| `teamOwnBody` | a team-owned prompt body for a kind and stem, or null | reads `teams/<team>/prompts/` | team-prompt-dir.teamPromptFile | unpinned |
| `resolveSystemPromptFile` | a system-prompt stem as a readable file path: plugin ref, then team-owned copy, then the library | `promptLibrary` | plugin-prompt-refs.resolvePluginSystemPromptFile, team-prompt-dir.teamPromptFile | intent-spill-spawn-gate.test.js |
| `readAppendBodies` | each append-prompt stem resolved (plugin ref, team-owned, library) to a body, empty ones dropped | `promptLibrary` | teamOwnBody, plugin-prompt-refs.resolvePluginPromptBody | intent-spill-spawn-gate.test.js |
| `readSystemPromptBody` | same resolution order as `resolveSystemPromptFile`, returning the body instead of a path | `promptLibrary` | teamOwnBody, plugin-prompt-refs.resolvePluginPromptBody | plugin-prompt-resolution.test.js |
| `teamTemplateRows` | one row per team-owned template (unreadable ones flagged) plus a stem-to-teams shadow map | reads `teams/*/templates/` | teamTemplateStems, team-manifest.listTeams | unpinned |
| `listAllTemplates` | library templates annotated `shadowedBy`, then plugin template rows, then team rows | `templates` | teamTemplateRows, plugin-prompt-refs.pluginTemplateRows | team-frontdoor-seam.test.js plugin-prompt-resolution.test.js |
| `teamPromptRows` | one row per team-owned prompt of a known kind, plus a `kind:stem` shadow map | reads `teams/*/prompts/` | teamPromptStems, team-manifest.listTeams | unpinned |
| `listAllPrompts` | library prompts annotated `shadowedBy`, then the team rows | `promptLibrary` | teamPromptRows | team-prompt-rows.test.js team-prompt-save-ipc.test.js |
| `gatherSources` | the library/team probe adapter team-gather's planner walks (libraryPath, readLibrary, teamHas, readTemplateForWalk) | `promptLibrary`, `templates`, `execLibrary` | team-prompt-dir.teamJsonFile, team-prompt-dir.readTeamJson | unpinned |
| `gatherTeam` | copies every library item a team references into the team's own dir; `dry` returns only the plan | `teams/<team>/` | gatherSources, team-gather.planGather, team-gather.applyGather | team-gather.test.js team-uses.test.js |

### Invariants

- `resolveSystemPromptFile`, `readAppendBodies` and `readSystemPromptBody` share one precedence — plugin ref, team-owned copy, library — so a spawn never reads a prompt from a different source than the dialog showed.
- `teamPromptRows` filters a caller-supplied kind against PROMPT_KINDS before `teamPromptStems` uses it as a path segment.
- `listAllTemplates` and `listAllPrompts` annotate a library row a team shadows instead of dropping it, so the operator sees both copies.
- `stripLevelOf` is handed to both the SessionManager and the proxy poller, `autoCompactOf` to the poller alone and `isDigested` to the SessionManager alone, so each reading of a persisted record has one definition.

### Hazards

- `pluginBundles` tests `pluginHost` outside its try, so a call before the `pluginHost` let is declared would throw from the temporal dead zone.
- `resolveSystemPromptFile` lets the library's confineOrThrow escape for a traversing stem while `readSystemPromptBody` swallows it, so spawn callers must expect the throw.
- `gatherTeam` binds the team-manifest `loadManifest`, which is only in scope because the team-manifest factory is destructured earlier in `createEngine`; moving that destructure below the SessionManager deps object breaks both.

## Memory stores and the hint arms (unnamed wiring) — commonMemoryRecall … commonMemoryRecall

| symbol | purpose | state | calls | pins |
|---|---|---|---|---|
| `commonMemoryRecall` | recall from the shared common-memory store with the set name bound to `chat-extract` | `library/common-memory/` | memory-store recall | unpinned |

### Invariants

- `commonMemoryRecall` is the only recorded name in this stretch; memoryStore, memoryLoad, commonMemoryStore, semanticRanker, hintArm, voiceOriginArm and selectionArm are constructed around it as anonymous consts; memoryStore, memoryLoad and the three arms are handed to the SessionManager, while commonMemoryStore and semanticRanker reach it only through `commonMemoryRecall` and hintArm.
- `commonMemoryRecall` binds the set name here because recall takes an agent and common units belong to none.
- `commonMemoryRecall` reads `library/common-memory`, a sibling of `library/memory` like `memory-loadlog` and `memory-vectors.json`, because every entry under `library/memory` enumerates as an agent.

### Hazards

- `commonMemoryRecall` sits beside hint arms whose `enabled` and `semantic.rank` read `uiSettings` per call; capturing them at construction makes the Preferences checkboxes take effect only after a relaunch.
- `commonMemoryRecall` sits beside selectionArm, whose `selectionHints` pref must stay separate from `contextHints`, or ticking memory hints starts forwarding screen selections.
- `commonMemoryRecall` sits beside selectionArm's `queue`, which must stay an append, because a write loses a second click that lands between two submits.

## Per-seat plugin scaffolding: skills, agents, bundles — effectiveInjectedSkills … writeBundlePlugins

| symbol | purpose | state | calls | pins |
|---|---|---|---|---|
| `effectiveInjectedSkills` | the library skill records a seat gets at spawn: its selection unioned with scope auto-includes, missing names dropped | `skillLibrary` | scope-util.unionEnabled | agent-plugin-spawn.test.js |
| `effectiveInjectedAgents` | the library agent records a seat gets at spawn, mirroring `effectiveInjectedSkills` | `agentLibrary` | scope-util.unionEnabled | agent-plugin-spawn.test.js |
| `writeAgentPlugin` | rebuilds `agent-plugins/<seat>/` from scratch and returns its dir for a second `--plugin-dir`, or null when empty | `~/.clodex/agent-plugins/` | effectiveInjectedAgents, agents-util.buildAgentPlugin, path-confine.confine | agent-plugin-spawn.test.js |
| `cleanupAgentPlugin` | removes a seat's agent-plugin dir | `~/.clodex/agent-plugins/` | path-confine.confine | agent-plugin-spawn.test.js |
| `writeBundlePlugins` | writes one Claude plugin dir per plugin bundle under the seat's skill-plugin dir and returns the dirs to load | `~/.clodex/skill-plugins/<seat>/bundles/` | skills-util.buildSkillPlugin, agents-util.buildAgentPlugin, path-confine.confine | plugin-bundle-spawn.test.js skill-plugin-confine.test.js |

### Invariants

- `writeAgentPlugin` and `cleanupAgentPlugin` rm -rf only a `confine(AGENT_PLUGINS_DIR, name)` child, and a null confine throws or returns before any delete.
- `effectiveInjectedAgents` returns the set actually scaffolded, which is what the spawn-time subagent reference check depends on.
- `writeBundlePlugins` confines each bundle id under the seat's `bundles/` dir before it deletes or writes.

### Hazards

- `writeAgentPlugin` fires its recursive rmSync on every claude spawn before the no-agents bail, so a raw `path.join` for the dir deletes `~/.clodex` or `$HOME` for a name of `..` or `../..`.
- `writeAgentPlugin` roots at agent-plugins, a sibling of skill-plugins; nesting either root under the other makes each per-spawn rebuild delete the other's dir.
- `writeBundlePlugins` skips a bundle that yields no plugin before its rmSync, so the stale dir stays on disk and only the returned list is safe to load.

## Transport, skill delivery, proxy poller and wirescope construction — rebuildAllStatusScripts … skillDeliveryProviders

| symbol | purpose | state | calls | pins |
|---|---|---|---|---|
| `rebuildAllStatusScripts` | rewrites `run/<name>/statusline` for every live claude seat after a settings change | `run/*/statusline` | statusline.renderClaudeStatusScript | terminal-reports-pref.test.js |
| `randBase36` | a random base-36 string of the given length | none | none | clear-continuation.test.js |
| `deliverSkills` | delivers a seat's skill records through the per-provider skill delivery | `~/.clodex/skill-plugins/` | skill-delivery deliver | agent-plugin-spawn.test.js |
| `cleanupSkills` | removes a seat's delivered skills for a provider | `~/.clodex/skill-plugins/` | skill-delivery cleanup | agent-plugin-spawn.test.js |
| `skillDeliveryProviders` | the providers the skill delivery knows | none | skill-delivery providers | agent-plugin-spawn.test.js |

### Invariants

- `rebuildAllStatusScripts` follows the agent transport's construction, where `isAlive`, `registry` and `Transport` are destructured out of `createAgentTransport` and handed to the SessionManager.
- `skillDeliveryProviders` is followed by the unnamed ProxyPoller class, built by `createProxyPoller` with `getPersistence` and `getRemoteServer` getters, and the `wirescope` supervisor instance; both come before the SessionManager exists.
- `deliverSkills` wraps a `createSkillDelivery` call that must stay below the skills-util require it reads, or boot hits a temporal-dead-zone ReferenceError.

### Hazards

- `skillDeliveryProviders` is the nearest recorded name to the ProxyPoller and wirescope construction, which carry no name; look after it, not in a region of their own.
- `skillDeliveryProviders` precedes a ProxyPoller whose persistence and remote-server deps are getters because both are assigned far below; passing the values would hand it undefined for its life.

## CLI settings layers, transcripts and the resume bake — parseSkillRoster … readSessionMeta

| symbol | purpose | state | calls | pins |
|---|---|---|---|---|
| `parseSkillRoster` | the skill roster a seat's claude transcript lists, classified in-scope versus out-of-scope | reads `run/<name>/transcript` | skill-roster.classifySkillRoster | unpinned |
| `readEffectiveSkillState` | per-skill on/off overrides from the global, project and local Claude settings plus the managed-policy skills lock | reads `.claude/settings*.json`, managed settings | fs-util.readJsonSafe | default-skill-catalog.test.js |
| `readEffectiveToolState` | per-tool bare-name denies from the Claude settings layers and policy, the policy ones marked locked | reads `.claude/settings*.json`, managed settings | fs-util.readJsonSafe | default-skill-catalog.test.js |
| `claudeProjectDir` | `~/.claude/projects/<slug>` for a cwd, or null | none | clodex-paths.claudeProjectSlug | seat-import.test.js |
| `lastTranscriptWrite` | the mtime of a claude seat's on-disk transcript, or null | none (reads fs) | claudeProjectDir | createdat-restart.test.js |
| `maybeCompactBeforeResume` | opt-in: hands a claude transcript to wirescope's `/_compact` before `--resume`; any failure resumes the original | the transcript file (via the proxy) | wirescope-proxy.ProxyClient, claudeProjectDir, stripLevelOf | session-restore.test.js |
| `readSessionMeta` | `{title, first, last, turns}` from a transcript, counting user turns that are not pure tool results | none (reads fs) | none | session-discovery.test.js session-history-codex.test.js |

### Invariants

- `readEffectiveToolState` reads bare tool names only, because a scoped deny such as `Bash(rm:*)` does not disable the tool.
- `readEffectiveSkillState` and `readEffectiveToolState` read the managed-settings file for both darwin and linux, so a headless linux host sees policy locks too.
- `maybeCompactBeforeResume` fires only after the proxy answers its identity probe as wirescope, which is what makes it safe against the launch race.

### Hazards

- `maybeCompactBeforeResume` is not warmth-neutral for thinking-only turns, and a warmth gate built from its response gates after the rewrite already happened.
- `claudeProjectDir` hardcodes `~/.claude`, so a seat running under another Claude config dir silently skips the bake and `lastTranscriptWrite` returns null.
- `parseSkillRoster` and `readSessionMeta` read a whole transcript synchronously, so calling them per tick or per row stalls the host's event loop.

## Hooks, watchers, spill, and the SessionManager construction — cleanupOldMessages … platformSkills

| symbol | purpose | state | calls | pins |
|---|---|---|---|---|
| `cleanupOldMessages` | one pass of the spill GC over `messages/`, honouring parked references | `~/.clodex/messages/` | sweepSeatMessages | unpinned |
| `spillToFile` | writes an over-threshold dm body with a From/Time/Size header to `messages/<recipient>/` and returns its path | `~/.clodex/messages/`, `msgCounter` | fs-util.ensureDir | messaging-spill-receipt.test.js |
| `getHelpCorpus` | the help corpus, loaded once from `__dirname` and memoized | `helpCorpus` | help-corpus.loadHelpCorpus | engine-help-corpus-seam.test.js |
| `knownSkillNames` | the deduped union of built-in skills, `skillsSeen` and the global settings overrides, re-read per call | `skillsSeen` | readEffectiveSkillState | clodex-home-app-root.test.js |
| `platformSkills` | a CLI's platform skills through `seams.skillLister` or the default lister | `os.tmpdir()/clodex-skills-list` | muse-skills.createSkillLister | session-manager-muse.test.js |

### Invariants

- `platformSkills` is followed by the unnamed `createSessionManager` deps object and `new SessionManager()`, then team delete and `new ProxyPoller(manager)`; this is the one construction of `manager`.
- `platformSkills` precedes a SessionManager deps object that receives every late-bound store as a getter (`getPersistence`, `getUiSettings`, `getWorkspaces`, `getRemoteServer`, `getPeerManager`, `getSandboxManager`…), because the stores and remote/peer/sandbox bindings are created below it.
- `cleanupOldMessages` runs once at the bootstrap tail and then on a MSG_CLEANUP_INTERVAL timer that `shutdown` clears.
- `knownSkillNames` is passed into `initStores` before `skillsSeen` is destructured from that call's result, so the stores may only call it after init returns.

### Hazards

- `platformSkills` sits just above the SessionManager deps object, where replacing a getter with the value (for example `persistence` for `getPersistence`) is a temporal-dead-zone ReferenceError at boot.
- `platformSkills` sits below the drawer-avail require whose `termAvailableFor` the deps object reads; moving that require down beside the drawer construction breaks startup.
- `spillToFile` joins the recipient name into a path unconfined, which is safe only because dot-only names are rejected upstream.
- `getHelpCorpus` loads lazily; loading at construction reads the corpus in every test that builds an engine.

## Proxy and file views: the shared session helpers — fetchProxyContext … peerProxyView

| symbol | purpose | state | calls | pins |
|---|---|---|---|---|
| `fetchProxyContext` | GET `/_context` for a proxied, linked seat, optionally with utilization, timeouts mapped to a readable error | none | wirescope-proxy.ProxyClient, proxyPoller snapshot | engine-context-timeout.test.js engine-web-info-seam.test.js |
| `fetchProxyReport` | GET `/_report` for a linked seat, serving the last summary as stale on failure | `reportCache` (also `manager._reportCache`) | wirescope-proxy.ProxyClient | engine-report-stale-cache.test.js |
| `fetchProxyBust` | the cache-bust series for a linked seat | none | wirescope-proxy.ProxyClient bustSeries | engine-web-info-seam.test.js file-view-api.test.js |
| `fetchSessionFiles` | a live seat's cwd, file touches and filed-ring list | `manager.sessions` | none | engine-web-info-seam.test.js file-view-api.test.js |
| `fetchFilePeek` | a pass-through to `peekFile`, session-less and unconfined | none (reads fs) | file-peek.peekFile | engine-web-info-seam.test.js file-view-api.test.js |
| `resolveFilePath` | resolves a displayed path against a local seat's cwd and touches; refuses peer rows | `manager.sessions` | file-resolve.resolveDisplayedPath | engine-spill-resolve.test.js |
| `writeFilePeek` | writes an edited file under a local seat's cwd after the stale-mtime vet, returning the new mtime | the target file | file-edit.vetFileWrite | unpinned |
| `fetchFileDiff` | git status and diff of one file in the seat's cwd | none (runs git) | child_process.execFile | engine-web-info-seam.test.js file-view-api.test.js |
| `peerProxyView` | the viewer-safe subset of a proxy snapshot shipped to peers, with the queries it can answer | none (pure; reads CLODEX_WIRESCOPE_PUBLIC_URL) | proxy-util.boxWirescopeView | engine-web-info-seam.test.js context-popover-plain-column.test.js |

### Invariants

- `fetchProxyReport` never lets a detail response write or serve the summary cache, and serves a cached entry only when its sessionId matches the live one.
- `peerProxyView` drops the owner's base and sessionId unless CLODEX_WIRESCOPE_PUBLIC_URL publishes a reachable one, so a viewer's controls never fire at an endpoint only the owner can reach.
- `writeFilePeek` returns the new mtime, which is what lets the next save pass its own stale check.
- `fetchProxyContext`, `fetchSessionFiles` and `fetchFileDiff` are defined here and injected into ipc-handlers and remote-wiring through the handle, deliberately not a module.

### Hazards

- `fetchFileDiff` has no peer-row guard, unlike `resolveFilePath` and `writeFilePeek`, so it runs local git in a peer's far-box cwd.
- `fetchFilePeek` reads any path with no session and no confinement, so routing it to a remote or web surface without a confinement layer grants arbitrary reads.
- `writeFilePeek` realpaths before it writes, so a symlink swapped in between redirects the write outside the cwd.

## Seat restart, restore and the Edit Session args — waitForSessionExit … applySessionSkills

| symbol | purpose | state | calls | pins |
|---|---|---|---|---|
| `waitForSessionExit` | polls until a killed seat's slot frees or the timeout passes; returns whether it freed | `manager.sessions` | none | createdat-restart.test.js keepwarm-restart-preserve.test.js |
| `restartSession` | kills and re-creates a persisted seat, resuming its conversation unless `fresh`, keeping the record on failure | `persistence` | waitForSessionExit, session-manager create, _preserveAcrossRestart | createdat-restart.test.js engine-web-info-seam.test.js |
| `readCtxFor` | a seat's `run/<name>/ctx` parsed into `{ctx, ctxTok, ctxSize, ctxCost, ctxModel}`, all-null on failure | reads `run/<name>/ctx` | argv-merge.parseCtxFile | compact-indicator.test.js |
| `restoreSessionsForWorkspace` | runs the workspace restore loop, then the reboot notice and lost-exec-run delivery | `persistence`, `manager` | session-restore.restoreSessionsForWorkspace, maybeCompactBeforeResume | resume-cwd-tree-fallback.test.js exited-seat-row.test.js |
| `sessionScopeCtx` | the `{session, workspace}` scope a library `listFor` filters by | `persistence`, `workspaces` | none | unpinned |
| `readSessionArgs` | the Edit Session dialog's view of a persisted seat, with effective tool overrides, agent catalog, team, io and effort | `persistence`, `agentLibrary` | readEffectiveToolState, sessionScopeCtx, stripLevelOf | args-dialog-team-append.test.js |
| `applySessionArgs` | persists an Edit Session patch field by field and, with `restart`, re-creates the seat from the resolved values | `persistence` | session-args.resolveSessionArgsPatch, intent-registry.pruneForPlugins, waitForSessionExit | engine-args-env.test.js engine-args-plugin-prune.test.js |
| `moveAccountByModel` | moves every seat on a model to an account and reattaches each one that restarted | `persistence`, `accounts` | accounts.sweepAccountMove, applySessionArgs | accounts-move-reattach.test.js |
| `sweepDiscoveredSkills` | skill names listed in the head of every seat's transcript roster | reads `run/*/transcript` | skill-roster.listedRosterNames | unpinned |
| `readSkillCatalog` | the skills popover's catalog: known names, lower-layer state, policy lock, and per-seat off and inject lists | `persistence`, `skillsSeen`, `skillLibrary` | platformSkills, readEffectiveSkillState, parseSkillRoster, sweepDiscoveredSkills | default-skill-catalog.test.js codex-skills-popover.test.js |
| `applySessionSkills` | persists a seat's disabled and inject skill lists without restarting | `persistence` | none | engine-web-info-seam.test.js |

### Invariants

- `restartSession` and `applySessionArgs` wait for the old process to leave `manager.sessions` before `create`, so the re-create does not race "session already exists".
- `waitForSessionExit` keeps its default above kill's SIGKILL fallback, so a stuck process is reaped before the restart gives up.
- `applySessionArgs` passes `create` the resolved value for every edited field, never `beforeKill`'s, because create rebuilds the record from its positional arguments alone.
- `restoreSessionsForWorkspace` runs on every workspace open, so the reboot notice and lost-exec delivery it fires must stay idempotent.
- `readCtxFor` is a const declared after the SessionManager deps object, which is why that object reaches it through an arrow wrapper rather than by value.

### Hazards

- `restartSession` and `applySessionArgs` each keep a hand-written preserved-field list that must stay in step with each other and with session-manager's reload arm.
- `restartSession` carrying `rosterSentAt` into a fresh restart suppresses the roster for the new conversation, and dropping `createdAt` re-mints the seat's birth time.
- `applySessionArgs` failure arm must restate every edited field on the re-upserted record, or the edits persisted before the kill revert.
- `applySessionArgs` calls `resolveSessionArgsPatch(patch, beforeKill)` before its unknown-name check, so the resolver must keep tolerating a null prior record or an unknown name throws instead of being refused.

## Remote, peer, sandbox and ctl wiring (unnamed) — applySessionSkills … deliverExecResult

| symbol | purpose | state | calls | pins |
|---|---|---|---|---|
| `getRemoteServer` | the current RemoteServer, reassigned by `syncRemoteServer` and nulled by shutdown | `remoteServer` | remote-wiring.syncRemoteServer | engine-web-info-seam.test.js |
| `getRemoteError` | the last remote-server start error | `remoteError` | remote-wiring.syncRemoteServer | unpinned |
| `setRemoteToken` | writes the remote-access token to the env-token file under userDataPath | `<userData>` env-token file | remote-token.writeRemoteEnvToken | unpinned |
| `hasRemoteToken` | whether that env-token file holds a token | `<userData>` env-token file | remote-token.hasRemoteEnvToken | unpinned |
| `getPeerManager` | the current PeerManager, reassigned by `syncPeerManager` and nulled by shutdown | `peerManager` | peer-wiring.syncPeerManager | drawer-services-seam.test.js |
| `getTunnelManager` | the current ssh TunnelManager | `tunnelManager` | peer-wiring | peer-disable.test.js |
| `getWebTunnelManager` | the current web TunnelManager | `webTunnelManager` | peer-wiring | peer-web-open.test.js |
| `getSandbox` | the sandbox instance for a box id, or null when the sandbox manager is off | `sandboxManager` | sandbox.createSandboxManager | engine-sandbox-seam.test.js |
| `getSandboxManager` | the sandbox manager, null when `seams.enableSandbox` is false | `sandboxManager` | sandbox.createSandboxManager | engine-sandbox-seam.test.js |
| `getCtlService` | the drawer's clodexctl REPL service, null when `seams.enableCtl` is false | `ctlService` | ctl-service.createCtlService | unpinned |

### Invariants

- `applySessionSkills` is the last recorded name before an unnamed stretch that builds, in order, remote-wiring (`syncRemoteServer`, `refreshRemoteToken`), the peer/tunnel `let`s and peer-wiring, the sandbox manager, the ctl service and the drawer ptys; the rows here are the handle's accessors onto those bindings.
- `getRemoteServer`, `getPeerManager`, `getTunnelManager` and `getWebTunnelManager` stay closures over their `let`s, because the sync calls reassign them and shutdown nulls them.
- `getPeerManager` reads a binding that peer-wiring writes through its set half, the get+set singleton pair convention for module-written values.
- `getSandboxManager` returns null rather than a stub when the host declines the sandbox, so every consumer must null-check it.

### Hazards

- `getPeerManager` style getters handed to remote-wiring close over bindings declared after the call (the peer and tunnel managers are `let`s, the sandbox manager and drawer ptys `const`s — the temporal dead zone applies to both), so invoking one during construction hits the temporal dead zone.
- `getSandboxManager` exposing a manager on a headless host hands docker and container lifecycle to a web client, which is why headless-main.js turns `enableSandbox` off inside a box.
- `getCtlService` must stay the only route to the ctl service, because selectionArm resolves its scrubber through `ctlService` per call and a second token list would drift.

## Drawer terminal plumbing — deliverExecResult … drawerPtyCwd

| symbol | purpose | state | calls | pins |
|---|---|---|---|---|
| `deliverExecResult` | delivers an agent-requested terminal result as a gated dm, falling back to the seat's selection queue | `run/<seat>/selection` | session-manager _gatedDeliver, queueForSeat | unpinned |
| `queueForSeat` | appends one JSON row to a seat's selection queue, tagged with a kind only for passive reports | `run/<seat>/selection` | none | terminal-reports-pref.test.js |
| `dropPassiveTermReports` | rewrites each seat's undrained queue without the passive terminal rows | `run/<seat>/selection` | none | terminal-reports-pref.test.js |
| `syncTerminalReports` | after a settings write away from `terminalReports: all`, drops passive rows from every live seat's queue | `run/*/selection` | dropPassiveTermReports | terminal-reports-pref.test.js |
| `termShimDiagnosis` | why a seat's shell reports no completion marks: unsupported shell, reporting off, or a shell older than the pref | `uiSettings` | term-shim.unsupportedShellReason | term-shim.test.js terminal-reports-pref.test.js |
| `termRefusalName` | the program shown in a busy-terminal refusal: the full command only under `terminalReports: all` | `uiSettings` | drawer-avail.sanitizeName, term-host.programOf | unpinned |
| `termExec` | the session-manager seam that runs one agent command on the seat's drawer terminal, refusals as agent text | `drawerPtys` | drawer-pty exec, termRefusalName, termShimDiagnosis | session-manager.test.js |
| `drawerPtyCwd` | a drawer shell's start dir: the seat's cwd, else the workspace's most common cwd, else HOME | `manager.sessions` | none | unpinned |
| `getDrawerPtys` | the drawer pty service, null when `seams.enableLocalTerminal` is false | `drawerPtys` | drawer-pty.createDrawerPtys | drawer-services-seam.test.js |

### Invariants

- `deliverExecResult` is fed by the unnamed `onExecResult` callback of the drawer pty construction just above it, and every status branch there produces a message so the asking agent is never left waiting.
- `deliverExecResult` keeps the queue fallback for held, dead and throwing deliveries, or a late result becomes a lost one.
- `queueForSeat` tags only passive rows with a kind, so `dropPassiveTermReports` never drops an operator's Copy attachment or an exec fallback.
- `termExec` is handed to the SessionManager before `drawerPtys` is declared, and is safe only because it reads `drawerPtys` at call time.

### Hazards

- `termExec` called during construction would hit `drawerPtys` in its temporal dead zone, since the SessionManager deps object is built long before the drawer service.
- `termRefusalName` must show only the program name below `terminalReports: all`, never the full command line.
- `getDrawerPtys` gates a local shell, a different argument from the drawer services flag; the drawer construction's spawn-time `shimEnv` gate and per-command `onCommand` gate must not be merged either.

## Bootstrap tail: stores, pollers, scheduler, autostarts, sweeps, plugin host — drawerPtyCwd … shutdown

| symbol | purpose | state | calls | pins |
|---|---|---|---|---|
| `checkTools` | the cached CLI-tool presence report | `toolCache` | tool-doctor.createToolCache | unpinned |
| `invalidateToolCache` | drops the tool cache so the next `checkTools` re-probes | `toolCache` | tool-doctor.createToolCache | api-contract.test.js |
| `getPluginHost` | the plugin host, null under `CLODEX_PLUGINS=0` or after a construction failure | `pluginHost` | plugin-host-engine.createPluginHostEngine | plugin-kill-switch.test.js app-menus-plugins.test.js |
| `getPluginLoader` | the plugin loader, null under the same conditions | `pluginLoader` | plugin-loader.createPluginLoader | plugin-template-spawn.test.js |
| `getPluginUpdates` | pending plugin updates from the update watch, or [] | `pluginUpdateWatch` | plugin-update-watch.createPluginUpdateWatch | plugin-host-engine.test.js |
| `refreshPluginUpdates` | forces an update-watch run, or resolves [] with no watch | `pluginUpdateWatch` | plugin-update-watch.createPluginUpdateWatch | plugin-host-engine.test.js |

### Invariants

- `drawerPtyCwd` is the last recorded name before the unnamed tail, which runs in this order: tool cache, `initStores` and the stores destructure, accounts, exec-script materialize, proxy poller start, pending poll, ticket watchdog, reminder scheduler, startup log, wirescope autostart, `syncRemoteServer`, `syncPeerManager`, sandbox autostart, the wirescope watchdog interval, message cleanup and its timer, registry cleanup, legacy sweep and seat-layout migration, tickets migration, reviewer-graveyard sweep, then the plugin host.
- `checkTools` sits before `initStores`, and every function defined earlier in `createEngine` that reads `persistence`, `uiSettings` or another store is safe only because nothing calls it before that line.
- `getPluginHost` returns a host constructed at the tail, after stores, manager and wiring exist and before the handle returns, so a plugin's activate runs before the host's renderer-driven restore can create a session.
- `refreshPluginUpdates` and `getPluginUpdates` read the plugin update watch, the only update checker engine.js constructs; the app-release update-checker.js is constructed by main.js, not here.
- `drawerPtyCwd` is followed by migration and sweep blocks that each catch and log, so an unreadable board or legacy dir never becomes a refusal to start.

### Hazards

- `checkTools` precedes the stores init; hoisting any start or sync call above that init lets an earlier-defined function reach `persistence` or `uiSettings` in the temporal dead zone.
- `getPluginHost` construction moved into a host or after the return breaks the activate-before-restore ordering.
- `getPluginUpdates` and `refreshPluginUpdates` are duplicated verbatim in the plugin-host deps and the returned handle, so a change to one fallback must be made in both.
- `getPluginHost` failure path nulls host and loader but cannot undo side effects of plugins `loadAll` already activated.

## Shutdown order and the returned handle — shutdown … invalidateToolCache

| symbol | purpose | state | calls | pins |
|---|---|---|---|---|
| `shutdown` | idempotent teardown: timers, pollers, scheduler, remote, peers, tunnels, ctl, drawer ptys, bash-live, then kill all seats, then speech | `didShutdown` and every stopped singleton | session-manager killAll, speaker stop | engine-web-info-seam.test.js drawer-pty.test.js ctl-service.test.js |
| `listSpeakVoices` | the TTS voices from the engine's voice catalog | `voiceCatalog` | speaker.createVoiceCatalog | unpinned |
| `getBashLive` | the live-console registry of in-flight Bash output | `bashLive` | bash-live.createBashLive | unpinned |

What a host gets back from `createEngine`, grouped:

```
primary      manager, stores, syncRemoteServer, syncPeerManager, restoreSessionsForWorkspace, shutdown
infra        REGISTRY_DIR, proxyPoller, wirescope, ProxyClient, pty, accounts, sessionMeta, sessionInfo
accessors    getRemoteServer, getRemoteError, getPeerManager, getTunnelManager, getWebTunnelManager,
             getSandbox, getSandboxManager, getCtlService, getBashLive, getDrawerPtys, getPluginHost,
             getPluginLoader, getPluginUpdates, refreshPluginUpdates, getHelpCorpus, checkTools, invalidateToolCache
remote       refreshRemoteToken, setRemoteToken, hasRemoteToken, openPeerWeb, closePeerWeb,
             forgetPeerAttached, forgetPeerControlled, rememberPeerControlled
host flags   enableDrawerServices, enableCtl, enableLocalTerminal, enableConsole, enableAccounts
session      restartClodex (= seams.restartHost), restartUnavailable, restartSession, waitForSessionExit,
             readSessionArgs, applySessionArgs, readSkillCatalog, applySessionSkills, moveAccountByModel,
             sessionScopeCtx, readSessionMeta, claudeProjectDir, rebuildAllStatusScripts, syncTerminalReports
views        fetchProxyContext, fetchProxyReport, fetchProxyBust, fetchSessionFiles, fetchFilePeek,
             fetchFileDiff, writeFilePeek, resolveFilePath
library      knownSkillNames, listAllTemplates, listAllPrompts, resolveSystemPromptFile, readAppendBodies,
             readSystemPromptBody, readEffectiveSkillState, readEffectiveToolState, readVoiceTrigger,
             readVoiceCapability, listSpeakVoices
teams        createTeam, addRole, resolveTeam, listTeams, loadManifest, setRole, removeRole, renameRole,
             setTeamWatchdog, setLead, setTeamTrunk, gatherTeam, teamsDir, teamDeleteCheck, teamDeleteGated
diagnostics  collectSystemDiagnostics, diagSummary, diagWarning, whichBin
constants    CLAUDE_SKILLS, CLAUDE_SL_COMPONENTS, CLAUDE_TOOLS, CODEX_SL_COMPONENTS,
             DEPLOY_FIX_INJECT_DELAY_MS, SKILL_REENABLE_CONFIRMED
misc         stripLevelOf, updateApplies, jsonlToMarkdown, sshRun, probePeer, fixSessionName,
             buildDeployFixBriefing, classifyDeployFolder, resolveDeployFolder
```

### Invariants

- `shutdown` is idempotent through `didShutdown` and sets the host's quitting flag first, so a second quit path or a re-entrant call does nothing.
- `shutdown` stops `ctlService` and `drawerPtys` explicitly, because a warm REPL transport or a workbench shell is a child process with no persistence record and would otherwise be orphaned.
- `shutdown` stops speech after `killAll`, not before, so a narration started by a flushing watcher does not outlive the quit.
- `getBashLive` and `listSpeakVoices` read engine-lifetime consts, so unlike the `let` accessors they never return null after construction.

### Hazards

- `shutdown` does not await `killAll`, stop the pending poll, deactivate plugins or stop autostarted sandbox boxes; adding any of these is a design decision, not a cleanup.
- `shutdown` gaining a new service means adding its stop here, since both hosts route every quit path (Electron before-quit, headless SIGTERM/SIGINT) through this one function.
- `listSpeakVoices` must stay lazy, because warming the voice catalog at construction spawns `say` in every test that builds an engine.

## EXEMPT
