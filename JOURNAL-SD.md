# t1014 — S-D intent-spill: on by default, per-request gate

Branch t1014-s-d-intent-spill-on-by-default-and-the, base master 3ce18693 (ancestor confirmed).

## What changed
- stores.js:104,1444 — `intentSpill` default and absent/junk read now `'on'`; explicit `'off'` honoured.
- wire/proxy.js:133 — `this.spillEnabled = typeof opts.spillEnabled === 'function' ? opts.spillEnabled : () => true;`
- wire/proxy.js:317 — `spillEligible` now includes `this.spillEnabled()`, evaluated ONCE per request; the
  `accept-encoding: identity` header and the SpillTee construction both follow that one decision.
- session-manager.js:893 — WireProxy gets `spillEnabled: () => getUiSettings().get().intentSpill === 'on'`.
- session-manager.js:1603 — spawn no longer reads the setting: `spillVerbs` is SPILL_VERBS ∩ enabled intents
  whenever `!backend`; `promptRecipe.spillArmed` and `spillArmedForRecord` are "verbs registered".
- ipc-prompt.js:294 — grammar line reworded to be true in both states ("MAY be stored … a Settings switch,
  on by default; when that happens …"); "Never type `@spill:` yourself" kept verbatim.
- renderer/index.html:1123,1126 — hint reworded, label simplified; web-dist rebuilt via `npm run build:web`.
- docs/architecture.md intent-spill.js bullet — per-request gate paragraph added.
- CHANGELOG `## Unreleased` bullet.

## Tests
- test/intent-spill-spawn-gate.test.js (NEW): spawn with setting OFF still registers spill on the wire;
  the grammar line is in the prompt with the setting OFF and flipping the setting changes zero prompt bytes;
  a Bedrock seat registers `spill: null` and carries no grammar line.
- test/wire-spill-proxy.test.js: +3 subjects (gate off at request time; gate flipped on between two requests;
  gate flipped off mid-stream). `startFakeUpstream` grew `sizes`/`gapMs`/`afterFirstWrite`, `withProxy` grew
  `proxyOpts` — all default to the previous behaviour, existing subjects unchanged.
- test/stores.test.js, test/intent-spill-pref.test.js: defaults flipped to ON; pref test also pins the new hint.
- test/wire-off.test.js: `intentEnabled` added to the injected deps (create() now always reaches it on the
  claude arm; previously the setting-off short-circuit hid it).

## Red-proofs
1. wire/proxy.js:317 — delete `this.spillEnabled() && ` → 13→10 pass; RED: "the gate off at request time…",
   "the gate flipped on between two requests…", "the gate flipped off mid-stream…". Restored, 13 green.
2. wire/proxy.js:425 — `if (spill)` → `if (spill && this.spillEnabled())` (read per chunk) → 13→12;
   RED: "the gate flipped off mid-stream does not disarm the response already in flight". Restored, 13 green.
3. session-manager.js:1603 — restore the old spawn-time `spillArmed` gate → RED: "a Claude seat spawned with
   the setting OFF still registers spill on the wire", "the grammar line is in the prompt with the setting OFF…".
   Restored, 3 green.
4. stores.js:104,1444 — back to `'off'` → 173→170; RED: "uiSettings: intentSpill ships on…", "uiSettings: a
   settings file predating intentSpill reads back ON", "the box round-trips through a real settings store".
   Restored, 173 green.

## Deviations
- Checkbox label shortened to "Spill long intent bodies to files" — the old parenthetical
  "(applies to seats started after the change)" is false under the per-request gate and the spec's replacement
  wording lives in the hint paragraph.
- docs/messaging.md left untouched: its only spill paragraph is MSG_SPILL_THRESHOLD (message spill), a
  different mechanism. No arm-at-spawn sentence exists there or in docs/notes/*.
- No test pinned the session record's `intentSpill` field (2102) or the old spawn-time gating beyond what is
  listed above; nothing was deleted.

## Round 2 — suite fallout (own scope, 73 then 11 failing)
`create()`'s claude arm now ALWAYS reaches `intentEnabled` (the old `setting === 'on'` short-circuit
hid it whenever a harness left the setting unset). 11 spawn-path test harnesses injected no
`intentEnabled` dep and died with `TypeError: intentEnabled is not a function`. Added
`intentEnabled` (from `../intent-catalog`, the real function — it is pure) to the deps of:
agent-plugin-spawn, ephemeral-ctxwarn, notice-queue, optimized-late-skills, plugin-bundle-spawn,
reviewer-shell-deny-plumbing, session-manager (3 rigs), stock-template-tool-floor, wire-off,
createdat-restart, ipc-prompt-cache-rework, session-move. No subject rewritten, none deleted.
Also added `clx-spillgate-` (the new test file's tmp prefix) to scripts/tmp-sweep.sh's PREFIXES,
which `test/tmp-sweep-prefix-coverage.test.js` requires.

own digest after: `own: 4303/4303 green (2m 04s) — 171 files: 16 changed, 147 by subject, 8 scanners`.
