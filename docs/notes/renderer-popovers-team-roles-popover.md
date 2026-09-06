# renderer/popovers/team-roles-popover.js

## loadUses

`uses` is null, never an empty Map, when the dry gather fails. An empty Map
renders identically to a team whose roles reference nothing — every row would
claim "uses nothing", which is false. Null suppresses the block entirely and the
failure is stated once through `setStatus`, matching what `loadPreflight` does
with an absent preflight.
