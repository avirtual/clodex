// popovers/checklist-popovers.js — the three local config-editor popovers off
// the proxy bar's ⚙ actions: Tools, Skills, and Agents/Builtins. Each renders a
// checklist of the session's current config, and Apply persists it (optionally
// with a hard restart + terminal re-attach). Self-contained island: DOM handles,
// dismiss wiring, and bulk-toggle wiring live here; the openers are returned.
//
// NOTE these read/write settings and restart via window.api directly
// (getSettings/getSessionArgs/setSession{Tools,Skills,Agents}/restartSession);
// that is outside the popoverApi read-only data seam by design. The restart
// re-attach dance needs core sessionList/createTerminal/addSessionToSidebar/
// switchSession, injected by reference.
//   Tools/Agents are LOCAL-only (no peer variant — the bar suppresses them for
// peer tabs; they're covered remotely via the Edit Session args dialog). SKILLS
// takes an optional peer `source` ({fetch, save, restartFresh}) so the same
// popover edits a peer session's skills over the wire (peers-ui builds the
// source; the box's catalog/library is the truth). Local path: source omitted,
// byte-equivalent to before.
//
// DOM-bound, so no unit tests per the R1 rule — move-only fidelity is the guarantee.

const {
  renderToolChecklist, collectToolChecklist, renderSkillChecklist, collectSkillChecklist,
  renderInjectChecklist, collectInjectChecklist, renderAgentChecklist, collectAgentChecklist,
  renderBuiltinChecklist, collectBuiltinChecklist, wireBulkToggles,
  renderIntentChecklist, collectIntentChecklist,
  setClaudeToolsCache, setSkillLibCache, setAgentLibCache, getSkillLibCache,
} = require('../lib/checklists');
const { autoEnabledFor, reconcilePartialSelection } = require('../../scope-util');
const { parseSkillFrontmatter } = require('../../skills-util');

// Names auto-INCLUDED for `session` by `sessions:` scope, for a scoped checklist.
// Agents carry parsed `meta`; skills carry only raw `content` (re-parse it, same
// grammar the library drawer uses). Feeds render (checked+disabled `· auto`) and
// the Save reconcile (exclude from the persisted set).
const agentAutoSet = (agentLib, session) => new Set(autoEnabledFor(agentLib || [], session));
const skillAutoSet = (skillLib, session) => new Set(autoEnabledFor(
  (skillLib || []).map((s) => ({ name: s.name, meta: parseSkillFrontmatter(s.content || '').meta })), session));

function initChecklistPopovers({ sessionList, createTerminal, addSessionToSidebar, switchSession }) {
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
    toolsPopover.classList.remove('hidden');
    // Anchor above the button, clamped to the viewport.
    const r = anchorBtn.getBoundingClientRect();
    const w = toolsPopover.offsetWidth;
    toolsPopover.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - w - 8))}px`;
    toolsPopover.style.bottom = `${Math.max(8, window.innerHeight - r.top + 6)}px`;
  }

  document.getElementById('tools-popover-cancel').addEventListener('click', closeToolsPopover);
  document.getElementById('tools-popover-apply').addEventListener('click', async () => {
    const name = toolsPopover.dataset.name;
    if (!name) return closeToolsPopover();
    const disabledTools = collectToolChecklist(popoverToolsList);
    const restart = toolsPopoverRestart.checked;
    closeToolsPopover();
    const r = await window.api.setSessionTools(name, disabledTools);
    if (!r || !r.ok) { alert(`Failed to update tools: ${r && r.error ? r.error : 'unknown error'}`); return; }
    if (!restart) return;
    // Same re-attach dance as the context-menu restart path.
    const item = sessionList.querySelector(`[data-name="${CSS.escape(name)}"]`);
    const snapType = item ? item.querySelector('.session-type')?.textContent : null;
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
    if (!res || !res.ok) { alert(source ? `Could not read skills on peer: ${res && res.error ? res.error : 'unknown error'}` : 'Session not found in persistence.'); return; }
    skillsEditingSource = source;
    renderSkillChecklist(popoverSkillsList, res.names || [], new Set(res.disabledSkills || []),
      res.effective || {}, { skillsLocked: res.skillsLocked, canReenable: res.canReenable });
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
    skillsPopover.classList.remove('hidden');
    const r = anchorBtn.getBoundingClientRect();
    const w = skillsPopover.offsetWidth;
    skillsPopover.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - w - 8))}px`;
    // Bottom-anchored; clamp so the top stays on-screen. The local ⚙ anchor sits
    // in the bottom bar where the clamp is a no-op; a peer sidebar ROW anchor can
    // sit high enough that the unclamped bottom would push the popover past the
    // viewport top.
    const wantBottom = Math.max(8, window.innerHeight - r.top + 6);
    const maxBottom = Math.max(8, window.innerHeight - skillsPopover.offsetHeight - 8);
    skillsPopover.style.bottom = `${Math.min(wantBottom, maxBottom)}px`;
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
    if (!r || !r.ok) { alert(`Failed to update skills: ${r && r.error ? r.error : 'unknown error'}`); return; }
    if (!restart) return;
    // Fresh (non-resume) restart — the only way a skill change takes effect.
    if (source) { source.restartFresh(); return; }
    // Local: same re-attach dance as the tools popover restart path.
    const item = sessionList.querySelector(`[data-name="${CSS.escape(name)}"]`);
    const snapType = item ? item.querySelector('.session-type')?.textContent : null;
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
    agentsPopover.classList.remove('hidden');
    const r = anchorBtn.getBoundingClientRect();
    const w = agentsPopover.offsetWidth;
    agentsPopover.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - w - 8))}px`;
    agentsPopover.style.bottom = `${Math.max(8, window.innerHeight - r.top + 6)}px`;
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
    if (!r || !r.ok) { alert(`Failed to update agents: ${r && r.error ? r.error : 'unknown error'}`); return; }
    if (!restart) return;
    // Fresh (non-resume) restart — same re-attach dance as the skills popover.
    const item = sessionList.querySelector(`[data-name="${CSS.escape(name)}"]`);
    const snapType = item ? item.querySelector('.session-type')?.textContent : null;
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

  function closeIntentsPopover() {
    intentsPopover.classList.add('hidden');
    intentsPopover.dataset.name = '';
  }

  async function openIntentsPopover(name, anchorBtn) {
    const res = await window.api.getSessionArgs(name);
    if (!res || !res.ok) { alert('Session not found in persistence.'); return; }
    // res.intents is the raw persisted allowlist (array, or null = all-enabled);
    // renderIntentChecklist reads it through intentEnabled, same as the dialog.
    renderIntentChecklist(popoverIntentsList, res.intents);
    intentsPopoverRestart.checked = false;
    intentsPopoverName.textContent = name;
    intentsPopover.dataset.name = name;
    intentsPopover.classList.remove('hidden');
    const r = anchorBtn.getBoundingClientRect();
    const w = intentsPopover.offsetWidth;
    intentsPopover.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - w - 8))}px`;
    intentsPopover.style.bottom = `${Math.max(8, window.innerHeight - r.top + 6)}px`;
  }

  document.getElementById('intents-popover-cancel').addEventListener('click', closeIntentsPopover);
  document.getElementById('intents-popover-close').addEventListener('click', closeIntentsPopover);
  document.getElementById('intents-popover-apply').addEventListener('click', async () => {
    const name = intentsPopover.dataset.name;
    if (!name) return closeIntentsPopover();
    const intents = collectIntentChecklist(popoverIntentsList); // array | null
    const restart = intentsPopoverRestart.checked;
    closeIntentsPopover();
    const r = await window.api.setSessionIntents(name, intents);
    if (!r || !r.ok) { alert(`Failed to update intents: ${r && r.error ? r.error : 'unknown error'}`); return; }
    if (!restart) return;
    // Same re-attach dance as the tools popover's restart path.
    const item = sessionList.querySelector(`[data-name="${CSS.escape(name)}"]`);
    const snapType = item ? item.querySelector('.session-type')?.textContent : null;
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

  // Bulk "Check all / Uncheck all" controls for the checklist popovers.
  wireBulkToggles(toolsPopover, popoverToolsList);
  wireBulkToggles(skillsPopover, popoverSkillsList);
  wireBulkToggles(agentsPopover, popoverAgentsList);
  wireBulkToggles(intentsPopover, popoverIntentsList);

  // Always-reachable ✕ close buttons (tools/skills; agents'/intents' are wired
  // in-section above). A tall popover can push outside-click/Escape out of reach.
  document.getElementById('tools-popover-close').addEventListener('click', closeToolsPopover);
  document.getElementById('skills-popover-close').addEventListener('click', closeSkillsPopover);

  return { openToolsPopover, openSkillsPopover, openAgentsPopover, openIntentsPopover };
}

module.exports = { initChecklistPopovers };
