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

Swaps only `.check-group` / `.bundle-row` (headers included, or an emptied
section strands its header) plus `.hint-text`, restored via
`BUNDLE_EMPTY_HINT[kind]` if nothing else is left — a plugin tick would
otherwise re-render the whole checklist, dropping scroll and focus mid-list.

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
only when the set handed in named it AND the seat still holds the plugin, so
un-holding a plugin drops its prompts at save rather than persisting a refused ref.
