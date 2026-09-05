// popovers/checklist-popovers.js — the local config-editor popovers off the
// proxy bar's ⚙ actions: Tools, Skills, Agents/Builtins, Intents, Plugins. Each
// renders a checklist of the session's current config, and Apply persists it
// (optionally with a hard restart + terminal re-attach). Self-contained island:
// DOM handles, dismiss wiring and bulk-toggle wiring live here; openers returned.
//
// These read/write settings and restart via window.api directly — outside the
// popoverApi read-only data seam by design. The restart re-attach dance needs
// core sessionList/createTerminal/addSessionToSidebar/switchSession, injected by
// reference. Tools/Agents are LOCAL-only. SKILLS takes an optional peer `source`
// ({fetch, save, restartFresh}) so the same popover edits a peer session's
// skills over the wire; with `source` omitted the local path is unchanged.

const {
  renderToolChecklist, collectToolChecklist, renderSkillChecklist, collectSkillChecklist,
  renderInjectChecklist, collectInjectChecklist, renderAgentChecklist, collectAgentChecklist,
  renderBuiltinChecklist, collectBuiltinChecklist, wireBulkToggles,
  renderIntentChecklist, collectIntentChecklist,
  renderPluginChecklist, collectPluginChecklist,
  setClaudeToolsCache, setSkillLibCache, setAgentLibCache, getSkillLibCache,
  setIntentCatalogCache, setPluginCatalogCache, getPluginCatalogCache,
} = require('../lib/checklists');
const { autoEnabledFor, reconcilePartialSelection } = require('../../scope-util');
const { parseSkillFrontmatter } = require('../../skills-util');
const { esc } = require('../lib/format');
const { makeDraggable, resetDrag } = require('../lib/popover-drag');
const { placeAboveAnchor } = require('../lib/popover-place');

// All of them open from the ⚙ session menu, and each awaits its config read first —
// long enough for renderSessionActions to have replaced the button. A peer skills
// open anchors to a sidebar row instead, where this selector finds nothing and
// the captured row (still attached) is used.
const BAR_ANCHOR = '#proxy-bar [data-act="session-menu"]';
const { grantsForUnlistedPlugins, mergeGrants, pluginsForUnlistedPlugins, mergePlugins } = require('../../plugin-api');

// Names auto-INCLUDED for `session` by `sessions:` scope, for a scoped checklist.
// Agents carry parsed `meta`; skills carry only raw `content` (re-parse it, same
// grammar the library drawer uses). Feeds render (checked+disabled `· auto`) and
// the Save reconcile (exclude from the persisted set).
// Operator-facing names for the plugin capabilities (plugin-api's
// PLUGIN_CAPABILITIES). The vocabulary is the engine's; the WORDING is the UI's,
// and it is deliberately about what the plugin gets to see rather than what the
// field is called — "toolInputs" does not tell an operator that it includes
// every Bash command the agent ran.
const CAPABILITY_LABELS = {
  turns: 'Turn text — what the agent writes',
  thinking: 'Thinking blocks — its reasoning, not just its answers',
  toolInputs: 'Tool inputs — Bash commands it runs and file contents it writes',
};

const agentAutoSet = (agentLib, session) => new Set(autoEnabledFor(agentLib || [], session));
const skillAutoSet = (skillLib, session) => new Set(autoEnabledFor(
  (skillLib || []).map((s) => ({ name: s.name, meta: parseSkillFrontmatter(s.content || '').meta })), session));

function initChecklistPopovers({ sessionList, createTerminal, addSessionToSidebar, switchSession, refreshSidebarMeta }) {
  // --- Tools quick-access popover ------------------------------------------
  // Opened from the status-bar "tools" icon. Reads the session's current
  // disabled set + the known-tool catalog, lets the user toggle, and persists
  // via session:setTools (optionally restarting to apply immediately). The disabled
  // set drives permissions.deny at spawn — see CLAUDE_TOOLS in main.js.
  const toolsPopover = document.getElementById('tools-popover');
  const toolsPopoverName = document.getElementById('tools-popover-name');
  const popoverToolsList = document.getElementById('popover-tools-list');
  const toolsPopoverRestart = document.getElementById('tools-popover-restart');

  function closeToolsPopover() {
    toolsPopover.classList.add('hidden');
    toolsPopover.dataset.name = '';
  }

  async function openToolsPopover(name, anchorBtn) {
    const [settings, res] = await Promise.all([
      window.api.getSettings(),
      window.api.getSessionArgs(name),
    ]);
    if (!res || !res.ok) { alert('Session not found in persistence.'); return; }
    setClaudeToolsCache(settings?.claudeTools || []);
    renderToolChecklist(popoverToolsList, new Set(res.disabledTools || []), res.effectiveTools || {});
    toolsPopoverRestart.checked = false;
    toolsPopoverName.textContent = name;
    toolsPopover.dataset.name = name;
    resetDrag(toolsPopover); // a fresh open re-anchors; drop any prior drag offset
    toolsPopover.classList.remove('hidden');
    placeAboveAnchor(toolsPopover, anchorBtn, BAR_ANCHOR);
  }

  document.getElementById('tools-popover-cancel').addEventListener('click', closeToolsPopover);
  document.getElementById('tools-popover-apply').addEventListener('click', async () => {
    const name = toolsPopover.dataset.name;
    if (!name) return closeToolsPopover();
    const disabledTools = collectToolChecklist(popoverToolsList);
    const restart = toolsPopoverRestart.checked;
    closeToolsPopover();
    const r = await window.api.setSessionTools(name, disabledTools);
    if (!r || !r.ok) { alert(`Update tools failed: ${r && r.error ? r.error : 'unknown error'}`); return; }
    if (!restart) return;
    // Same re-attach dance as the context-menu restart path.
    const item = sessionList.querySelector(`[data-name="${CSS.escape(name)}"]`);
    const snapType = item ? item.dataset.type || null : null;
    const snapCwd = item ? item.dataset.cwd : null;
    const rr = await window.api.restartSession(name);
    if (!rr || !rr.ok) { alert(`Restart failed: ${rr && rr.error ? rr.error : 'unknown error'}`); return; }
    if (snapType) {
      createTerminal(name);
      addSessionToSidebar(name, snapType, snapCwd, null);
      switchSession(name);
    }
  });
  // Dismiss on outside click / Escape.
  document.addEventListener('mousedown', (e) => {
    if (toolsPopover.classList.contains('hidden')) return;
    if (toolsPopover.contains(e.target)) return;
    if (e.target.closest('.px-action')) return; // the toggle button handles itself
    closeToolsPopover();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !toolsPopover.classList.contains('hidden')) closeToolsPopover();
  });

  // --- Per-session Skills popover ------------------------------------------
  // Mirrors the tools popover, but writes skillOverrides:{name:"off"} (which
  // reclaims the per-turn roster tokens) instead of permissions.deny. The
  // catalog is the live transcript roster unioned with the disabled set
  // (session:skillCatalog), so a turned-off skill stays re-enable-able.
  const skillsPopover = document.getElementById('skills-popover');
  const skillsPopoverName = document.getElementById('skills-popover-name');
  const popoverSkillsList = document.getElementById('popover-skills-list');
  const popoverInjectSkillsSection = document.getElementById('popover-inject-skills-section');
  const popoverInjectSkillsList = document.getElementById('popover-inject-skills-list');
  const skillsPopoverRestart = document.getElementById('skills-popover-restart');
  // Non-null while editing a PEER session's skills: swaps the fetch/save/restart
  // data layer (the box's catalog + wire persist) while the DOM stays identical.
  let skillsEditingSource = null;
  // Scoped-checklist Save inputs captured at render: the persisted inject set, the
  // rendered (in-scope) skill names, and the auto-included names — so Apply can
  // reconcile (out-of-scope survivors kept, auto excluded) instead of dropping.
  let skillsInjectPersisted = [];
  let skillsInjectRendered = [];
  let skillsInjectAuto = [];

  function closeSkillsPopover() {
    skillsPopover.classList.add('hidden');
    skillsPopover.dataset.name = '';
    skillsEditingSource = null;
  }

  async function openSkillsPopover(name, anchorBtn, source = null) {
    const res = source ? await source.fetch() : await window.api.getSkillCatalog(name);
    if (!res || !res.ok) { alert(source ? `Read skills on peer failed: ${res && res.error ? res.error : 'unknown error'}` : 'Session not found in persistence.'); return; }
    skillsEditingSource = source;
    renderSkillChecklist(popoverSkillsList, res.names || [], new Set(res.disabledSkills || []),
      res.effective || {}, { skillsLocked: res.skillsLocked, canReenable: res.canReenable, outOfScope: res.outOfScope });
    // Library-injection section: only shown when the library is non-empty.
    setSkillLibCache(res.skillLib || []);
    if (getSkillLibCache().length) {
      const auto = skillAutoSet(res.skillLib, name);
      renderInjectChecklist(popoverInjectSkillsList, new Set(res.injectSkills || []), auto);
      skillsInjectPersisted = res.injectSkills || [];
      skillsInjectRendered = (res.skillLib || []).map((s) => s.name);
      skillsInjectAuto = [...auto];
      popoverInjectSkillsSection.style.display = '';
    } else {
      popoverInjectSkillsSection.style.display = 'none';
      skillsInjectPersisted = []; skillsInjectRendered = []; skillsInjectAuto = [];
    }
    skillsPopoverRestart.checked = false;
    skillsPopoverName.textContent = name;
    skillsPopover.dataset.name = name;
    resetDrag(skillsPopover); // a fresh open re-anchors; drop any prior drag offset
    skillsPopover.classList.remove('hidden');
    placeAboveAnchor(skillsPopover, anchorBtn, BAR_ANCHOR);
  }

  document.getElementById('skills-popover-cancel').addEventListener('click', closeSkillsPopover);
  document.getElementById('skills-popover-apply').addEventListener('click', async () => {
    const name = skillsPopover.dataset.name;
    if (!name) return closeSkillsPopover();
    const disabledSkills = collectSkillChecklist(popoverSkillsList);
    // Only send injectSkills when the library section is shown; otherwise pass
    // undefined so the handler preserves the persisted set (empty library != none).
    // When shown, RECONCILE against the scoped render: an out-of-scope persisted
    // skill (never rendered) survives, and auto-included skills are excluded from
    // the persisted set (the spawn union re-adds them).
    const injectSkills = popoverInjectSkillsSection.style.display === 'none'
      ? undefined
      : reconcilePartialSelection(
          skillsInjectPersisted, skillsInjectRendered,
          collectInjectChecklist(popoverInjectSkillsList), skillsInjectAuto);
    const restart = skillsPopoverRestart.checked;
    // Capture the peer source (if any) before close() nulls it.
    const source = skillsEditingSource;
    // Skill changes (trim or inject) only land in a NEW conversation (the roster
    // is fixed at creation; --resume replays the old one), so confirm the
    // history-clearing fresh restart before doing it. SHARED across local + peer —
    // it's the semantic warning (a peer fresh restart clears the box's history too).
    if (restart && !confirm(`Apply skill changes to "${name}" now?\n\nThis starts a NEW conversation — the current session's history will be cleared. (Leave "Restart fresh" unchecked to apply on the next fresh start instead.)`)) return;
    closeSkillsPopover();
    const r = source
      ? await source.save({ disabledSkills, injectSkills })
      : await window.api.setSessionSkills(name, disabledSkills, injectSkills);
    if (!r || !r.ok) { alert(`Update skills failed: ${r && r.error ? r.error : 'unknown error'}`); return; }
    if (!restart) return;
    // Fresh (non-resume) restart — the only way a skill change takes effect.
    if (source) { source.restartFresh(); return; }
    // Local: same re-attach dance as the tools popover restart path.
    const item = sessionList.querySelector(`[data-name="${CSS.escape(name)}"]`);
    const snapType = item ? item.dataset.type || null : null;
    const snapCwd = item ? item.dataset.cwd : null;
    const rr = await window.api.restartSession(name, { fresh: true });
    if (!rr || !rr.ok) { alert(`Restart failed: ${rr && rr.error ? rr.error : 'unknown error'}`); return; }
    if (snapType) {
      createTerminal(name);
      addSessionToSidebar(name, snapType, snapCwd, null);
      switchSession(name);
    }
  });
  document.addEventListener('mousedown', (e) => {
    if (skillsPopover.classList.contains('hidden')) return;
    if (skillsPopover.contains(e.target)) return;
    if (e.target.closest('.px-action')) return;
    if (e.target.closest('[data-act="manage-skills"]')) return; // ctx cross-link opens it
    closeSkillsPopover();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !skillsPopover.classList.contains('hidden')) closeSkillsPopover();
  });

  // --- Per-session Agents popover ------------------------------------------
  // A shortcut for composing the custom-subagent library into a running session
  // (--agents) + toggling the built-in agents, instead of right-click → Edit
  // settings → check/uncheck. Denying a built-in (Agent(Explore) etc.) filters it
  // out of the injected roster — reclaiming its per-turn description tokens — and
  // stops delegation to it, so this IS a (capability-costing) trim lever. Like
  // skills, the roster is frozen at conversation creation, so applying needs a
  // FRESH (non-resume) restart.
  const agentsPopover = document.getElementById('agents-popover');
  const agentsPopoverName = document.getElementById('agents-popover-name');
  const popoverAgentsList = document.getElementById('popover-agents-list');
  const popoverBuiltinsList = document.getElementById('popover-builtins-list');
  const agentsPopoverRestart = document.getElementById('agents-popover-restart');

  // Scoped-checklist Save inputs for the agents list (see the skills equivalents).
  let agentsPersisted = [];
  let agentsRendered = [];
  let agentsAuto = [];

  function closeAgentsPopover() {
    agentsPopover.classList.add('hidden');
    agentsPopover.dataset.name = '';
  }

  async function openAgentsPopover(name, anchorBtn) {
    const res = await window.api.getAgentCatalog(name);
    if (!res || !res.ok) { alert('Session not found in persistence.'); return; }
    setAgentLibCache(res.agents || []);
    const auto = agentAutoSet(res.agents, name);
    renderAgentChecklist(popoverAgentsList, new Set(res.enabled || []), auto);
    agentsPersisted = res.enabled || [];
    agentsRendered = (res.agents || []).map((a) => a.name);
    agentsAuto = [...auto];
    renderBuiltinChecklist(popoverBuiltinsList, new Set(res.denyBuiltins || []));
    agentsPopoverRestart.checked = false;
    agentsPopoverName.textContent = name;
    agentsPopover.dataset.name = name;
    resetDrag(agentsPopover); // a fresh open re-anchors; drop any prior drag offset
    agentsPopover.classList.remove('hidden');
    placeAboveAnchor(agentsPopover, anchorBtn, BAR_ANCHOR);
  }

  document.getElementById('agents-popover-cancel').addEventListener('click', closeAgentsPopover);
  document.getElementById('agents-popover-close').addEventListener('click', closeAgentsPopover);
  document.getElementById('agents-popover-apply').addEventListener('click', async () => {
    const name = agentsPopover.dataset.name;
    if (!name) return closeAgentsPopover();
    // Reconcile against the scoped render (out-of-scope survivors kept, auto
    // excluded) — same as the skills popover.
    const agents = reconcilePartialSelection(
      agentsPersisted, agentsRendered, collectAgentChecklist(popoverAgentsList), agentsAuto);
    const denyBuiltins = collectBuiltinChecklist(popoverBuiltinsList);
    const restart = agentsPopoverRestart.checked;
    // The agent roster is fixed at conversation creation (--resume replays the
    // old one), so a restart that applies it must be the fresh, history-clearing
    // kind — confirm before doing it.
    if (restart && !confirm(`Apply agent changes to "${name}" now?\n\nThis starts a NEW conversation — the current session's history will be cleared. (Leave "Restart fresh" unchecked to apply on the next fresh start instead.)`)) return;
    closeAgentsPopover();
    const r = await window.api.setSessionAgents(name, agents, denyBuiltins);
    if (!r || !r.ok) { alert(`Update agents failed: ${r && r.error ? r.error : 'unknown error'}`); return; }
    if (!restart) return;
    // Fresh (non-resume) restart — same re-attach dance as the skills popover.
    const item = sessionList.querySelector(`[data-name="${CSS.escape(name)}"]`);
    const snapType = item ? item.dataset.type || null : null;
    const snapCwd = item ? item.dataset.cwd : null;
    const rr = await window.api.restartSession(name, { fresh: true });
    if (!rr || !rr.ok) { alert(`Restart failed: ${rr && rr.error ? rr.error : 'unknown error'}`); return; }
    if (snapType) {
      createTerminal(name);
      addSessionToSidebar(name, snapType, snapCwd, null);
      switchSession(name);
    }
  });
  document.addEventListener('mousedown', (e) => {
    if (agentsPopover.classList.contains('hidden')) return;
    if (agentsPopover.contains(e.target)) return;
    if (e.target.closest('.px-action')) return;
    closeAgentsPopover();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !agentsPopover.classList.contains('hidden')) closeAgentsPopover();
  });

  // --- Per-session Intents popover -----------------------------------------
  // Live intent-gate editing (the New/Edit dialog's intent checklist, for a
  // running seat). Unlike tools/skills/agents — where the gated config is frozen
  // at spawn so a change only bites on restart — the fire-time gate re-reads
  // persistence on EVERY intent, so Apply takes effect IMMEDIATELY with no
  // restart; the optional checkbox only refreshes the seat's PROMPT (which still
  // documents disabled verbs until it respawns, though the gate already bounces
  // them). Persist mirrors the New dialog: all boxes checked → collect yields
  // null → session:setIntents REMOVES the key (living all-enabled default),
  // never a frozen array; [] is a real "everything gated" value.
  const intentsPopover = document.getElementById('intents-popover');
  const intentsPopoverName = document.getElementById('intents-popover-name');
  const popoverIntentsList = document.getElementById('popover-intents-list');
  const intentsPopoverRestart = document.getElementById('intents-popover-restart');
  // Read-only exec-grant readout: which registered commands THIS local seat may run,
  // and — crucially — whether they're LIVE or inert. Exec is a two-gate capability:
  // the coarse `exec` INTENT (edited right here) must be on AND the fine per-command
  // GRANT must list the command. So a seat can hold grants that are inert because the
  // intent is gated off; this readout makes that otherwise-invisible state explicit,
  // dimming the block + warning when the exec box is unchecked. Grants are edited in
  // the ⚙ Edit-session dialog (local-only), so here they're display-only.
  const intentsExecReadout = document.getElementById('intents-popover-exec');
  const intentsExecListEl = document.getElementById('intents-popover-exec-list');
  const intentsExecNote = document.getElementById('intents-popover-exec-note');
  // The current seat's grants, captured on open so the live inert-state refresh
  // (driven by toggling the exec checkbox) doesn't need to re-fetch.
  let intentsExecGrants = [];

  // Recompute the inert dimming + note from the LIVE exec-checkbox state (not the
  // persisted value) so unchecking `exec` in this popover immediately shows the
  // grants going inert, before Apply.
  function refreshExecReadoutInertState() {
    const execCb = popoverIntentsList.querySelector('input[type="checkbox"][value="exec"]');
    const execOn = execCb ? execCb.checked : true;
    const hasGrants = intentsExecGrants.length > 0;
    intentsExecReadout.classList.toggle('inert', hasGrants && !execOn);
    if (!hasGrants) {
      intentsExecNote.textContent = '';
      intentsExecNote.classList.remove('warn');
    } else if (execOn) {
      intentsExecNote.textContent = 'These grants can run while the exec intent is enabled.';
      intentsExecNote.classList.remove('warn');
    } else {
      intentsExecNote.textContent = 'The exec intent is gated off — these grants are inert until you re-enable it.';
      intentsExecNote.classList.add('warn');
    }
  }

  function renderExecGrantReadout(grants) {
    intentsExecGrants = Array.isArray(grants) ? grants : [];
    intentsExecListEl.innerHTML = '';
    if (!intentsExecGrants.length) {
      intentsExecListEl.innerHTML = '<span class="hint-text">No exec commands granted to this seat.</span>';
    } else {
      for (const cmd of intentsExecGrants) {
        const row = document.createElement('div');
        row.className = 'agent-check';
        row.innerHTML = `<span class="exec-grant-name">${esc(cmd)}</span>`;
        intentsExecListEl.appendChild(row);
      }
    }
    refreshExecReadoutInertState();
  }

  // --- Plugins (the parent) ------------------------------------------
  // A tick repaints both children off the LIVE checkbox state — the override
  // argument on both reads is for exactly that.
  const intentsPluginsList = document.getElementById('intents-popover-plugins-list');
  let intentsPluginsPersisted = null;

  async function repaintPluginChildren(name) {
    const ticked = collectPluginChecklist(intentsPluginsList);
    const checkedIntents = collectIntentChecklist(popoverIntentsList);
    setIntentCatalogCache((await window.api.getIntentCatalog(name, ticked)) || []);
    renderIntentChecklist(popoverIntentsList, checkedIntents);
    let g = null;
    try { g = await window.api.getSessionPluginGrants(name, ticked); } catch {}
    renderPluginGrants(g && g.ok ? g : null);
    refreshExecReadoutInertState();
  }

  intentsPluginsList.addEventListener('change', () => {
    const name = intentsPopover.dataset.name;
    if (name) repaintPluginChildren(name);
  });

  // --- Plugin Access -------------------------------------------------
  // Its own block and header: "Intents" is what this seat may EMIT, a grant is
  // what a plugin may READ of it, and an operator scanning for "who can see my
  // thinking" will not look under a list of verbs. Only SESSION-SCOPED plugins
  // offer grants, so the block is absent when none is installed.
  const intentsGrantsBlock = document.getElementById('intents-popover-grants');
  const intentsGrantsList = document.getElementById('intents-popover-grants-list');

  // Grants held for plugins this dialog cannot draw a row for. Measured against
  // the PLUGIN CATALOG, not `res.plugins`: that list is narrowed by the live
  // ticked set, so after an untick the plugin reads as unlistable and its tokens
  // are written back over the prune the same Apply asked for. A carry-forward
  // covers a plugin the operator could not see, never one they saw and unticked.
  let unlistedGrants = [];

  function renderPluginGrants(res) {
    const plugins = (res && res.plugins) || [];
    const caps = (res && res.capabilities) || [];
    const granted = new Set((res && res.granted) || []);
    unlistedGrants = grantsForUnlistedPlugins((res && res.granted) || [],
      getPluginCatalogCache().map((p) => String(p.id)));
    intentsGrantsList.innerHTML = '';
    intentsGrantsBlock.classList.toggle('hidden', !plugins.length);
    if (!plugins.length) return;
    for (const p of plugins) {
      const head = document.createElement('div');
      head.className = 'popover-subhead grant-plugin-name';
      head.textContent = p.name || p.id;
      intentsGrantsList.appendChild(head);
      for (const cap of caps) {
        const token = `${p.id}:${cap}`;
        const row = document.createElement('label');
        row.className = 'agent-check';
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.value = token;
        cb.checked = granted.has(token);
        const txt = document.createElement('span');
        txt.textContent = CAPABILITY_LABELS[cap] || cap;
        row.appendChild(cb);
        row.appendChild(txt);
        intentsGrantsList.appendChild(row);
      }
    }
  }

  function collectPluginGrants() {
    const checked = Array.from(intentsGrantsList.querySelectorAll('input[type="checkbox"]:checked')).map((cb) => cb.value);
    return mergeGrants(checked, unlistedGrants);
  }

  function closeIntentsPopover() {
    intentsPopover.classList.add('hidden');
    intentsPopover.dataset.name = '';
  }

  async function openIntentsPopover(name, anchorBtn) {
    const res = await window.api.getSessionArgs(name);
    if (!res || !res.ok) { alert('Session not found in persistence.'); return; }
    // res.intents is the raw persisted allowlist (array, or null = all-enabled).
    // Rows are SERVED (intents:catalog), so seed the cache first, same as the dialog.
    setPluginCatalogCache((await window.api.pluginCatalog()) || []);
    intentsPluginsPersisted = Array.isArray(res.plugins) ? res.plugins : null;
    renderPluginChecklist(intentsPluginsList, res.plugins);
    const ticked = collectPluginChecklist(intentsPluginsList);
    setIntentCatalogCache((await window.api.getIntentCatalog(name, ticked)) || []);
    renderIntentChecklist(popoverIntentsList, res.intents);
    // res.execCommands is the seat's persisted grant list (local session, never
    // stripped — the wire strip is peer-only). Readout dims live off the exec box.
    renderExecGrantReadout(res.execCommands || []);
    let grantsRes = null;
    try { grantsRes = await window.api.getSessionPluginGrants(name, ticked); } catch {}
    renderPluginGrants(grantsRes && grantsRes.ok ? grantsRes : null);
    intentsPopoverRestart.checked = false;
    intentsPopoverName.textContent = name;
    intentsPopover.dataset.name = name;
    resetDrag(intentsPopover); // a fresh open re-anchors; drop any prior drag offset
    intentsPopover.classList.remove('hidden');
    placeAboveAnchor(intentsPopover, anchorBtn, BAR_ANCHOR);
  }

  document.getElementById('intents-popover-cancel').addEventListener('click', closeIntentsPopover);
  document.getElementById('intents-popover-close').addEventListener('click', closeIntentsPopover);
  document.getElementById('intents-popover-apply').addEventListener('click', async () => {
    const name = intentsPopover.dataset.name;
    if (!name) return closeIntentsPopover();
    const intents = collectIntentChecklist(popoverIntentsList); // array | null
    // null, not [], when NOTHING is loaded (kill switch, or all globally
    // disabled): the checklist draws no rows and collect returns [], which would
    // strip a seat of plugins it still has on a path that only edits intents.
    const plugins = getPluginCatalogCache().length
      ? mergePlugins(collectPluginChecklist(intentsPluginsList),
        pluginsForUnlistedPlugins(intentsPluginsPersisted, getPluginCatalogCache().map((p) => String(p.id))))
      : null;
    // Read BEFORE the close: closing does not clear the list, but the two reads
    // must describe the same dialog state, and a later read is a later state.
    const grantsShown = !intentsGrantsBlock.classList.contains('hidden');
    const grants = grantsShown ? collectPluginGrants() : null;
    const restart = intentsPopoverRestart.checked;
    closeIntentsPopover();
    // PARENT FIRST: the server prunes both children against the list it has just
    // been given, so a following child write cannot fight the prune.
    if (plugins) {
      const pr = await window.api.setSessionPlugins(name, plugins);
      if (!pr || !pr.ok) { alert(`Update plugins failed: ${pr && pr.error ? pr.error : 'unknown error'}`); return; }
      refreshSidebarMeta({ includePr: false });
    }
    const r = await window.api.setSessionIntents(name, intents);
    if (!r || !r.ok) { alert(`Update intents failed: ${r && r.error ? r.error : 'unknown error'}`); return; }
    // Only when the block was actually drawn: a save from a dialog that never
    // showed the grants must not revoke grants it never displayed.
    if (grants) {
      const g = await window.api.setSessionPluginGrants(name, grants);
      if (!g || !g.ok) { alert(`Update plugin access failed: ${g && g.error ? g.error : 'unknown error'}`); return; }
    }
    if (!restart) return;
    // Same re-attach dance as the tools popover's restart path.
    const item = sessionList.querySelector(`[data-name="${CSS.escape(name)}"]`);
    const snapType = item ? item.dataset.type || null : null;
    const snapCwd = item ? item.dataset.cwd : null;
    const rr = await window.api.restartSession(name);
    if (!rr || !rr.ok) { alert(`Restart failed: ${rr && rr.error ? rr.error : 'unknown error'}`); return; }
    if (snapType) {
      createTerminal(name);
      addSessionToSidebar(name, snapType, snapCwd, null);
      switchSession(name);
    }
  });
  document.addEventListener('mousedown', (e) => {
    if (intentsPopover.classList.contains('hidden')) return;
    if (intentsPopover.contains(e.target)) return;
    if (e.target.closest('.px-action')) return; // the menu/toggle button handles itself
    closeIntentsPopover();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !intentsPopover.classList.contains('hidden')) closeIntentsPopover();
  });
  // Live-refresh the exec-grant readout when the exec box is toggled directly. The
  // bulk Check-all/Uncheck-all buttons set .checked programmatically (no change
  // event), so those are hooked separately below, after wireBulkToggles.
  popoverIntentsList.addEventListener('change', (e) => {
    if (e.target && e.target.value === 'exec') refreshExecReadoutInertState();
  });

  const pluginsPopover = document.getElementById('plugins-popover');
  const pluginsPopoverName = document.getElementById('plugins-popover-name');
  const popoverPluginsList = document.getElementById('popover-plugins-list');
  const pluginsPopoverRestart = document.getElementById('plugins-popover-restart');
  let pluginsPersisted = null;

  function closePluginsPopover() {
    pluginsPopover.classList.add('hidden');
    pluginsPopover.dataset.name = '';
  }

  async function openPluginsPopover(name, anchorBtn) {
    const res = await window.api.getSessionArgs(name);
    if (!res || !res.ok) { alert('Session not found in persistence.'); return; }
    setPluginCatalogCache((await window.api.pluginCatalog()) || []);
    pluginsPersisted = Array.isArray(res.plugins) ? res.plugins : null;
    renderPluginChecklist(popoverPluginsList, res.plugins);
    pluginsPopoverRestart.checked = false;
    pluginsPopoverName.textContent = name;
    pluginsPopover.dataset.name = name;
    resetDrag(pluginsPopover);
    pluginsPopover.classList.remove('hidden');
    placeAboveAnchor(pluginsPopover, anchorBtn, BAR_ANCHOR);
  }

  document.getElementById('plugins-popover-cancel').addEventListener('click', closePluginsPopover);
  document.getElementById('plugins-popover-close').addEventListener('click', closePluginsPopover);
  document.getElementById('plugins-popover-apply').addEventListener('click', async () => {
    const name = pluginsPopover.dataset.name;
    if (!name) return closePluginsPopover();
    const plugins = getPluginCatalogCache().length
      ? mergePlugins(collectPluginChecklist(popoverPluginsList),
        pluginsForUnlistedPlugins(pluginsPersisted, getPluginCatalogCache().map((p) => String(p.id))))
      : null;
    const restart = pluginsPopoverRestart.checked;
    closePluginsPopover();
    if (!plugins) return;
    const r = await window.api.setSessionPlugins(name, plugins);
    if (!r || !r.ok) { alert(`Update plugins failed: ${r && r.error ? r.error : 'unknown error'}`); return; }
    refreshSidebarMeta({ includePr: false });
    if (!restart) return;
    const item = sessionList.querySelector(`[data-name="${CSS.escape(name)}"]`);
    const snapType = item ? item.dataset.type || null : null;
    const snapCwd = item ? item.dataset.cwd : null;
    const rr = await window.api.restartSession(name);
    if (!rr || !rr.ok) { alert(`Restart failed: ${rr && rr.error ? rr.error : 'unknown error'}`); return; }
    if (snapType) {
      createTerminal(name);
      addSessionToSidebar(name, snapType, snapCwd, null);
      switchSession(name);
    }
  });
  document.addEventListener('mousedown', (e) => {
    if (pluginsPopover.classList.contains('hidden')) return;
    if (pluginsPopover.contains(e.target)) return;
    if (e.target.closest('.px-action')) return;
    closePluginsPopover();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !pluginsPopover.classList.contains('hidden')) closePluginsPopover();
  });

  // Bulk "Check all / Uncheck all" controls for the checklist popovers.
  wireBulkToggles(toolsPopover, popoverToolsList);
  wireBulkToggles(skillsPopover, popoverSkillsList);
  wireBulkToggles(agentsPopover, popoverAgentsList);
  wireBulkToggles(intentsPopover, popoverIntentsList);
  wireBulkToggles(pluginsPopover, popoverPluginsList);
  // Bulk toggles set .checked programmatically (no change event fires), so refresh
  // the exec-grant readout's inert state after a bulk check/uncheck flips exec too.
  intentsPopover.querySelectorAll('.popover-bulk [data-bulk]').forEach((btn) => {
    btn.addEventListener('click', () => refreshExecReadoutInertState());
  });

  // Always-reachable ✕ close buttons (tools/skills; the rest are wired
  // in-section above). A tall popover can push outside-click/Escape out of reach.
  document.getElementById('tools-popover-close').addEventListener('click', closeToolsPopover);
  document.getElementById('skills-popover-close').addEventListener('click', closeSkillsPopover);

  // Draggable by their shared .popover-title (Slice 4 C5). resetDrag on each open
  // (above) keeps the anchor positioning authoritative on reopen.
  makeDraggable(toolsPopover);
  makeDraggable(skillsPopover);
  makeDraggable(agentsPopover);
  makeDraggable(intentsPopover);
  makeDraggable(pluginsPopover);

  return { openToolsPopover, openSkillsPopover, openAgentsPopover, openIntentsPopover, openPluginsPopover };
}

module.exports = { initChecklistPopovers };
