# stores.js

## UI-settings layout sanitizers and the defaults clone — sanitizeSidePaneWidth … sanitizePlugins

| symbol | purpose | state | calls | pins |
|---|---|---|---|---|
| `sanitizeSidePaneWidth` | an integer side-pane width in 320..10000, else null | none | none | unpinned |
| `sanitizeDockSplit` | a dock split fraction inside the renderer's DOCK_SPLIT_MIN..DOCK_SPLIT_MAX, else null | none | renderer/lib/split constants | unpinned |
| `sanitizeRecentCwdsByWorkspace` | per-workspace recent-cwd lists kept as string arrays capped at 12, or null for a non-object | none | none | unpinned |
| `defaultUiSettings` | a fresh deep copy of DEFAULT_UI_SETTINGS, so no caller can edit the process-wide default in place | none (reads DEFAULT_UI_SETTINGS) | JSON round-trip | unpinned |
| `sanitizePlugins` | shape-checks the plugins bag, keeping arbitrary keys and forcing enabled to an array of strings; null for a non-object | none | none | plugin-loader.test.js |

### Invariants
- `defaultUiSettings` is the only door to a mutable default: `uiSettings.get` hands its result to callers that edit it in place, so a shared singleton would become everyone's default.
- `sanitizePlugins` returns null for a non-object, and both `_load` and `set` supply the fallback bag themselves.

### Hazards
- A key added to DEFAULT_UI_SETTINGS alone is silently dropped: it also needs `_load`, `set`, the `settings:get` whitelist in ipc-handlers.js and both halves of openPrefs, or it never persists or never reaches the renderer.
- Returning DEFAULT_UI_SETTINGS or one of its nested arrays in place of `defaultUiSettings` lets one caller's in-place edit leak into every later read.
- A caller of `sanitizePlugins` that forgets its own fallback stores null as the plugins bag.

## Peer record sanitizers — sanitizePeerCloud … sanitizePeerControlled

| symbol | purpose | state | calls | pins |
|---|---|---|---|---|
| `sanitizePeerCloud` | rebuilds one typed cloud-transport block (ssm, kubectl, gcloud, az) from the PEER_CLOUD_KINDS whitelist, or null if the CLI validator refuses it | none | cli/src/contexts.validateEntry | unpinned |
| `cloudLabel` | the fallback display label of a label-less cloud peer, read from the field its kind names as its label | none (reads PEER_CLOUD_KINDS) | none | unpinned |
| `sanitizePeers` | whitelist-rebuilds the outbound peers array, carrying a token the round-trip omitted forward from the prior array by id | none | sanitizePeerCloud, cloudLabel | peer-import.test.js stores.test.js |
| `legacyShellGrant` | true when any RAW legacy peer record carried shellAllowed, so peerShellEnabled inherits the old grant on upgrade | none | none | unpinned |
| `sanitizePeerNameMap` | the shared peerId-to-session-names map sanitizer; keepEmpty decides whether an empty list survives | none | none | unpinned |
| `sanitizePeerAttached` | the peerAttached reattach map, empty lists dropped | none | sanitizePeerNameMap | unpinned |
| `sanitizePeerVisible` | the peerVisible map, empty lists kept because they mean show none | none | sanitizePeerNameMap | unpinned |
| `sanitizePeerControlled` | the peerControlled map, empty lists dropped | none | sanitizePeerNameMap | unpinned |

### Invariants
- `sanitizePeers` is a whitelist rebuild, so a peer field it does not name vanishes on the next settings write.
- `sanitizePeerCloud` keeps optional fields absent rather than null, because the transport builders test presence.
- `legacyShellGrant` must read the RAW peers array, because the sanitized one no longer carries shellAllowed.

### Hazards
- Writing disabled false from `sanitizePeers` breaks the absence-means-enabled rule the peer manager reads.
- Re-adding shellAllowed to the `sanitizePeers` whitelist gives the peer-terminal grant a second home beside peerShellEnabled.
- Passing sanitized peers to `legacyShellGrant` silently revokes every upgrading box's shell grant.
- Admitting a raw tunnel argv through `sanitizePeerCloud` would make a renderer-editable command line that the app executes.

## Box, reboot and scalar sanitizers — sanitizeSandbox … sanitizeSpeakRate

| symbol | purpose | state | calls | pins |
|---|---|---|---|---|
| `sanitizeSandbox` | whitelist-rebuilds one box config (workDir, three ports, autoStart, image, ref, mounts) with per-field defaults | none (reads DEFAULT_SANDBOX_CONFIG) | sanitizeBoxRef, sanitizeSandboxMounts | stores.test.js |
| `sanitizeBoxRef` | a trimmed git ref matching BOX_REF_RE with no dot-dot segment, else null | none | none | unpinned |
| `sanitizeSandboxMounts` | an array of host, ro, container mount rows with host required and ro strictly true | none | none | unpinned |
| `sanitizeBoxes` | the persisted boxes list, deduped by id with malformed and reserved ids dropped; null only for non-array input | none (reads BOX_ID_RE, RESERVED_BOX_IDS) | sanitizeSandbox | unpinned |
| `sanitizeRebootNotice` | the pending reboot notice normalised to name, at, reason, attempts, or null without a name | none | none | unpinned |
| `sanitizeTerminalReports` | the tri-state terminalReports from the current key, the legacy boolean, or neither (absent resolves to off) | none | none | unpinned |
| `sanitizeSpeakRate` | an integer words-per-minute rate in 80..400, else the shipped 210 | none | none | spoken-replies.test.js |

### Invariants
- `sanitizeBoxes` returns null only for non-array input, so a deliberately emptied boxes list survives rather than re-seeding the default box.
- `sanitizeBoxes` gives each fallback config its own mounts array rather than the DEFAULT_SANDBOX_CONFIG singleton.
- `sanitizeTerminalReports` resolves an absent or legacy-false key to off, so an upgrade never grants the capability on its own.

### Hazards
- A box-config sub-key that `sanitizeSandbox` does not rebuild vanishes on every round-trip, as mounts once did.
- BOX_ID_RE and RESERVED_BOX_IDS mirror sandbox.js by hand, so changing one side lets `sanitizeBoxes` persist a colliding or shadowing box id.
- Dropping attempts from `sanitizeRebootNotice` turns the bounded reboot-notice retry into an unbounded one.
- The 80 and 400 bounds in `sanitizeSpeakRate` duplicate speaker.js on purpose; changing one side owes the other.

## Shared primitives: the factory and the unreadable-file refusal — initStores … refuseUnreadable

| symbol | purpose | state | calls | pins |
|---|---|---|---|---|
| `initStores` | the factory: derives every path from its userDataPath and registryDir arguments, runs migrations and seeders, returns the store set | every file below; closure sets unreadableLogged, quarantinedFiles, launchBakTaken | readStoreJson, migratePromptsJson, seedLibraryDefaults, seedEnvDefaults | stores.test.js engine-registry-dir-seam.test.js env-defaults-seed.test.js |
| `readStoreJson` | reads one JSON store as absent, ok with a value, quarantined (unparseable, moved to a .corrupt- sibling) or unreadable | quarantinedFiles, unreadableLogged, the file's .corrupt- sibling | none (fs directly) | unpinned |
| `refuseUnreadable` | throws the refusing-to-save error a store raises instead of writing over a file it could not read | none | none | unpinned |

### Invariants
- Every store path is derived inside `initStores` from its arguments, never from app.getPath, which is what makes the paths post-whenReady by construction.
- The return object of `initStores` is the list of stores: persistence, templates, workspaces, promptLibrary, agentDefaults, agentLibrary, skillLibrary, execLibrary, reminders, notifications, uiSettings, envScopes, envDefaults, setupMarker, skillsSeen, plus renameWorkspaceScope.
- `readStoreJson` separates a read error from a parse error: an unparseable file is moved aside and reads as quarantined, while a file that cannot be read or moved reads as unreadable and is never written.
- Every JSON store under userDataPath that is rewritten from its own read (sessions.json, workspaces.json, ui-settings.json, env-scopes.json, agent-defaults.json, reminders.json, notifications.json, skills-seen.json) loads through `readStoreJson` and carries the t1329 refusal.
- `initStores` touches disk on every call, because the one-shot migrations and both seeders run at construction.

### Hazards
- A store built in `initStores` but left out of its return object falls off the list, and nothing that enumerates stores will see it.
- Calling `initStores` before whenReady with an app.getPath argument reintroduces the pre-ready path read the factory exists to avoid.
- A new store file belongs under userDataPath or under the registryDir root, where clodex-paths.js is the authority; a file under a run/<name>/ dir is wiped on respawn, and `initStores` has no path local for one.
- A new JSON store that parses with a bare try-and-default instead of `readStoreJson` will save its empty default over a file it merely could not read.

## sessions.json (persistence) — _load … markDigested

| symbol | purpose | state | calls | pins |
|---|---|---|---|---|
| `_load` | persistence: every session record from sessions.json, recovering from .bak when the primary is not ok, backfilling workspaceId | sessions.json, sessions.json.bak, this._unreadable | readStoreJson | stores.test.js |
| `_save` | persistence: atomic whole-array write, a one-per-launch .bak of the prior file, and a seat.json mirror of the touched record written only when the sessions.json write landed; false when refused or failed | sessions.json, sessions.json.bak, launchBakTaken, persistRefusedLogged | fs-util.atomicWriteFileSync, _writeSeatJson | stores.test.js |
| `listForWorkspace` | the session records of one workspace id | sessions.json | _load | app-menus-plugins.test.js exited-seat-row.test.js |
| `_writeSeatJson` | mirrors one record into sessions/<name>/seat.json under registryDir, only when the seat layout is active and the dir exists | seat.json under registryDir | clodex-paths.seatDirFor, seat-layout.seatLayoutActive | unpinned |
| `snapshotSeat` | forces a seat.json write from the current record | seat.json | _writeSeatJson | stores.test.js |
| `upsert` | shallow-merges or appends one record by name and mirrors it to seat.json | sessions.json | _load, _save | accept-standing-seat.test.js createdat-restart.test.js |
| `remove` | persistence: drops the record by name; seat.json is left as it is | sessions.json | _load, _save | accept-standing-seat.test.js createdat-restart.test.js |
| `setSessionId` | sets the current Claude session id and appends it to the sessionIds history | sessions.json | _save | clear-continuation.test.js createdat-restart.test.js |
| `setHoldUntil` | stores a positive keep-warm deadline, deleting the key otherwise | sessions.json | _save | keepwarm-restart-preserve.test.js stores.test.js |
| `setKeepWarmAlways` | stores perpetual keep-warm as its own flag, deleted when off | sessions.json | _save | keepwarm-restart-preserve.test.js stores.test.js |
| `setLabel` | sets the display label | sessions.json | _save | preserve-census.test.js |
| `rename` | renames a record when the new name is free, clearing its label; false on collision or a missing record | sessions.json | _save | stores.test.js |
| `setWorktree` | stores a worktree object that has a path, deleting the key otherwise | sessions.json | _save | session-manager.test.js preserve-tree-handoff.test.js |
| `setArchived` | stamps or clears archivedAt | sessions.json | _save | preserve-census.test.js |
| `setExited` | stamps or clears exitedAt, exitCode and exitSignal, skipping a write that clears nothing | sessions.json | _save | preserve-census.test.js |
| `setIo` | stores io as stream or pty, always explicit | sessions.json | _save | stores.test.js stream-seat-restart.test.js |
| `setVoice` | stores a VOICE_MODES voice mode; false on a bad mode or missing record | sessions.json | _save | stores.test.js voice-engine.test.js |
| `setRosterSent` | stamps rosterSentAt with now | sessions.json | _save | stores.test.js session-manager.test.js |
| `setIntents` | stores any array (even empty) as the intent allowlist and deletes the key on null, so the seat follows the living default | sessions.json | _save | stores.test.js plugin-scope.test.js |
| `setPluginGrants` | stores pluginId:capability grant tokens; an absent key means no plugin reaches the seat | sessions.json | _save | plugin-scope.test.js |
| `setPlugins` | stores the per-seat plugin allowlist, where an empty array is a real value | sessions.json | _save | plugin-scope.test.js session-manager.test.js |
| `setCwd` | stores cwd only when it is a non-empty string | sessions.json | _save | stores.test.js session-move.test.js |
| `setExecCommands` | stores a non-empty exec command list, deleting the key otherwise | sessions.json | _save | session-manager.test.js |
| `setEnv` | stores a copy of a non-empty env object, deleting the key otherwise | sessions.json | _save | stores.test.js session-args.test.js |
| `setStripLevel` | stores the wirescope strip level as a divergence and migrates off the legacy stripThinking boolean | sessions.json | _save | stores.test.js default-set-seeding.test.js |
| `setAutoCompact` | stores only the autoCompact false opt-out, deleting the field to enable | sessions.json | _save | resolve-seat-shape.test.js |
| `markDigested` | appends a session id to digested, deduped and capped at the last 50 | sessions.json | _save | hint-arm.test.js memory-load.test.js |

### Invariants
- `_save` refuses (returns false, logs once per unreadable stretch, re-armed when `_load` finds the file readable) while `_load` has flagged sessions.json unreadable, so persistence skips rather than throws and never replaces a file it could not read.
- `_save` snapshots the pre-launch sessions.json to .bak once per process, and only when the current file parses.
- `remove` is the single record drop, and CLAUDE.md's record-dropper list (kill, destroy, Delete Session, Delete Workspace, forget, team-retire discard, reviewer graveyard, spawn-failure rollbacks including the remote import-create rollback, and the gated natural-exit drop of a non-agent session) is the full set of its callers.
- `remove` passes no touched name to `_save`, so it leaves the seat.json mirror of the dropped record as it is.
- `_writeSeatJson` writes only into an existing seat dir, so a mirror never creates a seat directory.

### Hazards
- A new call site of `remove` that is not on CLAUDE.md's record-dropper list is a record dropped where nobody expects one; an archive is usually what was meant.
- A setter that calls `_save` without the touched name leaves seat.json stale against sessions.json.
- Reading a store value through `_load` and writing it back after `_save` returned false treats a refused write as persisted.

## Template library (library/templates) — _file … saveByName

| symbol | purpose | state | calls | pins |
|---|---|---|---|---|
| `_file` | the confined path of one library file; a name that escapes its root throws | none | path-confine.confineOrThrow | unpinned |
| `_sameFile` | true when two template names resolve to one inode (a case-only rename on a case-insensitive disk) | none | _file | unpinned |
| `_read` | one parsed template, or null for a refused name, a missing file or bad JSON | registryDir/library/templates/<name>.json | _file | path-confine.test.js |
| `_write` | writes one template at mode 0600 with its id dropped and its name stamped | registryDir/library/templates/<name>.json | ensureDir, _file | unpinned |
| `save` | edit-save with rename-in-place: throws without a string name; carries forward only non-editor-owned keys of the prior file named by a string id, then removes the old name | registryDir/library/templates/*.json | _read, _write, _sameFile | stores.test.js |
| `saveByName` | overwrites the case-insensitively matching template, keeping its original filename casing | registryDir/library/templates/*.json | _write | stores.test.js app-menus-plugins.test.js |

### Invariants
- `_file` confines the suffixed basename, because the suffix is what becomes a path.
- `save` treats an omitted EDITOR_OWNED key as cleared by the user and carries only the other keys forward from the prior file.
- The filename stem is canonical: `list` and `_write` overwrite the stored name and id with it.

### Hazards
- A key that collectFormConfig in renderer.js omits conditionally but EDITOR_OWNED does not list is resurrected by `save` after the user clears it.
- `save` trusts the caller to have checked a destination-name collision, so a rename onto an existing template overwrites it.
- Templates are written with a plain write at 0600 rather than atomically, so `_write` can leave a torn file on a crash.

## workspaces.json — setName … sortedByRecent

| symbol | purpose | state | calls | pins |
|---|---|---|---|---|
| `_load` | workspaces: the workspace list, or the default workspace when the file is unreadable | workspaces.json, this._unreadable | readStoreJson | stores.test.js |
| `_save` | workspaces: atomic whole-list write; throws the refusal when the file was unreadable | workspaces.json | refuseUnreadable, fs-util.atomicWriteFileSync | stores.test.js |
| `list` | workspaces: every workspace, writing the default one when the file is empty | workspaces.json | _load, _save | stores.test.js |
| `setName` | renames one workspace by id; throws on a name with control characters | workspaces.json | _save | stores.test.js |
| `setBounds` | stores one workspace's window bounds | workspaces.json | _save | unpinned |
| `setView` | shallow-merges a view patch into one workspace | workspaces.json | _save | stores.test.js restore-active-tab.test.js |
| `setZoomFactor` | stores a non-1 zoom factor, deleting it at 1 | workspaces.json | _save | stores.test.js |
| `touch` | stamps lastFocusedAt on one workspace | workspaces.json | _save | stores.test.js |
| `setOpen` | stores open true, deleting the key when closed | workspaces.json | _save | stores.test.js |
| `sortedByRecent` | the workspace list newest-focused first | workspaces.json | list | stores.test.js teams-menu.test.js |

### Invariants
- `_load` answers an unreadable workspaces.json with the default workspace so readers still resolve it, while `_save` throws through `refuseUnreadable` instead of writing.
- Every workspaces setter such as `touch` reloads the whole file and writes the whole list, so there is no cached copy to go stale.

### Hazards
- Catching the throw from `_save` in a caller and carrying on hides that the edit was not persisted.
- `list` writes on a read when the file is empty, so a read path can create workspaces.json.

## Prompt library and legacy migrations — _dir … migrateTemplatesJson

| symbol | purpose | state | calls | pins |
|---|---|---|---|---|
| `_dir` | the confined library/prompts/<kind> dir; kind is caller-supplied on every verb | none | path-confine.confineOrThrow | path-confine.test.js |
| `slugifyPromptName` | a lowercase filename-safe slug of a legacy prompt title, with a timestamped fallback | none | none | unpinned |
| `migratePromptsJson` | one-shot: copies legacy prompts.json entries into library/prompts/append as .md files, then renames the source .migrated | userData prompts.json, registryDir/library/prompts/append/*.md | slugifyPromptName, _file | unpinned |
| `migrateTemplatesJson` | one-shot: copies legacy templates.json entries into library/templates, first slug wins, then renames the source .migrated | userData templates.json, registryDir/library/templates/*.json | _file | stores.test.js |

### Invariants
- `_dir` confines the kind segment because list, raw and remove take it unchecked; only save allow-lists it against PROMPT_KINDS.
- A prompt's kind is its subfolder, not frontmatter, because a system prompt reaches the CLI verbatim through `_dir`'s file.
- `migrateTemplatesJson` drops an entry whose slug is empty rather than minting a timestamped name, and never overwrites an existing file.

### Hazards
- Folding the confinement of `_dir` into the save-only kind check lets list and remove escape the library root.
- Both migrations rename their source only after the loop, so a crash inside `migratePromptsJson` reruns it and skips files that already exist.

## agent-defaults.json — getStrip … setDefaultBuiltinDeny

| symbol | purpose | state | calls | pins |
|---|---|---|---|---|
| `getStrip` | the stored strip level (1 or 2) for one agent name, 0 when unset | agent-defaults.json | _load | stores.test.js |
| `setStrip` | stores or clears one agent's strip level | agent-defaults.json | _save | stores.test.js |
| `getDefaultDeny` | the default tool deny list: the user's list when present (even empty), else the in-code floor | agent-defaults.json | _load | stores.test.js optimized-mode-subset.test.js |
| `setDefaultDeny` | stores the default tool deny list under the reserved star key | agent-defaults.json | _save | stores.test.js |
| `getDefaultSkillDeny` | the default skill deny list, floor when absent; a stored plain list is rewritten once into the deferred form over the known skill names and saved, unless skills-seen.json is unreadable or was quarantined this launch | agent-defaults.json | skills-off.deferredSkillDeny, setDefaultSkillDeny, skillsSeen.readable | stores.test.js optimized-late-skills.test.js |
| `setDefaultSkillDeny` | stores the default skill deny list | agent-defaults.json | _save | stores.test.js |
| `getDefaultBuiltinDeny` | the default builtin-agent deny list, user list or floor | agent-defaults.json | _load | stores.test.js |
| `setDefaultBuiltinDeny` | stores the default builtin-agent deny list | agent-defaults.json | _save | stores.test.js |

### Invariants
- Each default deny list is tri-state: an absent key means the floor, and a present empty array means deny nothing, which `getDefaultDeny` honours.
- The defaults live under a star key, which is not a legal session name, so `setDefaultDeny` cannot collide with a per-agent entry.
- `setStrip` and every other writer here save only after a `_load` through `readStoreJson`: an unparseable agent-defaults.json is quarantined, and an unreadable one makes the save throw through `refuseUnreadable`.

### Hazards
- Treating an empty list in `getDefaultSkillDeny` as absent re-imposes the floor on a user who chose deny nothing.
- `getDefaultSkillDeny` is a read that writes: the first read of a stored plain list rewrites agent-defaults.json through `setDefaultSkillDeny`, so a caller expecting a pure getter gets a disk write; not while unreadable, where `_load` yields no stored list and the floor is returned unwritten.

## Agent, skill and exec libraries — listFor … raw

| symbol | purpose | state | calls | pins |
|---|---|---|---|---|
| `list` | agentLibrary, skillLibrary, execLibrary: every parseable file in the library dir keyed by filename stem, sorted, skipping unreadable files | agents/*.md, skills/*.md, library/exec/*.json under registryDir | agents-util.parseAgentFrontmatter, skills-util.parseSkillFrontmatter | stores.test.js library-agents-seed.test.js |
| `listFor` | agentLibrary and skillLibrary: list filtered to items whose scope is visible to a workspace and session context | as list | scope-util.visibleTo | stores.test.js |
| `raw` | the bytes of one library file, or null for a missing file or a refused name | as list | _file | stores.test.js |
| `save` | validates the name and writes the file at 0600 (exec content is not parsed), returning the fresh list | as list | _file | stores.test.js |
| `remove` | agentLibrary, skillLibrary, execLibrary: a refused name throws, a missing file is silent; returns the fresh list | as list | _file | stores.test.js |

### Invariants
- Identity is the filename stem everywhere; frontmatter name is informational only, so `list` never keys off it.
- `remove` resolves `_file` outside its try, so a refused name throws rather than reading as a successful delete.
- `listFor` is the scoped view for the offer surfaces, while `list` stays unfiltered for the library drawer.

### Hazards
- Moving `_file` inside the try in `remove` turns a path-escape refusal into a silent no-op.
- `save` writes non-atomically and does not validate exec JSON, so a malformed exec file is only skipped later by `list`.

## reminders.json — _mintId … renameAgent

| symbol | purpose | state | calls | pins |
|---|---|---|---|---|
| `_load` | reminders: the reminder array, or empty on absence, quarantine, unreadability or a non-array | reminders.json, this._unreadable | readStoreJson | stores.test.js |
| `_mintId` | a 6-char lowercase base36 id unique in the current array, falling back to a time-based id | none | none | unpinned |
| `listForAgent` | the reminders owned by one seat name | reminders.json | _load | remind-scheduler.test.js stores.test.js |
| `add` | reminders: appends a record with id, createdAt, lastFiredAt null and ticket only when bound, and persists it; throws when the write fails | reminders.json | _mintId, _save | stores.test.js session-manager.test.js |
| `markFired` | stamps lastFiredAt and the next fire time on one reminder | reminders.json | _save | stores.test.js |
| `renameAgent` | moves every reminder of a renamed seat to the new name, returning the count | reminders.json | _save | remind-scheduler.test.js stores.test.js |

### Invariants
- `_mintId` ids stay pure lowercase base36 with no separator, because a remind cancel token must satisfy the scheduler's id pattern.
- `add` spreads ticket only onto bound records, so unbound records stay byte-identical and cancelForTicket selects on presence.
- This store does no timing: `add` round-trips nextFireAt, null for the event-driven on-compact form.
- `_load` goes through `readStoreJson`: an unparseable reminders.json is quarantined, and an unreadable one makes every `_save` throw through `refuseUnreadable` until a later `_load` reads it.

### Hazards
- `markFired` and `remove` log and ignore a failed write because `_fireRecord` calls them unguarded from the timer; making them throw takes the timer down.

## notifications.json (inbox) — onChange … unreadCount

| symbol | purpose | state | calls | pins |
|---|---|---|---|---|
| `onChange` | registers an inbox change listener; there is no unsubscribe | this._listeners | none | notification-page.test.js remote-inbox.test.js |
| `_emit` | fans a change payload to every listener, swallowing listener throws | this._listeners | none | remote-inbox.test.js |
| `page` | a newest-first page of notes older than a cursor, limit clamped to 1..200, plus hasMore | notifications.json | _load | notification-page.test.js |
| `markRead` | stamps readAt once on one note and emits read; false only for an unknown id | notifications.json | _save, _emit | notification-page.test.js stores.test.js |
| `markAllRead` | stamps every unread note with one timestamp, emitting only when something changed; returns the count | notifications.json | _save, _emit | notification-page.test.js stores.test.js |
| `unreadCount` | the number of notes with a null readAt | notifications.json | _load | remote-inbox.test.js stores.test.js |

### Invariants
- The inbox store emits every add, read, read-all and remove through `_emit`, which is what keeps the drawer and the remote inbox live.
- `markAllRead` emits only when it changed something, so an idle read-all does not wake listeners.
- `_load` goes through `readStoreJson`: an unparseable inbox is quarantined, and an unreadable one makes every `_save` throw through `refuseUnreadable`, so `add` throws before it emits.

### Hazards
- `onChange` has no unsubscribe, so a caller that registers per window or per connection leaks listeners for the process lifetime.

## ui-settings.json — warnUiSettingsMode … set

| symbol | purpose | state | calls | pins |
|---|---|---|---|---|
| `warnUiSettingsMode` | warns once per process when ui-settings.json, which holds peer tokens, is group- or world-readable | uiSettingsModeChecked | none | unpinned |
| `uiSettingsQuarantined` | true when this launch or an earlier one moved a corrupt ui-settings.json aside | quarantinedFiles, uiSettingsQuarantineOnDisk | none | unpinned |
| `_load` | uiSettings: the fully sanitized settings object with legacy keys migrated and per-field defaults | ui-settings.json (read), this._unreadable | readStoreJson, sanitizePeers, legacyShellGrant, sanitizeTerminalReports | ui-settings-plugins.test.js default-session-mode.test.js |
| `get` | uiSettings: the loaded settings with env overrides applied to the wirescope and remote ports, remoteBasePath and proxyUrl | none | _load, service-ports.resolveProxyUrl | ctx-thresholds.test.js default-session-mode.test.js |
| `set` | uiSettings: merges a partial update onto the stored settings with per-field keep, replace and clear rules, writes atomically, returns it env-resolved | ui-settings.json (mode 0600 via the atomic write) | _load, refuseUnreadable, sanitizePeers, fs-util.atomicWriteFileSync | ctx-thresholds.test.js intent-spill-pref.test.js peer-import.test.js |

### Invariants
- `set` throws through `refuseUnreadable` when `_load` found ui-settings.json unreadable, so stored peer tokens are never replaced by defaults.
- A quarantined file reads as defaults with terminalReports resolved as an upgrade, not a fresh install, which `uiSettingsQuarantined` decides.
- ui-settings.json is a cross-package contract: cli/src/import.js reads its remotePort, remoteEnabled and peers directly, so the shapes `set` writes for them cannot change without cli/.
- remote.env beside it is owned by remote-token.js, not by a store here; cli/src/import.js reads it with ui-settings.json, which `initStores` has no path for.
- `warnUiSettingsMode` checks the mode once per process only; every write already lands 0600 through the atomic write in `set`.

### Hazards
- `get` and `set` return env-resolved ports, remoteBasePath and proxyUrl, so feeding `get` output back into `set` bakes an env override onto disk.
- In `set`, plugins is a whole-bag replace, ctxReminderThresholds a per-row merge and pendingRebootNotice presence-keyed; swapping any rule makes a deletion unrepresentable or drops rows.
- Collapsing the absent-versus-blank split for voiceSubmitPhrase or speakVoice in `set` makes clear-to-default keep the custom value.
- peerShellEnabled in `_load` must key on the presence of the raw peerShellEnabled key, not its type, or a junk value falls through to the legacy grant read by `legacyShellGrant`.

## skills-seen.json, setup.json and the workspace-scope rewrite — record … renameWorkspaceScope

| symbol | purpose | state | calls | pins |
|---|---|---|---|---|
| `readable` | skillsSeen: re-reads skills-seen.json and reports false when it is unreadable or was quarantined this launch | skills-seen.json, quarantinedFiles | list | stores.test.js |
| `record` | unions new skill names into skills-seen.json, writing only when the set grew | skills-seen.json | list, refuseUnreadable, fs-util.atomicWriteFileSync | optimized-late-skills.test.js |
| `read` | setupMarker: first-run setup is done only when setup.json parses with a string completedAt | setup.json under registryDir | none | first-run-setup.test.js |
| `write` | setupMarker: stamps completion time, version and a SETUP_CHOICES choice (default skipped); a write error reaches the caller | setup.json under registryDir | fs-util.atomicWriteFileSync | first-run-setup.test.js |
| `renameWorkspaceScope` | rewrites workspace frontmatter from an old to a new display name across agent and skill .md files, leading fence only; refuses (0, logged) a new name holding a line break (CR, LF, U+2028, U+2029) or wrapped in matching quotes; returns the count | agents/*.md, skills/*.md under registryDir | fs-util.atomicWriteFileSync | stores.test.js |

### Invariants
- `renameWorkspaceScope` matches the trimmed old name exactly, the same comparison visibleTo makes, so a rename cannot orphan a scoped item it would otherwise match.
- `record` writes only on growth, so a steady-state skill roster never rewrites the file.
- `record` reads through `readStoreJson` via list: an unparseable skills-seen.json is quarantined, and an unreadable one makes `record` throw through `refuseUnreadable` instead of writing.

### Hazards
- Unlike the other small stores, setupMarker `write` lets a write error propagate, so its caller must handle the throw.

## Library seeding — sha256 … seedLibraryDefaults

| symbol | purpose | state | calls | pins |
|---|---|---|---|---|
| `sha256` | hex SHA-256 of a buffer, the seed manifest's content identity | none | none | stores.test.js |
| `seedRoot` | reconciles one shipped seed tree into its destination by hash manifest: unedited copies upgrade, edited ones are kept, withheld updates are reported once | destRoot files, destRoot/.seed-state.json, destRoot/.seed-report.json, notifications.json | sha256, fs-util.atomicWriteFileSync, notifications add | unpinned |
| `seedLibraryDefaults` | seeds the library, skills and agents trees from resources, refusing under node --test when registryDir resolves (or realpaths) to the real ~/.clodex | registryDir/library, skills, agents | seedRoot | stores.test.js engine-registry-dir-seam.test.js |

### Invariants
- `seedRoot` overwrites a present file only when it still matches its stamp and the shipped bytes moved; a file matching neither is stranded and reported, never repaired.
- `seedRoot` rebuilds the report from the current stranded set and advances an announced hash only after reading the inbox note back.
- `seedRoot` is best-effort: a failed read or copy is logged and skipped, never thrown out of `initStores`.
- `seedLibraryDefaults` refuses the real home under node --test, so a suite never seeds the live library from a checked-out branch.

### Hazards
- Overwriting a stranded file in `seedRoot` destroys an operator edit, because a stale shipped copy and an edit have the same hash shape.
- The dedupe token of `seedRoot` lives under registryDir while the inbox lives under userData, so two hosts with different data dirs share one token.

## env-scopes.json and shipped env defaults — safeScope … restore

| symbol | purpose | state | calls | pins |
|---|---|---|---|---|
| `safeScope` | admits global or any scope other than the prototype-polluting names | none | none | unpinned |
| `_load` | envScopes: global, workspaces and seeded from env-scopes.json, an empty shape when absent or not an object | env-scopes.json, this._unreadable | readStoreJson | env-defaults-seed.test.js |
| `_save` | envScopes: atomic whole-object write then a 0600 chmod; refuses an unreadable file and rethrows a write error | env-scopes.json (mode 0600) | refuseUnreadable, fs-util.atomicWriteFileSync | env-defaults-seed.test.js |
| `getScope` | one scope's KEY-to-value-and-secret map, or empty for an unsafe or unknown scope | env-scopes.json | safeScope, _load | stores.test.js env-scopes-ipc.test.js |
| `all` | the whole loaded env-scopes object, values unmasked | env-scopes.json | _load | stores.test.js stream-idle-default.test.js |
| `set` | envScopes: validates scope, key and value (throwing on either) and writes one value-and-secret entry | env-scopes.json | safeScope, env-scopes.envKeyError, _save | stores.test.js env-defaults-seed.test.js |
| `removeWorkspace` | drops a whole workspace scope, saving only if it existed | env-scopes.json | _save | stores.test.js |
| `platformAppDataDir` | the per-platform app-data root the real userData dir sits in: Application Support on darwin, APPDATA on win32, XDG_CONFIG_HOME or ~/.config elsewhere | none | os.homedir | env-defaults-seed.test.js |
| `refuseEnvWriteUnderTest` | true, with a warning, under node --test when the directory env-scopes.json lives in is clodex (any case) under the platform app-data root | none | platformAppDataDir | env-defaults-seed.test.js |
| `seedEnvDefaults` | seeds each shipped env default into the global scope once, recording it in seeded so a deletion is not re-seeded | env-scopes.json | env-defaults.planEnvSeed, _save | env-defaults-seed.test.js session-manager.test.js |
| `restore` | forgets the seeded mark of every shipped key and re-seeds, bringing deleted defaults back without touching user values | env-scopes.json | seedEnvDefaults | env-defaults-seed.test.js |

### Invariants
- `_save` throws through `refuseUnreadable` when env-scopes.json was unreadable, so seeding at startup can no longer wipe secret values it could not read.
- `_save` reasserts mode 0600 after every write, because the file holds secret values at rest; reads never mask.
- Every workspace-scope lookup in `getScope` and `set` goes through an own-property check behind `safeScope`, so an inherited name never resolves to a prototype member.
- The seeded list written by `seedEnvDefaults` is what keeps a user-deleted default from returning on every launch.

### Hazards
- A default written by `seedEnvDefaults` without appending to seeded is re-seeded forever after the user deletes it.
- `restore` must clear seeded before seeding again, and user values survive only because planEnvSeed skips keys already present.
- `refuseEnvWriteUnderTest` keys on the env store's own directory against the default userData location, so a CLODEX_DATA_DIR pointed elsewhere is not recognised as real; under node --test that dir is always a temp one.
- Converting the throw in `set` to a silent return removes the error message its IPC callers surface.

## EXEMPT
