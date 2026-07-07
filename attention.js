// Needs-attention detection: classify Claude Code Notification-hook events.
//
// The CLI's Notification hook is the DETERMINISTIC "session is blocked on the
// human" signal — it fires exactly when the CLI shows a permission dialog or
// parks waiting for input. Everything wire-side is ambiguous by comparison: a
// non-terminal stop followed by silence is indistinguishable from a
// long-running tool call, so no timing heuristic can be trusted near an
// injection path. The hook can.
//
// Three classes, three policies (policy applied in main.js; this stays pure):
//   'permission' — a dialog is OPEN. Badge + notify, and HARD-block dm
//                  injection (even urgent): _injectText ends with Enter,
//                  which would answer the dialog.
//   'idle'       — "waiting for your input" chatter. The session is parked at
//                  its ordinary prompt; that state is already visible
//                  everywhere. Ignored.
//   'other'      — unknown notification (auth failures, future CLI additions).
//                  Badge + notify so it isn't lost, but dm delivery stays
//                  open — there is no evidence a dialog is up.

const PERMISSION_RE = /needs your (permission|approval)|permission to (use|run)|requesting permission|approval required/i;
const IDLE_RE = /waiting for (your )?input/i;

// entry: parsed Notification-hook stdin JSON ({ message, title?, ... }).
// Unparseable/empty input classifies as 'other' — an unknown notification is
// worth a badge, and 'other' never gates dm delivery, so over-reporting here
// is a papercut, not a hazard.
function classifyNotification(entry) {
  const msg = (entry && typeof entry.message === 'string') ? entry.message : '';
  const title = (entry && typeof entry.title === 'string') ? entry.title : '';
  const text = `${title} ${msg}`;
  if (PERMISSION_RE.test(text)) return 'permission';
  if (IDLE_RE.test(text)) return 'idle';
  return 'other';
}

module.exports = { classifyNotification };
