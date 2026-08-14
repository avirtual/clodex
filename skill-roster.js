'use strict';

// skill-roster.js — classify the CLI's `skill_listing` transcript attachments.
//
// `isInitial: true` states the session's roster; `isInitial: false` states a
// DIRECTORY-SCOPED set, loaded only while the seat works under that directory.
// Merging them, or letting the later win, offers skills that never load and
// hides ones that did.

const LISTING_TYPE = 'skill_listing';

// The scope directory lives ONLY in the human-facing prose — no structural
// field carries it — so it is a label here and never a classifier: if this
// sentence drifts the dir goes null and the row is still marked out-of-scope.
const FROM_RE = /\(from\s.*?applies when working on files under\s+([^)]+)\)\s*$/;

function emptyRoster() {
  return { roster: [], outOfScope: [], sawRoster: false };
}

// A plugin skill's name contains ':', so a bullet's name cannot be read by
// cutting at the first colon — match against the listing's own names array.
function dirsFor(content, names) {
  const out = new Map();
  for (const line of String(content || '').split('\n')) {
    if (line.slice(0, 2) !== '- ') continue;
    const m = FROM_RE.exec(line);
    if (!m) continue;
    const rest = line.slice(2);
    // Longest first: one name can be a colon-prefix of another (`read` vs
    // `read:extended`), and shortest-first lets the prefix steal the bullet.
    for (const n of [...names].sort((a, b) => b.length - a.length)) {
      if (rest.startsWith(`${n}:`)) { out.set(n, m[1].trim()); break; }
    }
  }
  return out;
}

function classifySkillRoster(input, opts) {
  const always = new Set((opts && opts.alwaysInScope) || []);
  const lines = Array.isArray(input) ? input : String(input || '').split('\n');
  let roster = null;
  const byDir = new Map();
  for (const line of lines) {
    if (typeof line !== 'string' || line.indexOf(LISTING_TYPE) === -1) continue;
    let obj;
    try { obj = JSON.parse(line); } catch { continue; }
    const att = obj && obj.type === 'attachment' ? obj.attachment : null;
    if (!att || att.type !== LISTING_TYPE || !Array.isArray(att.names)) continue;
    const names = att.names.filter((n) => typeof n === 'string' && n);
    // Absent `isInitial` counts as roster: an unmarked listing from some other
    // CLI build renders as it always did, instead of greying the whole popover.
    if (att.isInitial !== false) { roster = names; continue; }
    const dirs = dirsFor(att.content, names);
    const groups = new Map();
    for (const n of names) {
      const d = dirs.get(n) || '';
      if (!groups.has(d)) groups.set(d, []);
      groups.get(d).push(n);
    }
    // Keyed by dir: re-entering a directory RESTATES its set, a different one
    // adds. A flat union would keep names a dir has since dropped.
    for (const [d, ns] of groups) byDir.set(d, ns);
  }
  const rosterNames = [...new Set(roster || [])];
  const inRoster = new Set(rosterNames);
  const seen = new Map();
  for (const d of [...byDir.keys()].sort()) {
    for (const n of byDir.get(d)) {
      if (inRoster.has(n) || always.has(n) || seen.has(n)) continue;
      seen.set(n, d || null);
    }
  }
  const outOfScope = [...seen.entries()]
    .map(([name, dir]) => ({ name, dir }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return { roster: rosterNames, outOfScope, sawRoster: roster !== null };
}

module.exports = { classifySkillRoster, emptyRoster };
