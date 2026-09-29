'use strict';

const MODAL_OVERLAY_IDS = [
  'dialog-overlay',
  'peer-session-overlay',
  'discovery-overlay',
  'args-overlay',
  'prefs-overlay',
  'plugins-overlay',
  'peers-overlay',
  'sandbox-overlay',
  'setup-overlay',
  'report-overlay',
  'help-overlay',
  'prompt-editor',
  'agent-editor',
  'skill-editor',
  'exec-editor',
];

const MODAL_OVERLAY_CLASSES = [
  'prompt-modal-overlay',
  'plugin-overlay',
  'clx-modal-bg',
  'dock-sheet',
];

function openOverlayIds({ byId, byClass }) {
  const open = [];
  for (const id of MODAL_OVERLAY_IDS) {
    const el = byId(id);
    if (el && el.classList && !el.classList.contains('hidden')) open.push(id);
  }
  for (const cls of MODAL_OVERLAY_CLASSES) {
    const els = (byClass && byClass(cls)) || [];
    if (Array.prototype.some.call(els, (el) => el && el.classList && !el.classList.contains('hidden'))) open.push(cls);
  }
  return open;
}

function dialogOverlayIds(probes) {
  return openOverlayIds(probes).filter((id) => id !== 'dock-sheet');
}

function anyOverlayOpen(probes) {
  return openOverlayIds(probes).length > 0;
}

function performCloseChord({ byId, byClass, activeSession, peerOf }, { closeNewSessionDialog, hidePeerRow, archiveSession }) {
  const dialogs = dialogOverlayIds({ byId, byClass });
  if (dialogs.length === 1 && dialogs[0] === 'dialog-overlay') {
    closeNewSessionDialog();
    return 'closed-new-session-dialog';
  }
  if (anyOverlayOpen({ byId, byClass })) return 'overlay-open-nothing-closed';
  if (!activeSession) return 'no-active-session';
  const peer = peerOf(activeSession);
  if (peer) {
    hidePeerRow(peer);
    return 'hid-peer-row';
  }
  archiveSession(activeSession);
  return 'archived-active-session';
}

module.exports = {
  MODAL_OVERLAY_IDS, MODAL_OVERLAY_CLASSES, openOverlayIds, dialogOverlayIds, anyOverlayOpen, performCloseChord,
};
