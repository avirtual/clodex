# renderer/popovers/team-roles-popover.js

## loadUses

`uses` is null, never an empty Map, when the dry gather fails. An empty Map
renders identically to a team whose roles reference nothing — every row would
claim "uses nothing", which is false. Null suppresses the block entirely and the
failure is stated once through `setStatus`, matching what `loadPreflight` does
with an absent preflight.

## buildTicketsSection

Renders its empty states rather than nothing when `activity` is absent. The web
host does not shim `team:activity`, so a section that vanished there would read
as a team with no board rather than a host that cannot see one.

Ticket titles are agent-written strings and reach the DOM only as `textContent`
— never an attribute, never `innerHTML` — in this nodeIntegration renderer.
