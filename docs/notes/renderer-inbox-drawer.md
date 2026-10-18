# renderer/inbox-drawer.js

## refreshFromEvent

The `notify` ipc-message and `onNotificationsChanged` both feed this, and
neither subsumes the other. The `notify` ipc-message fires on ARRIVAL only — it is the shout intent's own
broadcast. `onNotificationsChanged` carries every store mutation from every
surface, which is the only signal a phone marking a note read over `/api/inbox`
produces; without it the desktop badge keeps counting notes the operator already
cleared.

## onAttentionChanged

`attention:changed` is a refresh signal only: the handler takes no argument and
re-pulls `openRequests`. Its payload carries a seat's `message` across
workspaces, so rendering it would leak another workspace's dialog text into a
web tab scoped to its own.
