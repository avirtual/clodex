# `plugins/` — in-repo, first-party plugin directories

One subdirectory per plugin, discovered by scanning `plugins/*/manifest.json`
(see `plugin-plan.md` (internal design doc, not in this repo) §3.1). The directory is **empty of plugins in Phase 0
and Phase 1** — the registries land in core first and core populates them; the
workbench pilot (Phase 2) is the first real inhabitant.

```
plugins/<id>/
  manifest.json      { id, name, version, hostApi, entry, style?, announce? }
  engine.js          → { activate(host), deactivate() }   // plain Node, electron-free
  renderer.js        → { activate(rhost) -> dispose? }    // DOM, loaded per window
  style.css          → injected per-plugin per-window
```

## Rules that the test suite enforces

- **No electron.** `test/electron-boundary.test.js` walks every engine half here
  and fails on a `require('electron')`. A plugin engine half is plain Node for
  the same reason the rest of the engine is: the headless host stands the same
  engine up with no Electron at all.
- **No backdoors.** `test/plugin-boundary.test.js` walks every file here and
  allows only relative requires that stay INSIDE the plugin's own directory,
  plus node builtins. Core internals (`../../session-manager`, `electron`,
  `window.api`, …) are reachable **only** through the `host` / `rhost` argument
  — that argument is the versioned surface, and reaching around it is exactly
  the "core with hardcoded friends" coupling the plan exists to kill.
- **Kill switch.** `CLODEX_PLUGINS=0` skips the loader entirely; the app must
  work with nothing here loaded.
