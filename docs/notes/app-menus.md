# docs/notes/app-menus.md

## buildLibraryMenu

A plugin section is a separator followed by a disabled item carrying the plugin
name: Electron menus have no header row type, and macOS renders a disabled item
as dim text, which reads as the heading. Plugin entries send `{ plugin, name }`
(prompts add `kind`) on the drawer channel because a bare stem cannot locate a
bundle entry; library prompts send `{ kind, name }` for the same reason, and
the other library kinds keep the bare-string form the drawers already accept.
The menu is a rebuilt template, so every library write in ipc-handlers.js and
`updateBundle` in plugin-host-engine.js owe it a refresh.
