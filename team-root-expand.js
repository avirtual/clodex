// ${TEAM_ROOT} expansion for the two sites that consume a TEMPLATE's `cwd`:
// the lead's `[agent:spawn name:X template:Z]` with no explicit cwd:
// (team-tickets.js) and the GUI's template dropdown (renderer.js). The exec
// registry has its own copy of this token (session-manager.js, expandVars) and
// keeps it — it expands three tokens over argv AND cwd against a live session,
// and folding two different substitution sets into one function to share four
// lines would couple a spawn path to the exec path's token list.
//
// Same property, stated there and preserved here: substituting a WRONG root is
// worse than not substituting at all, because the seat boots successfully in
// another project's tree and everything downstream looks like its own work. So
// an unresolved root is a REFUSAL, never a silent empty string — the caller
// reports it and does not spawn.
//
// NOT applied to the template EDITOR (openTemplateEditor): authoring a template
// must round-trip the literal token to disk, and expanding on load would write
// the author's own root back into the file — recreating the hardcoded-path trap
// this exists to remove.
const TEAM_ROOT_TOKEN = '${TEAM_ROOT}';

function usesTeamRoot(value) {
  return typeof value === 'string' && value.includes(TEAM_ROOT_TOKEN);
}

// Returns {ok:true, value, expanded} or {ok:false, reason}. `reason` is a
// caller-agnostic sentence: team-tickets replies with it over the spawn
// channel, the renderer toasts it.
//
// A whitespace-only root counts as UNRESOLVED. A root of " " would expand to a
// path that resolves relative to the process cwd, which is the wrong-tree bug
// wearing a success result.
function expandTeamRoot(value, teamRoot) {
  const s = value == null ? '' : String(value);
  if (!usesTeamRoot(s)) return { ok: true, value: s, expanded: false };
  const root = typeof teamRoot === 'string' ? teamRoot.trim() : '';
  if (!root) {
    return {
      ok: false,
      reason: '${TEAM_ROOT} does not resolve here — this session is not inside a team\'s root. '
        + 'Spawn with an explicit cwd:, or run from the team root.',
    };
  }
  return { ok: true, value: s.split(TEAM_ROOT_TOKEN).join(root), expanded: true };
}

module.exports = { TEAM_ROOT_TOKEN, usesTeamRoot, expandTeamRoot };
