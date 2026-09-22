# muse-skills.js — measured facts (Muse Code 1.3.0-R3401.1, 2026-09-22)

## parseSkillsList
- `muse skills list --json` prints `{skills:[{id, scope, path, activation, ...}], diagnostics:[]}`; `scope` is `bundled|plugin|user|project`, ids look like `bundled:git`, `plugin:threejs:threejs`, `foo`. Without `--trust-workspace` project skills are skipped — wanted: a template never turns a seat's project skills off.

## activationBlock
- The activation vocabulary is exactly `on` | `off` | `user-invocable-only`; ANY other value reads as `off` with no diagnostic. There is no launch flag or env var; `settings.json` under `$XDG_CONFIG_HOME/muse/` is the only lever.
- The ONLY shape honoured is `skills.activation.<scope>` tables keyed by the skill's `path` URI (`bundled://muse-core/skills/<dir>/SKILL.md`, `plugin://<plugin>/skills/<dir>/SKILL.md`, `$CONFIG_DIR/skills/<dir>/SKILL.md` stored literally, `projects.<abs ws>.<rel path>`); bare ids or a `built-in` table are silently ignored.

## createSkillLister
- Without `XDG_DATA_HOME` the list writes tracing under `~/.local/share/muse/local-tracing/bootstrap/`, hence the scratch data home. A meta-provider list is local (no model request); it took ~1 s.
