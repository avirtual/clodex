// manual/harness.js — the shared browser-side fixture for the team-popover
// manual checks. Loaded by harness.html into a real Electron renderer.
//
// Why these live in the repo and not in a test file: the behaviour they cover is
// the BROWSER's — radio-group arrow navigation, tab-stop semantics, focus. The
// suite has no DOM (no jsdom dependency), and jsdom would not implement any of
// it if it did, which is exactly why B4 is built on native radios rather than
// role="radio" divs. A source-level test can pin the SHAPE (it does, in
// test/team-roles.test.js); only a browser can pin the BEHAVIOUR.
//
// Paths resolve from this file's own location, so the checks survive being run
// from any checkout or worktree — the earlier version hardcoded a worktree path
// and would have died with it.
window.onerror = (m, f, l, c, e) => { window.__err = (e && e.stack) || m; };
const path = require('path');
const fs = require('fs');
const REPO = path.resolve(__dirname, '..');

const html = fs.readFileSync(path.join(REPO, 'renderer', 'index.html'), 'utf-8');
const doc = new DOMParser().parseFromString(html, 'text/html');
document.getElementById('harness-root').appendChild(doc.getElementById('team-roles-popover'));

// `hand` mirrors STOCK_ROLE_DEFS.hand: a template and NO dispatch, i.e. standing
// with a stale template. That is the shape every default team ships, and the one
// that exposed a Clear button which could not keep its promise.
const TEAM = {
  name: 'clodex', root: REPO, lead: 'clodex', watchdogMs: null,
  roles: {
    lead: { prompt: 'clodex-team-lead', brief: 'team lead.', template: null, dispatch: 'standing', cwd: null },
    hand: { prompt: 'clodex-team-hand', brief: 'implementer.', template: 'clodex-team-hand', dispatch: 'standing', cwd: null },
    reviewer: { prompt: 'clodex-team-reviewer', brief: 'reviewer.', template: null, dispatch: 'standing', cwd: null },
    designer: { prompt: null, brief: 'designer.', template: 'fable-design', dispatch: 'worktree', cwd: null },
    // A standing role carrying BOTH stale values (R4's full case).
    archivist: { prompt: null, brief: 'archivist.', template: 'fable-design', dispatch: 'standing', cwd: 'api' },
  },
};
const SESSIONS = [
  { name: 'clodex', type: 'claude', team: 'clodex', role: 'lead', activity: 'idle' },
  { name: 'clodex-hand-427', type: 'claude', team: 'clodex', role: 'hand', activity: 'thinking' },
];
window.api = {
  teamGet: async () => ({ ok: true, team: TEAM }),
  teamPreflight: async () => ({ ok: true, findings: [] }),
  listSessions: async () => SESSIONS,
  reservedSessionNames: async () => ({ ok: true, names: SESSIONS.map((s) => s.name) }),
  teamRolePrompts: async () => ({ ok: true, prompts: ['clodex-team-lead', 'clodex-team-hand'], all: ['clodex-team-lead', 'clodex-team-hand', 'clodex-team-reviewer'] }),
};

const { initTeamRolesPopover } = require(path.join(REPO, 'renderer', 'popovers', 'team-roles-popover.js'));
const api = initTeamRolesPopover({ promptText: async () => null, openSessionDialog: () => {} });
window.__open = async () => { await api.openTeamRolesPopover('clodex', null); return null; };
