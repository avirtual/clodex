# docs/notes/app-menus.md

## buildLibraryMenu

A category section is a separator followed by a disabled item carrying the
category name: Electron menus have no header row type, and macOS renders a
disabled item as dim text, which reads as the heading. Past sixteen rows
library-menu-shape.js folds each category into a real nested submenu instead,
where the label is a live row again. Plugin entries send `{ plugin, name }`
(prompts add `kind`) on the drawer channel because a bare stem cannot locate a
bundle entry; team entries send `{ team, name }` (prompts add `kind`) because a
stem can name a copy in every team; library prompts send `{ kind, name }`, and
the other library kinds keep the bare-string form the drawers already accept.
The menu is a rebuilt template, so every library write in ipc-handlers.js and
`updateBundle` in plugin-host-engine.js owe it a refresh.
