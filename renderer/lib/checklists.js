// checklists.js — the six render/collect checklist pairs shared across the
// new-session dialog, the per-session edit popovers, the args-edit dialog, and
// the preferences pane (append-prompts, subagents, built-in agents, injected
// skills, tools, skills), plus the bulk check/uncheck helpers.
//
// SANCTIONED SEAM (R2): five caches these render functions read
// (promptLibCache, agentLibCache, skillLibCache, claudeToolsCache,
// defaultToolDenyCache) were module-level `let`s in renderer.js, reassigned
// from ~14 sites — impossible to extract byte-identical while sharing the live
// binding. They now live here as PRIVATE module state fronted by explicit
// setters; renderer.js reassignment sites call the setters. Three are also READ
// outside the checklist path (promptLibCache in fillSystemPromptSelect,
// skillLibCache in the skills popover, defaultToolDenyCache in the new-session
// tool refresh), so those get getters. The render/collect FUNCTION BODIES are
// byte-identical moves; only the cache access is seamed.
//
// DOM-bound (document.createElement + esc route through the global document),
// so no unit tests per the R1 rule — move-only fidelity is the guarantee.

const { esc } = require('./format');
// Static gateable-intent catalog + the pure collect decision. Root leaf, like
// scope-util/skills-util in checklist-popovers.js — the rows are a compile-time
// constant (no IPC/cache, unlike the exec registry), so this checklist needs no
// setter/refresh: it renders straight off the catalog.
const { GATEABLE_INTENTS, intentEnabled, intentsAllowlistFromChecked } = require('../../intent-catalog');

// ---- Owned cache state (the sanctioned seam) ----
// Prompt library: `system` prompts fill a <select> (one replaces the CLI
// default); `append` prompts fill a checklist (0+ compose, filename order).
let promptLibCache = { system: [], append: [] };
let agentLibCache = [];
// Custom-skill injection library (opt-in checklist; checked names scaffold into
// a --plugin-dir at spawn).
let skillLibCache = [];
// Exec-command registry (opt-in grant checklist; checked names become the
// session's `execCommands` allowlist — which commands its seat may run).
let execLibCache = [];
let claudeToolsCache = [];
// Global default tool-deny set (the "*" agent-default); new sessions start with
// these tools unchecked.
let defaultToolDenyCache = [];

// Setters — every renderer.js reassignment routes through these.
function setPromptLibCache(v) { promptLibCache = v; }
function setAgentLibCache(v) { agentLibCache = v; }
function setSkillLibCache(v) { skillLibCache = v; }
function setExecLibCache(v) { execLibCache = v; }
function setClaudeToolsCache(v) { claudeToolsCache = v; }
function setDefaultToolDenyCache(v) { defaultToolDenyCache = v; }

// Getters — for the three caches also read outside the checklist render path.
function getPromptLibCache() { return promptLibCache; }
function getSkillLibCache() { return skillLibCache; }
function getDefaultToolDenyCache() { return defaultToolDenyCache; }

function renderAppendChecklist(container, enabledSet) {
  container.innerHTML = '';
  if (!promptLibCache.append.length) {
    container.innerHTML = '<span class="hint-text">No append prompts in library — add some via the Prompts drawer.</span>';
    return;
  }
  for (const p of promptLibCache.append) {
    const row = document.createElement('label');
    row.className = 'agent-check';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.value = p.name;
    cb.checked = enabledSet.has(p.name);
    const preview = (p.body.split('\n')[0] || '').slice(0, 60);
    const txt = document.createElement('span');
    txt.innerHTML = `<strong>${esc(p.name)}</strong>${preview ? ' — ' + esc(preview) : ''}`;
    row.appendChild(cb);
    row.appendChild(txt);
    container.appendChild(row);
  }
}
function collectAppendChecklist(container) {
  return Array.from(container.querySelectorAll('input[type="checkbox"]:checked')).map(cb => cb.value);
}

// `autoSet` (optional) = names auto-INCLUDED for this session by `sessions:`
// scope. Such a row renders CHECKED + disabled + a dim `· auto` suffix so the
// forced injection is visible instead of a checkbox that lies (the spawn union
// re-adds it regardless of the persisted state). collect + the save reconcile
// exclude auto names so they're never written to the persisted record.
function renderAgentChecklist(container, enabledSet, autoSet = null) {
  container.innerHTML = '';
  if (!agentLibCache.length) {
    container.innerHTML = '<span class="hint-text">No agents in library — add some via the 🤖 Agents drawer.</span>';
    return;
  }
  for (const a of agentLibCache) {
    const auto = !!(autoSet && autoSet.has(a.name));
    const row = document.createElement('label');
    row.className = 'agent-check';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.value = a.name;
    cb.checked = auto || enabledSet.has(a.name);
    if (auto) cb.disabled = true;
    const txt = document.createElement('span');
    txt.innerHTML = `<strong>${esc(a.name)}</strong>${a.description ? ' — ' + esc(a.description) : ''}${auto ? ' <span class="auto-flag">· auto</span>' : ''}`;
    row.appendChild(cb);
    row.appendChild(txt);
    container.appendChild(row);
  }
}
function collectAgentChecklist(container) {
  return Array.from(container.querySelectorAll('input[type="checkbox"]:checked')).map(cb => cb.value);
}

// Exec-command grant checklist — checked = this session's seat MAY run that
// registered command (its persisted `execCommands` allowlist). Plain opt-in
// checklist over the exec registry; no auto/scope dimension. A command's argv
// preview is the row hint so the operator sees what a grant actually authorizes.
function renderExecChecklist(container, enabledSet) {
  container.innerHTML = '';
  if (!execLibCache.length) {
    container.innerHTML = '<span class="hint-text">No exec commands in library — register some via File ▸ Exec Commands….</span>';
    return;
  }
  for (const c of execLibCache) {
    const row = document.createElement('label');
    row.className = 'agent-check';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.value = c.name;
    cb.checked = enabledSet.has(c.name);
    const argv = (c.argv || []).join(' ');
    const txt = document.createElement('span');
    txt.innerHTML = `<strong>${esc(c.name)}</strong>${argv ? ' — ' + esc(argv) : ''}`;
    row.appendChild(cb);
    row.appendChild(txt);
    container.appendChild(row);
  }
}
function collectExecChecklist(container) {
  return Array.from(container.querySelectorAll('input[type="checkbox"]:checked')).map(cb => cb.value);
}

// Per-session intent gate — which `[agent:…]` verbs this seat may EMIT (send-side;
// a gated seat still RECEIVES). Polarity is INVERTED from exec's opt-in: checked =
// enabled, and the default is ALL checked, because `intents` is an opt-OUT field
// (absent = everything on, the living all-enabled default). So the row's checked
// state comes from `intentEnabled(type, intentsList)` — the exact catalog semantics
// the fire-time gate reads — where `intentsList` is the raw persisted value
// (array, or null/undefined = all-enabled), NOT a Set. `name` is never a row
// (ungateable identity). Rendered off the static catalog; no cache/refresh.
function renderIntentChecklist(container, intentsList) {
  container.innerHTML = '';
  for (const it of GATEABLE_INTENTS) {
    const row = document.createElement('label');
    row.className = 'agent-check';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.value = it.type;
    cb.checked = intentEnabled(it.type, intentsList);
    const txt = document.createElement('span');
    txt.innerHTML = `<strong>${esc(it.label)}</strong>`;
    row.appendChild(cb);
    row.appendChild(txt);
    container.appendChild(row);
  }
}
// Thin DOM gatherer → the pure decision lives in intent-catalog: all boxes checked
// yields NULL (omit the field so the seat stays the all-enabled default), else the
// enabled subset in catalog order. `[]` (nothing checked) is a real "everything
// gated" value.
function collectIntentChecklist(container) {
  const checked = Array.from(container.querySelectorAll('input[type="checkbox"]:checked')).map(cb => cb.value);
  return intentsAllowlistFromChecked(checked);
}

// The built-in subagents the CLI injects into the roster — single-sourced in
// agents-util (the main process computes the same roster for the injected-skill
// subagent-ref check, so the list must not fork). See the definition there for
// the full rationale (per-turn description cost, deny = real roster trim).
const { BUILTIN_AGENTS } = require('../../agents-util');

// Checklist polarity matches tools/skills: checked = available, unchecked =
// denied. `deniedSet` is the persisted denyBuiltins list; collect returns the
// unchecked (denied) names.
function renderBuiltinChecklist(container, deniedSet) {
  container.innerHTML = '';
  for (const name of BUILTIN_AGENTS) {
    const row = document.createElement('label');
    row.className = 'agent-check';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.value = name;
    cb.checked = !deniedSet.has(name);
    const txt = document.createElement('span');
    txt.innerHTML = `<strong>${esc(name)}</strong>`;
    row.appendChild(cb);
    row.appendChild(txt);
    container.appendChild(row);
  }
}
function collectBuiltinChecklist(container) {
  return Array.from(container.querySelectorAll('input[type="checkbox"]:not(:checked)')).map(cb => cb.value);
}

// Bulk check/uncheck for a popover checklist. Skips :disabled rows (e.g. skills
// locked by a lower settings layer) so "Check all" never tries to re-enable
// something clodex can't actually toggle. `wireBulkToggles` hooks the
// data-bulk="all"/"none" buttons sitting above `listEl` to it.
function setChecklistAll(listEl, checked) {
  listEl.querySelectorAll('input[type="checkbox"]:not(:disabled)').forEach(cb => { cb.checked = checked; });
}
function wireBulkToggles(popoverEl, listEl) {
  popoverEl.querySelectorAll('.popover-bulk [data-bulk]').forEach(btn => {
    btn.addEventListener('click', () => setChecklistAll(listEl, btn.dataset.bulk === 'all'));
  });
}

// `autoSet` (optional): same `sessions:`-scope auto-include semantics as
// renderAgentChecklist — a matched skill renders CHECKED + disabled + `· auto`.
function renderInjectChecklist(container, enabledSet, autoSet = null) {
  container.innerHTML = '';
  if (!skillLibCache.length) {
    container.innerHTML = '<span class="hint-text">No skills in library — add some via the 🧩 Skill Library (Skills menu).</span>';
    return;
  }
  for (const s of skillLibCache) {
    const auto = !!(autoSet && autoSet.has(s.name));
    const row = document.createElement('label');
    row.className = 'agent-check';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.value = s.name;
    cb.checked = auto || enabledSet.has(s.name);
    if (auto) cb.disabled = true;
    const txt = document.createElement('span');
    txt.innerHTML = `<strong>${esc(s.name)}</strong>${s.description ? ' — ' + esc(s.description) : ''}${auto ? ' <span class="auto-flag">· auto</span>' : ''}`;
    row.appendChild(cb);
    row.appendChild(txt);
    container.appendChild(row);
  }
}
function collectInjectChecklist(container) {
  return Array.from(container.querySelectorAll('input[type="checkbox"]:checked')).map(cb => cb.value);
}

// Mirror of renderSkillChecklist for tools. `disabledSet` is clodex's own
// layer-4 off list; `effective` (tool -> {value:'off', source, locked}) is the
// lower-layer permissions.deny state. A tool denied in a layer clodex doesn't
// own renders unchecked + read-only + labeled with provenance — and because
// permissions.deny is union (no allow overrides a deny), it is ALWAYS read-only
// here, never re-enableable from clodex's settings (unlike skills' canReenable).
function renderToolChecklist(container, disabledSet, effective) {
  effective = effective || {};
  container.innerHTML = '';
  // Catalog is authoritative: render only known tools. A stale name in
  // disabledSet (removed from the catalog, or persisted before our time) is
  // intentionally NOT shown — it falls out of the deny on the next Apply.
  const names = [...claudeToolsCache];
  if (!names.length) {
    container.innerHTML = '<span class="hint-text">No tool catalog available.</span>';
    return;
  }
  for (const name of names) {
    const eff = effective[name];
    const lowerOff = !!(eff && eff.value === 'off');
    const clodexOff = disabledSet.has(name);
    const row = document.createElement('label');
    row.className = 'agent-check' + (lowerOff ? ' skill-readonly' : '');
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.value = name;
    cb.checked = !clodexOff && !lowerOff;
    if (lowerOff) cb.disabled = true; // external deny is unrevokable from here
    const txt = document.createElement('span');
    let note = '';
    if (lowerOff) note = eff.locked
      ? ' <span class="skill-src">denied by policy</span>'
      : ` <span class="skill-src">off via ${esc(eff.source)} settings</span>`;
    txt.innerHTML = `<strong>${esc(name)}</strong>${note}`;
    row.appendChild(cb);
    row.appendChild(txt);
    container.appendChild(row);
  }
}
// Returns the UNCHECKED, toggleable tools (clodex's off list). A read-only row
// is owned by a lower settings layer / policy, not clodex, so it's excluded.
function collectToolChecklist(container) {
  return Array.from(container.querySelectorAll('input[type="checkbox"]:not(:checked):not(:disabled)')).map(cb => cb.value);
}

// Skills mirror tools. The catalog combines a static seed (CLAUDE_SKILLS), the
// live transcript roster, clodex's own off list, and any skill a LOWER settings
// layer mentions. A skill that's off in a lower layer (global/project/local
// settings) or locked by managed policy is rendered unchecked + disabled +
// labeled with provenance: clodex can't change it from its layer-4 file (a
// lower-layer off can only be re-enabled if SKILL_REENABLE_CONFIRMED, a managed
// lock never), so we show it honestly rather than as a silently-inert toggle.
function renderSkillChecklist(container, names, disabledSet, effective, opts) {
  effective = effective || {};
  opts = opts || {};
  const canReenable = !!opts.canReenable;
  const skillsLocked = !!opts.skillsLocked;
  container.innerHTML = '';
  if (!names || !names.length) {
    container.innerHTML = '<span class="hint-text">No skills detected yet — they appear once the session has run a turn.</span>';
    return;
  }
  for (const name of names) {
    const eff = effective[name];
    const lowerOff = !!(eff && eff.value === 'off');
    const clodexOff = disabledSet.has(name);
    // Read-only when clodex's layer-4 write can't actually change it: a lower-
    // layer off we can't re-enable yet, or a managed-policy lock.
    const readonly = skillsLocked || (lowerOff && !canReenable);
    const row = document.createElement('label');
    row.className = 'agent-check' + (readonly ? ' skill-readonly' : '');
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.value = name;
    cb.checked = !clodexOff && !lowerOff;
    if (readonly) cb.disabled = true;
    const txt = document.createElement('span');
    let note = '';
    if (skillsLocked) note = ' <span class="skill-src">locked by policy</span>';
    else if (lowerOff) note = ` <span class="skill-src">off via ${esc(eff.source)} settings</span>`;
    txt.innerHTML = `<strong>${esc(name)}</strong>${note}`;
    row.appendChild(cb);
    row.appendChild(txt);
    container.appendChild(row);
  }
}
// Only collect toggleable rows: a disabled (read-only) checkbox is owned by a
// lower layer / policy, not by clodex, so it never enters clodex's off list.
function collectSkillChecklist(container) {
  return Array.from(container.querySelectorAll('input[type="checkbox"]:not(:checked):not(:disabled)')).map(cb => cb.value);
}

module.exports = {
  renderAppendChecklist, collectAppendChecklist,
  renderAgentChecklist, collectAgentChecklist,
  renderExecChecklist, collectExecChecklist,
  renderIntentChecklist, collectIntentChecklist,
  renderBuiltinChecklist, collectBuiltinChecklist,
  renderInjectChecklist, collectInjectChecklist,
  renderToolChecklist, collectToolChecklist,
  renderSkillChecklist, collectSkillChecklist,
  setChecklistAll, wireBulkToggles,
  setPromptLibCache, setAgentLibCache, setSkillLibCache, setExecLibCache,
  setClaudeToolsCache, setDefaultToolDenyCache,
  getPromptLibCache, getSkillLibCache, getDefaultToolDenyCache,
};
