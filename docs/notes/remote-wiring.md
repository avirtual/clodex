# remote-wiring.js

## watchInbox

Armed once per PROCESS, not once per RemoteServer, because the store's
`onChange` list has no unsubscribe: a per-instance subscription would strand a
listener holding a dead server on every port change and every remote
disable/enable. It therefore reads `getRemoteServer()` per call rather than
capturing one.

Called at the top of `syncRemoteServer`, ahead of the `enabled` bail, so the
desktop half (the `notifications:changed` IPC that keeps a second window's badge
honest) does not depend on the phone server being switched on.
