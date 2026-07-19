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

module.exports = { bumpDefaultName };
