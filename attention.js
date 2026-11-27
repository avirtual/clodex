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
  if (entry && entry.notification_type === 'permission_prompt') return 'permission';
  if (PERMISSION_RE.test(text)) return 'permission';
  if (IDLE_RE.test(text)) return 'idle';
  return 'other';
}

const BOOT_DIALOGS = [
  { kind: 'added-folder-trust', option: 'Yes,addit', title: 'Addinganewdirectory:', body: "Thissessionhasn'tworkedherebefore", footer: 'Adding:' },
  { kind: 'folder-trust', option: 'Yes,Itrustthisfolder', title: 'Accessingworkspace:', body: 'Quicksafetycheck', footer: null },
];
const VARIANT_OPTIONS = ['Yes,addit', 'Yes,movehere', 'Yes,trustitandapplythem', 'Yes,Itrustthisfolder'];
const VARIANT_NO = ['No,exit', 'No,stayput', 'No,leaveitout', 'No,keepthemoff'];
const VARIANT_TITLES = ['Nowinanewdirectory:', 'Addinganewdirectory:', 'Movingtoanewdirectory:', 'Accessingworkspace:'];
const VARIANT_BODIES = ["Thissessionhasn'tworkedherebefore", 'Itssettingsdeclareprojectpermissionrules', 'Quicksafetycheck'];
const BOOT_FRAME_MAX = 2000;
const BOOT_TAIL_MAX = 600;
const BOX_RULE_RE = /─{8}/;
const PATH_TAIL_RE = /[~/][^─│╭╮╰╯❯]*$/;

function pathAtEnd(seg) {
  const m = PATH_TAIL_RE.exec(seg);
  return m ? m[0] : null;
}

function bootDialogPath(d, frame, tail) {
  const bodyAt = frame.lastIndexOf(d.body);
  const titleAt = frame.lastIndexOf(d.title);
  if (titleAt >= 0) {
    const from = titleAt + d.title.length;
    const to = bodyAt > from ? bodyAt : frame.length;
    return pathAtEnd(frame.slice(from, to));
  }
  if (d.footer && tail.includes(d.footer)) {
    const after = tail.slice(tail.lastIndexOf(d.footer) + d.footer.length);
    const cut = after.indexOf('Entertoconfirm');
    return pathAtEnd(cut >= 0 ? after.slice(0, cut) : after);
  }
  if (bodyAt >= 0) return pathAtEnd(frame.slice(Math.max(0, bodyAt - 400), bodyAt));
  return null;
}

function classifyBootScreen(text) {
  const s = String(text == null ? '' : text).replace(/\s+/g, '').replace(/’/g, "'");
  let hit = null;
  for (const d of BOOT_DIALOGS) {
    const at = s.lastIndexOf(d.option);
    if (at >= 0 && (!hit || at > hit.at)) hit = { d, at };
  }
  const known = hit && classifyKnown(s, hit);
  return known || classifyVariant(s);
}

function classifyKnown(s, { d, at }) {
  const tail = s.slice(at + d.option.length);
  if (tail.length > BOOT_TAIL_MAX || BOX_RULE_RE.test(tail)) return null;
  const head = s.slice(Math.max(0, at - BOOT_FRAME_MAX), at);
  const exitAt = head.lastIndexOf('No,exit');
  if (exitAt < 0) return null;
  const frame = head.slice(0, exitAt);
  const framed = frame.includes(d.body) || frame.includes(d.title) || (!!d.footer && tail.includes(d.footer));
  if (!framed) return null;
  return { kind: d.kind, path: bootDialogPath(d, frame, tail) || null };
}

function lastOf(s, list) {
  let best = null;
  for (const w of list) {
    const at = s.lastIndexOf(w);
    if (at >= 0 && (!best || at > best.at)) best = { w, at };
  }
  return best;
}

function classifyVariant(s) {
  const opt = lastOf(s, VARIANT_OPTIONS);
  if (!opt) return null;
  const tail = s.slice(opt.at + opt.w.length);
  if (tail.length > BOOT_TAIL_MAX || BOX_RULE_RE.test(tail)) return null;
  const head = s.slice(Math.max(0, opt.at - BOOT_FRAME_MAX), opt.at);
  const no = lastOf(head, VARIANT_NO);
  const noInTail = lastOf(tail, VARIANT_NO);
  if (!no && !noInTail) return null;
  const frame = no ? head.slice(0, no.at) : head;
  const title = lastOf(frame, VARIANT_TITLES);
  const body = lastOf(frame, VARIANT_BODIES);
  if (!title && !body) return null;
  const d = { title: title ? title.w : '\0', body: body ? body.w : '\0', footer: null };
  return { kind: 'folder-trust-variant', path: bootDialogPath(d, frame, tail) || null };
}

function bootDialogNote(dialog) {
  return `a Claude Code boot dialog is up in its terminal${dialog && dialog.path ? `: ${dialog.path}` : ''}`;
}

module.exports = { classifyNotification, classifyBootScreen, bootDialogNote };
