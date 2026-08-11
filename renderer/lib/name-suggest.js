// name-suggest.js — pure name-suggestion leaf for the New Session dialog.
//
// The dialog's default suggestion is `session-<counter>`, minted before the
// global reserved-name set (live + persisted/archived across every workspace —
// Task 15) has been prefetched. When the counter collides with an archived or
// cross-workspace name, the user's first Create would bounce with the clear
// (but avoidable) name-taken error. bumpDefaultName advances the suggestion past
// the reserved set once it lands — the same collision-avoidance the team-join
// suggestion does inline, factored out here so it can be unit-tested.

// Advance `base` to the first free name not in `reserved` (a Set or an
// array of taken names). If `base` itself is free, it's returned untouched.
// A trailing integer is incremented (`session-1` → `session-2` → …) so the
// suggestion stays in `session-N` form; a base without a trailing number gets
// a `-2`, `-3`, … suffix instead (matching the team-name dedup style).
function bumpDefaultName(base, reserved) {
  const taken = reserved instanceof Set ? reserved : new Set(reserved || []);
  if (!taken.has(base)) return base;
  const m = /^(.*?)(\d+)$/.exec(base);
  const prefix = m ? m[1] : `${base}-`;
  let n = m ? Number(m[2]) + 1 : 2;
  while (taken.has(`${prefix}${n}`)) n++;
  return `${prefix}${n}`;
}

// A team name the Create Team… dialog may safely PROPOSE, given an already
// slugified basename and the taken names. Two constraints bind a team name that
// do not bind a session name, so slugifyTeamName (shared with the new-session
// dialog) is deliberately left alone and narrowed here instead:
//
//   - a leading '.' is refused by createTeam — listTeams skips dot-directories,
//     so the team would be written and then invisible. slugifyTeamName strips a
//     leading '-' but not a '.', so a root of `…/.dotfiles` proposed `.dotfiles`.
//   - the DEFAULT lead seat is `<team>-lead`, so a team name over 59 chars mints
//     a seat past the 64-char NAME_RE limit (team-manifest.js).
//
// Both refusals would otherwise land on a name the operator never typed. The
// clamp is applied after the dedupe too: a `-2` suffix must not push it back over.
const TEAM_NAME_MAX = 64 - '-lead'.length;

function teamNamePrefill(slug, taken) {
  const base = String(slug || '').replace(/^\.+/, '').slice(0, TEAM_NAME_MAX);
  if (!base) return '';
  return bumpDefaultName(base, taken).slice(0, TEAM_NAME_MAX);
}

module.exports = { bumpDefaultName, teamNamePrefill, TEAM_NAME_MAX };
