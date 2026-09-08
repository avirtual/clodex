# docs/notes/renderer-lib-ipc-export.md

## ipcRowParts

The `.ipc-entry` row (renderer/styles.css) is a flex line with `flex-shrink: 0`
badges and a `flex: 1` body, so two 36-char UUID badges consume the width and
push the body onto a second visual line. That is why a keepwarm row shortens the
id and drops the second badge rather than the CSS being widened.

Only `type: 'keepwarm'` takes the one-sided branch. A survey of all 84
`ipc-message` emission sites found exactly one other with an empty `to` —
`session-manager.js`'s `type: 'attention'` broadcast — so keying the branch on an
absent `to` instead of on `type` would silently change that row too.
