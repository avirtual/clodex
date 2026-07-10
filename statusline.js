// Statusline script generation + proxy-base resolution for CLI sessions.
// Renders the bash statusline Claude re-reads on each update (and the Codex
// `-c tui.status_line` arg), plus the tri-state proxy-base resolver they share
// (headless statuslines suppress the visible line when a session is proxied).
// Seam: the two stateful inputs — the ui-settings store and the registry dir —
// are INJECTED as explicit params (uiSettings, registryDir) rather than reached
// for as main.js globals, so a fake settings store makes the whole script
// output unit-testable without booting the app. rebuildAllStatusScripts stays
// in main.js (it iterates the live SessionManager) and calls these.
//
// The ctx side-channel path is JS-interpolated (the agent name is known at
// generation), so it routes through clodex-paths.pathFor directly — no runtime
// bash mirror needed (unlike the Codex hook, which resolves $NAME at runtime).
// Gotcha: renderClaudeStatusScript builds a bash HEREdoc — backslashes and `${}`
// inside the returned template are shell/awk syntax, not JS interpolation; edit
// with care. `headless` writes only the ctx side-channel (window SIZE is off the
// wire — the CLI is its sole source) and suppresses the default component line.

const { pathFor } = require('./clodex-paths');

// Render Claude's statusline bash script based on user-selected components.
// Session name prefix is always shown. Components: model, context, cost,
// cwd, git-branch. Context % is a byte-count estimate (bytes/5 ≈ tokens
// vs 200k budget) — cheap and monotonic enough for a status indicator.
//
// If the user configured a custom statusline command (Preferences), the
// generated script becomes a wrapper: it still writes the ctx side-channel
// (the sidebar badge depends on it), exports CLODEX_AGENT_NAME for the
// custom script, pipes the statusline JSON through the command, and falls
// back to the built-in component line when the command fails or prints
// nothing (e.g. a $CLAUDE_PROJECT_DIR-relative script missing in this repo).
// `headless` (set for proxy-routed sessions): suppress the visible component
// line — wirescope's status bar already renders model/ctx/turn/cache/cost live,
// so the in-terminal statusline would just double it. The script still RUNS to
// write the -ctx side-channel: the context-window SIZE is off-wire (the proxy
// only has the token count), so the CLI is the sole source of the bar's
// denominator. A WORKING custom command still prints (the user opted in); only
// the default-component-line fallback is suppressed under headless, so a
// missing/failing custom command goes blank rather than resurrecting the line.
function renderClaudeStatusScript(name, headless, uiSettings, registryDir) {
  const sl = uiSettings.get().statusline;
  const enabled = new Set(sl.claude);
  const customCmd = (sl.claudeCommand || '').trim();
  const pieces = [`\\033[36m[clodex:${name}]\\033[0m`];
  const fmt = [];
  const vars = [];
  if (enabled.has('model')) { pieces.push('\\033[33m%s\\033[0m'); fmt.push('$MODEL'); vars.push('MODEL'); }
  if (enabled.has('context')) { pieces.push('\\033[90mctx %s\\033[0m'); fmt.push('$CTX_PCT'); vars.push('CTX_PCT'); }
  if (enabled.has('cost')) { pieces.push('\\033[35m%s\\033[0m'); fmt.push('$COST'); vars.push('COST'); }
  if (enabled.has('git-branch')) { pieces.push('\\033[34m%s\\033[0m'); fmt.push('$BRANCH'); vars.push('BRANCH'); }
  if (enabled.has('cwd')) { pieces.push('\\033[32m%s\\033[0m'); fmt.push('$SHORT_CWD'); vars.push('SHORT_CWD'); }
  const format = pieces.join(' ');
  const branchSh = enabled.has('git-branch')
    ? `BRANCH="$(cd "$CWD" 2>/dev/null && git symbolic-ref --short HEAD 2>/dev/null || echo "")"`
    : '';
  return `#!/bin/bash
INPUT="$(cat)"
IFS=$'\\t' read -r MODEL CTX_NUM CTX_PCT COST CWD CTX_TOK CTX_SIZE MODEL_ID <<<"$(echo "$INPUT" | jq -r '[
  (.model.display_name // "?"),
  ((.context_window.used_percentage // 0) | floor | tostring),
  (((.context_window.used_percentage // 0) | floor | tostring) + "%"),
  ("$" + (((.cost.total_cost_usd // 0) * 100 | floor) / 100 | tostring)),
  (.workspace.current_dir // .cwd // ""),
  ((.context_window.total_input_tokens // 0) | floor | tostring),
  ((.context_window.context_window_size // 0) | floor | tostring),
  (.model.id // "")
] | @tsv' 2>/dev/null)"
SHORT_CWD="\${CWD##*/}"
${branchSh}
# Side-channel for Clodex: "<pct>\\t<used_tokens>\\t<window_size>\\t<model_id>".
# pct stays the first field so legacy parseInt readers (sidebar badge) are
# unaffected; the token counts feed the proxy bar's absolute "used/size"
# display; model_id lets the app correct the window size the CLI under-reports
# for 1M models (MODEL_WINDOWS in argv-merge.js).
printf '%s\\t%s\\t%s\\t%s' "\${CTX_NUM}" "\${CTX_TOK}" "\${CTX_SIZE}" "\${MODEL_ID}" > "${pathFor(registryDir, name, 'ctx')}" 2>/dev/null || true
${customCmd ? `export CLODEX_AGENT_NAME="${name}"
OUT="$(printf '%s' "$INPUT" | ( ${customCmd} ) 2>/dev/null)"
if [ -n "$OUT" ]; then
  printf '%s\\n' "$OUT"
  exit 0
fi
` : ''}${headless ? ': # headless: side-channel only, wirescope bar shows the line' : `printf '${format}'${fmt.length ? ' ' + fmt.map(v => `"${v}"`).join(' ') : ''}`}
`;
}

function codexStatusLineArg(uiSettings) {
  const list = uiSettings.get().statusline.codex;
  const quoted = list.map(c => `"${c}"`).join(',');
  return `tui.status_line=[${quoted}]`;
}

// Normalize a proxy base URL: trim + drop trailing slashes. Returns null for
// blank input so callers can treat "field left empty" as proxy-off.
function normalizeProxyBase(url) {
  const u = (url || '').trim().replace(/\/+$/, '');
  return u || null;
}

// Resolve a session's tri-state proxy setting to a base URL (or null = no
// proxy). null/undefined = follow the Clodex-level preference; false =
// explicitly off; string = explicit base URL. Resolved at spawn time, so a
// changed global preference applies to inheriting sessions on next respawn.
function resolveProxyBase(proxy, uiSettings) {
  if (proxy === false) return null;
  if (typeof proxy === 'string') return normalizeProxyBase(proxy);
  const s = uiSettings.get();
  return s.proxyEnabled ? normalizeProxyBase(s.proxyUrl) : null;
}

module.exports = {
  renderClaudeStatusScript, codexStatusLineArg, normalizeProxyBase, resolveProxyBase,
};
