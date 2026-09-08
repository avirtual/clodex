# docs/notes/renderer-lib-ipc-export.md

## ipcRowParts

The `.ipc-entry` row (renderer/styles.css) is a flex line with `flex-shrink: 0`
badges and a `flex: 1` body, so two 36-char UUID badges consume the width and
push the body onto a second visual line. That is why a keepwarm row shortens the
id and drops the second badge rather than the CSS being widened.

Only `type: 'keepwarm'` takes the one-sided branch. A survey of all 84
`ipc-message` emission sites found one other with an empty `to` —
`session-manager.js`'s `type: 'attention'` — so keying the branch on an absent
`to` instead of on `type` would silently change that row too. A further ~10 are
event-shaped in the `from === to` sense (`system`, `context` ×3, `intent`,
`term`, `file`, `remind` ×3) and still render `name → name` by choice: seat names
are short, so those rows do not wrap. The survey is done; do not re-run it.
