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

function runnerLoad(info) {
  const s = (info && info.slots) || {};
  const q = (info && info.queue) || {};
  const total = Number.isInteger(s.total) && s.total > 0 ? s.total : 1;
  const inUse = Number.isInteger(s.inUse) && s.inUse >= 0 ? s.inUse : q.running ? 1 : 0;
  return { total, inUse, free: total - inUse, queue: Array.isArray(q.queued) ? q.queued.length : 0 };
}

function boxReadyFor(info, box) {
  const b = info && info.box;
  if (!b || b.state !== 'ready') return false;
  const want = boxDefOf(box);
  if (!want) return true;
  const stamped = b.env && b.env.box;
  return !!stamped && stamped.definitionHash === want.definitionHash;
}

const BOX_TIER = { building: 1, 'can-build': 2 };

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


function pickRunner(members, { box = false, shares = [], exclusive = false } = {}) {
  let best = null;
  const boxed = box === true || boxDefOf(box) != null;
  members.forEach((m, i) => {
    if (!m || !m.live || !m.info) return;
    const tier = boxed ? boxTier(m.info, box) : 0;
    if (tier == null || (boxed && missingShare(m.info, shares))) return;
    const load = runnerLoad(m.info);
    const rank = exclusive === true ? exclusiveRank(m.info, load) : 0;
    const better = !best || rank < best.rank
      || (rank === best.rank && (tier < best.tier || (tier === best.tier && loadBeats(load, best.load))));
    if (better) best = { m, i, load, tier, rank };
  });
  return best ? { member: best.m, index: best.i, load: best.load, chosen: true } : { member: members[0] || null, index: 0, load: null, chosen: false };
}

module.exports = { baseRunnerLoad: runnerLoad, basePickRunner: pickRunner };
