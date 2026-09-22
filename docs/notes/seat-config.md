# seat-config.js — measured facts (Muse Code 1.3.0, 2026-09-22)

## bootstrapSeatConfig
- Muse has no config-dir variable of its own (`strings muse` names only `XDG_CONFIG_HOME` and `MUSE_*` runtime flags), so a per-seat config can only ride `XDG_CONFIG_HOME` — which `gh` (`~/.config/gh`) and git (`~/.config/git`) also read. Hence the overlay: every other `~/.config` entry is symlinked into the seat dir, only `muse/` is real.
- `auth.json` (schema_version 2, `storage: "keychain"`) and `trust.json` are required: without them the seat has no login and no trust decision, so their absence throws before anything is written. `settings.json` is optional and defaults to `{"schema_version":1}`; unknown top-level members are warned and ignored by Muse, a wrong-typed known member is fatal.
- `$XDG_CONFIG_HOME/muse/AGENTS.md` is loaded as a USER-scope rules file (`<rules-file scope="user">` at `session_start`); `$XDG_CONFIG_HOME/muse/rules/*.md` is not read. Project rules win over user rules on conflict.
- The seat dir is `run/<name>/xdg` (`KINDS.seatConfig`): dropped at kill like every other kind (`cleanupMuseSeat` → `dropRunDir`, the same `run/<name>/` removal Claude and Codex seats get), and rebuilt with `rm -rf` + mkdir on every `create()`.

## findMuseTranscript
- Session logs live at `<XDG_DATA_HOME|~/.local/share>/muse/sessions/<yyyy>/<mm>/<dd>/<sid>/session.jsonl`. Whether the date is local or UTC is unmeasured, so the finder globs the three date levels and never computes a date.

## museRegistryFor
- A live TUI writes `<data>/muse/runtime/muse/sessions/<sid>.json`: `{schema_version, session_id, session_name, endpoint_hint, workspace_label, target_eligibility, process_generation_hint: "pid=<pid>"}` — no top-level `pid` field on 1.3.0, so the hint is matched first and a `pid` field second.
- A fresh interactive `muse` writes `session.jsonl` at boot with nothing typed (measured, 1.3.0, echo provider: ~0.25 s after spawn, ~4.4 KB of boot records) and the registry record ~0.1 s after that; the poller in session-manager.js still waits for the FILE, not the record.
- Muse validates the registry root and skips the record silently when it fails: a data home under `/private/tmp` (macOS `$TMPDIR`, the test scratchpad) gets `session.jsonl` but never a record. Measure under `$HOME` with a mode-0700 `XDG_DATA_HOME`.
