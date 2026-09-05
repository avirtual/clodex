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
