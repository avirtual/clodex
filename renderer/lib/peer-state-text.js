'use strict';

const NEEDS_UPGRADE_TEXT = 'needs upgrade';
const NEEDS_UPGRADE_TIP = 'needs upgrade — this node does not serve sessions/attach';

function peerStateText({ status, tunnel } = {}) {
  const st = status || {};
  if (!st.online) {
    if (tunnel && tunnel.state === 'down') {
      return { text: 'tunnel down', tip: (tunnel.error || null), needsUpgrade: false };
    }
    return { text: 'offline', tip: null, needsUpgrade: false };
  }
  if (st.needsUpgrade) return { text: NEEDS_UPGRADE_TEXT, tip: NEEDS_UPGRADE_TIP, needsUpgrade: true };
  return { text: '', tip: null, needsUpgrade: false };
}

module.exports = { peerStateText, NEEDS_UPGRADE_TEXT, NEEDS_UPGRADE_TIP };
