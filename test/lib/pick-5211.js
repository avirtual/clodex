'use strict';

function boxDefOf(box) {
  if (!box || typeof box !== 'object' || typeof box.definitionHash !== 'string') return null;
  return { definitionHash: box.definitionHash, rev: box.rev, definition: box.definition };
}

function shareKeys(rows, nameKey) {
  return (Array.isArray(rows) ? rows : []).map((r) => `${r && r[nameKey]}@${r && r.version}`).sort();
}

function missingShare(info, asked) {
  const held = new Set(shareKeys(info && info.shares, 'name'));
  return (Array.isArray(asked) ? asked : []).find((s) => !held.has(`${s.share}@${s.version}`)) || null;
}

function runnerLoad(info, sent = 0) {
  const s = (info && info.slots) || {};
  const q = (info && info.queue) || {};
  const total = Number.isInteger(s.total) && s.total > 0 ? s.total : 1;
  const used = Number.isInteger(s.inUse) && s.inUse >= 0 ? s.inUse : q.running ? 1 : 0;
  const count = (n) => (Number.isInteger(n) && n > 0 ? n : 0);
  const pending = count(info && info.pending) + count(sent);
  const inUse = Math.max(used, Math.min(total, used + pending));
  const queue = (Array.isArray(q.queued) ? q.queued.length : 0) + (used + pending - inUse);
  return { total, inUse, free: total - inUse, queue, pending };
}

function boxReadyFor(info, box) {
  const b = info && info.box;
  if (!b || b.state !== 'ready') return false;
  const want = boxDefOf(box);
  if (!want) return true;
  const stamped = b.env && b.env.box;
  return !!stamped && stamped.definitionHash === want.definitionHash;
}

const BOX_TIER = { building: 1, 'can-build': 2, probing: 2 };
const SKIP_WHY = { refused: 'refused', timeout: 'timeout' };

function boxTier(info, box) {
  if (boxReadyFor(info, box)) return 0;
  const want = boxDefOf(box);
  const b = info && info.box;
  if (!want || !b || b.definitionHash !== want.definitionHash) return null;
  return BOX_TIER[b.state] || null;
}

function loadBeats(load, best) {
  const open = load.free > 0;
  if (open !== best.free > 0) return open;
  if (open && load.inUse !== best.inUse) return load.inUse < best.inUse;
  if (load.free !== best.free) return load.free > best.free;
  return load.queue < best.queue;
}

function exclusiveRank(info, load) {
  return (info.exclusive === 'honour' ? 0 : 2) + (load.inUse === 0 && load.queue === 0 ? 0 : 1);
}

function pickRunner5211(members, { box = false, shares = [], exclusive = false } = {}) {
  let best = null;
  const boxed = box === true || boxDefOf(box) != null;
  const ranks = [];
  members.forEach((m, i) => {
    if (!m) return;
    const skip = (reason) => { ranks.push({ member: m.peer, skipped: reason }); };
    if (!m.live) return skip('not connected');
    if (!m.info) return skip(SKIP_WHY[m.why] || 'no answer');
    const tier = boxed ? boxTier(m.info, box) : 0;
    if (tier == null || (boxed && missingShare(m.info, shares))) return skip('no box for this job');
    const load = runnerLoad(m.info, m.sent);
    const rank = exclusive === true ? exclusiveRank(m.info, load) : 0;
    const unknown = boxed && m.info.box && m.info.box.state === 'probing';
    ranks.push({ member: m.peer, load, tier, rank, ...(unknown ? { boxUnknown: true } : {}) });
    const better = !best || rank < best.rank
      || (rank === best.rank && (tier < best.tier || (tier === best.tier && loadBeats(load, best.load))));
    if (better) best = { m, i, load, tier, rank };
  });
  return best ? { member: best.m, index: best.i, load: best.load, chosen: true, ranks } : { member: members[0] || null, index: 0, load: null, chosen: false, ranks };
}

module.exports = { pickRunner5211 };
