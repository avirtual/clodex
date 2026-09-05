# docs/notes/renderer-lib-checklists.md

## seatBundleSections

A checklist draws bundle rows only for a surface that passed a `seat`. With no
seat, `seatHasPlugin`'s absent case would answer for the SHIPPED default, so
every shipped plugin's rows would claim reach the seat may not have. A peer row
passes none deliberately: its plugins are its own box's, and the catalog here is
this Mac's.

## collectInjectChecklist

The `:not(:disabled)` clause is what keeps a bundle row out of the persisted
list. Bundle rows are `checked` (the CLI loads them with the plugin), and
`injectSkills` / `agents` are FLAT-library names that scaffold into a
`--plugin-dir` at spawn — a `pluginId:skill` written there names nothing.
`collectAgentChecklist` carries the same clause for the same reason.

## repaintBundleSections

Swaps only the `.check-group` / `.bundle-row` nodes. A plugin tick would
otherwise re-render the whole checklist, dropping scroll position and focus in
the flat list the operator is mid-way through. The removal must take the headers
too, or a tick that empties a section strands its header above nothing.

## appendBundleSections

`checkedSet` splits two meanings a bundle row's tick can carry. A skill or agent
from a held plugin is loaded by the CLI whether or not anything selects it, so
holding the plugin IS the tick. An append prompt is composed only when the seat's
`appendPromptFiles` names it, so a row ticked on reach alone claims a prompt the
seat never reads. The greyed non-member hint stays keyed on reach either way.

That tick source is why `collectAppendChecklist` must NOT filter disabled rows
the way the skills and agents collectors do: a bundle append row is the only
representation of a `pluginId:stem` in the form, so dropping it sends
`appendPromptFiles: []`, clearing a seat's entry on save and writing an empty
list back into the plugin folder. Collecting it is idempotent — it is checked
only when the set handed in already named it.
