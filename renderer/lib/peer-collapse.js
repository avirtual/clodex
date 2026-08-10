// Per-workspace fold state for peer headers (t276). Pure leaf, no DOM: the
// state has to live outside the DOM because renderPeers() rebuilds every peer
// row from scratch on each call.
//
// The persisted set names the peers the operator has EXPANDED, never the ones
// folded. A set of COLLAPSED ids cannot tell "never seen" apart from
// "deliberately opened", so a fresh workspace — and every newly discovered
// peer in an old one — would render unfolded. Absence means collapsed, and
// that is the whole feature: a new workspace must not open showing every
// peer's sessions.
function isPeerExpanded(expanded, id) {
  return Array.isArray(expanded) && expanded.indexOf(String(id)) !== -1;
}

// Returns a new array; unknown ids are carried through untouched, so a peer
// that goes offline (or is removed and re-added) keeps its fold state rather
// than being silently pruned back to collapsed.
function togglePeerExpanded(expanded, id) {
  const key = String(id);
  const cur = (Array.isArray(expanded) ? expanded : []).filter((x) => typeof x === 'string');
  return cur.indexOf(key) === -1 ? [...cur, key] : cur.filter((x) => x !== key);
}

module.exports = { isPeerExpanded, togglePeerExpanded };
