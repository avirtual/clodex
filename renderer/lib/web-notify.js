'use strict';
// web-notify.js — browser-frontend OS notifications (web-frontend Phase 5,
// Chunk 3). The Electron desktop raises native notifications through main's
// notifyOS seam; a browser tab has no such channel, so the web frontend raises
// `new Notification()` off the SAME events that already cross the wire to the
// renderer — onSessionAttention (a session blocked on the human) and
// onSessionMention (a DM landed). The renderer owns the window.__CLODEX_WEB__
// gate, the one-time permission gesture, and the tab-title badge; this leaf is
// the pure notice-builders plus a thin, injectable Notification wrapper so the
// formatting and permission logic test without a real Notification.
//
// NOT wired: agent-finished (the turn-end `notifyOS` at session-manager.js
// _emitActivity ~1403) has NO renderer broadcast — session-activity carries the
// idle STATE but not the `notify` end-of-turn boolean — so the browser can't
// tell a finished turn from any other idle. Bridging it (an ipc-message/event
// broadcast at that site) is the trailhead for the M version; left out here.

// ── pure notice-builders ──────────────────────────────────────────────────

function attentionNotice(name, attn) {
  const permission = !!attn && attn.kind === 'permission';
  return {
    title: permission ? `${name} needs permission` : `${name} needs you`,
    body: (attn && attn.message) || (permission ? 'Blocked on a permission dialog.' : 'Wants your attention.'),
    // One live notice per session — a re-fire coalesces onto the same tag
    // rather than stacking duplicates.
    tag: `clx-attn-${name}`,
  };
}

function mentionNotice(name, mtype) {
  return {
    title: name,
    body: mtype === 'dm' ? 'sent you a direct message' : 'mentioned you',
    tag: `clx-mention-${name}`,
  };
}

// Tab title with a leading activity count: "(3) Clodex (2 sessions)". Zero → the
// bare base, so the badge is invisible when nothing needs the human.
function badgeTitle(base, count) {
  const b = base || 'Clodex';
  return count > 0 ? `(${count}) ${b}` : b;
}

// ── side-effect wrapper (injectable for tests) ─────────────────────────────

// deps.Notification lets a test pass a fake constructor with static
// .permission / .requestPermission; in the browser it defaults to the global.
function createWebNotifier(deps = {}) {
  const N = deps.Notification || (typeof Notification !== 'undefined' ? Notification : null);
  let asked = false;

  // Ask ONCE. Chrome gates requestPermission behind a user gesture, so the
  // renderer calls this from the first pointer/key event, not at load.
  const ensurePermission = () => {
    if (!N || asked) return;
    asked = true;
    try {
      if (N.permission === 'default' && typeof N.requestPermission === 'function') {
        Promise.resolve(N.requestPermission()).catch(() => {});
      }
    } catch { /* pre-Promise requestPermission or a locked-down browser */ }
  };

  // Returns the Notification (or null if unsupported / not granted / it threw),
  // so the renderer never has to guard the construction itself.
  const raise = (notice) => {
    if (!N || N.permission !== 'granted' || !notice) return null;
    try { return new N(notice.title, { body: notice.body, tag: notice.tag }); }
    catch { return null; }
  };

  return { ensurePermission, raise };
}

module.exports = { attentionNotice, mentionNotice, badgeTitle, createWebNotifier };
