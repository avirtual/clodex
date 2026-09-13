'use strict';
// The web menubar's injected side-effect context, factored out of
// test/menubar.test.js (t905) so the parity test can drive the SAME web-side
// harness rather than growing a second one that drifts from it.

// A recording context: capture every emit / invoke / nav / newWorkspace the menu
// actions fire, and feed the async library/workspace/peer builders stub data so
// the dynamic rows exist.
function recordingCtx() {
  const rec = { emits: [], invokes: [], navs: [], newWorkspaces: 0 };
  const api = {
    listAgents: async () => [{ name: 'agent-one', description: 'first' }],
    listSkillLib: async () => [{ name: 'skill-one', description: 'a skill' }],
    // t790's team rows are listed now (t793): under a `Team <name>` group, and
    // clicking one sends `{team, …}` so the drawer opens the TEAM's copy. The
    // library `{kind, name}` payload resolves against the library alone, which
    // is why a shadowing team row cannot ride it — `lib-sys` exists in both, and
    // the two must reach the drawer by different payloads.
    listPrompts: async () => [
      { name: 'lib-append', kind: 'append', body: 'A' },
      { name: 'lib-sys', kind: 'system', body: 'S' },
      { name: 'lib-sys', kind: 'system', body: 'T', team: 'shop', id: 'team:shop:system:lib-sys' },
      { name: 'team-only', kind: 'append', body: 'U', team: 'shop', id: 'team:shop:append:team-only' },
    ],
    listTemplates: async () => [
      { id: 'tpl-one', name: 'tpl-one' },
      { id: 'rev:audit', name: 'rev:audit', plugin: 'rev' },
      { id: 'team:shop:hand', name: 'hand', team: 'shop' },
    ],
    listExecCommands: async () => [{ name: 'cmd-one' }],
    pluginCatalog: async () => [{
      id: 'rev', name: 'Reviewer', editable: true, dir: '/p/rev',
      skills: ['scan'], agents: ['critic'], templates: ['audit'],
      prompts: [{ name: 'rules', kind: 'append' }, { name: 'strict', kind: 'system' }],
    }],
    listWorkspaces: async () => [{ id: 'w1', name: 'Alpha' }, { id: 'w2', name: 'Beta' }],
    currentWorkspace: async () => 'w1',
    peerList: async () => [
      { id: 'p1', label: 'Peer One', online: true, sessions: [{ name: 'psess' }] },
      { id: 'p2', label: 'Peer Two', online: false },
    ],
  };
  const ctx = {
    emit: (ch, ...a) => rec.emits.push([ch, ...a]),
    invoke: (ch, args) => { rec.invokes.push([ch, args]); return Promise.resolve({ ok: true }); },
    nav: (id) => rec.navs.push(id),
    newWorkspace: () => { rec.newWorkspaces++; },
    api,
    getTheme: () => 'claude',
  };
  return { ctx, rec };
}

module.exports = { recordingCtx };
