# renderer/inbox-drawer.js

## refreshFromEvent

Two subscriptions feed this, and neither subsumes the other. The `notify`
ipc-message fires on ARRIVAL only — it is the notify-user intent's own
broadcast. `onNotificationsChanged` carries every store mutation from every
surface, which is the only signal a phone marking a note read over `/api/inbox`
produces; without it the desktop badge keeps counting notes the operator already
cleared.
