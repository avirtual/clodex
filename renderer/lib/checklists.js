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
// so the MOVED bodies are guaranteed by move-only fidelity. What is not a move
// is tested: the skill rows' read-only decision, where an out-of-scope row that
// still collects writes an off-list entry that disables nothing, and the bundle
// rows, where one that still collects writes a name no flat library holds.

const { esc } = require('./format');
const { seatHasPlugin } = require('../../plugin-api');
// NOTE — this file no longer requires intent-catalog. The gateable-intent rows
// were a static require while the catalog was a compile-time constant; that
// became wrong twice over (plugin plan MUST-FIX 2): a plugin can register a verb
// at runtime, and the web bundle's copy of the catalog is FROZEN AT BUILD TIME,
// so a served renderer would show a stale row set forever. Rows now arrive over
// IPC (`intents:catalog`) into a cache with a setter — the same sanctioned seam
// `setExecLibCache` uses. Checked-state is still computed here (the three-line
// privileged/absent-list semantics), but the ALLOWLIST ITSELF is computed
// engine-side, where the registry is authoritative.

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
// Gateable-intent catalog, served by the engine (`intents:catalog`). Rows are
// `{ type, label, privileged }` — core rows in catalog order, then any plugin
// verbs. Empty until the first fetch, which is fine: every render path awaits a
// refresh before painting, exactly like the exec registry above.
let intentCatalogCache = [];
let pluginCatalogCache = [];
let claudeToolsCache = [];
// Global default tool-deny set (the "*" agent-default); new sessions start with
// these tools unchecked.
let defaultToolDenyCache = [];

// Setters — every renderer.js reassignment routes through these.
function setPromptLibCache(v) { promptLibCache = v; }
function setAgentLibCache(v) { agentLibCache = v; }
function setSkillLibCache(v) { skillLibCache = v; }
function setExecLibCache(v) { execLibCache = v; }
function setIntentCatalogCache(v) { intentCatalogCache = Array.isArray(v) ? v : []; }
function setPluginCatalogCache(v) { pluginCatalogCache = Array.isArray(v) ? v : []; }
function getPluginCatalogCache() { return pluginCatalogCache; }
function setClaudeToolsCache(v) { claudeToolsCache = v; }
function setDefaultToolDenyCache(v) { defaultToolDenyCache = v; }

// Getters — for the three caches also read outside the checklist render path.
function getPromptLibCache() { return promptLibCache; }
function getSkillLibCache() { return skillLibCache; }
function getDefaultToolDenyCache() { return defaultToolDenyCache; }

function renderAppendChecklist(container, enabledSet, seat = null) {
  container.innerHTML = '';
  if (!promptLibCache.append.length && !hasBundleRows('prompts/append', seat)) {
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
  appendBundleSections(container, 'prompts/append', seat, enabledSet);
}
function collectAppendChecklist(container) {
  return Array.from(container.querySelectorAll('input[type="checkbox"]:checked')).map(cb => cb.value);
}

const BUNDLE_KINDS = {
  skills: { field: 'skills', promptKind: null },
  agents: { field: 'agents', promptKind: null },
  templates: { field: 'templates', promptKind: null },
  'prompts/system': { field: 'prompts', promptKind: 'system' },
  'prompts/append': { field: 'prompts', promptKind: 'append' },
};

function bundleSectionsOf(kind) {
  const spec = BUNDLE_KINDS[kind] || { field: kind, promptKind: null };
  const out = [];
  for (const p of pluginCatalogCache) {
    const raw = Array.isArray(p[spec.field]) ? p[spec.field] : [];
    const entries = raw
      .filter((e) => !spec.promptKind || (e && e.kind === spec.promptKind))
      .map((e) => (e && typeof e === 'object' ? e : { name: e }))
      .filter((e) => typeof e.name === 'string' && e.name);
    if (!entries.length) continue;
    out.push({
      id: String(p.id), name: p.name || String(p.id),
      names: entries.map((e) => e.name), entries,
      shipped: p.shipped, editable: p.editable === true, dir: p.dir || null,
    });
  }
  return out;
}

function seatBundleSections(kind, seat) {
  if (!seat) return [];
  return bundleSectionsOf(kind).map((sec) => ({
    ...sec,
    has: seatHasPlugin(sec.id, seat.plugins, sec.shipped),
  }));
}

function hasBundleRows(kind, seat) {
  return seatBundleSections(kind, seat).length > 0;
}

function appendBundleSections(container, kind, seat, checkedSet = null) {
  for (const sec of seatBundleSections(kind, seat)) {
    const head = document.createElement('div');
    head.className = 'check-group';
    head.textContent = sec.name;
    container.appendChild(head);
    for (const n of sec.names) {
      const value = `${sec.id}:${n}`;
      const row = document.createElement('label');
      row.className = 'agent-check bundle-row' + (sec.has ? '' : ' skill-readonly');
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.value = value;
      cb.checked = checkedSet ? checkedSet.has(value) : sec.has;
      cb.disabled = true;
      const txt = document.createElement('span');
      const note = sec.has
        ? ` <span class="skill-src">· via ${esc(sec.name)}</span>`
        : ` <span class="skill-src">enable the ${esc(sec.name)} plugin for this session</span>`;
      txt.innerHTML = `<strong>${esc(n)}</strong>${note}`;
      row.appendChild(cb);
      row.appendChild(txt);
      container.appendChild(row);
    }
  }
}

function repaintBundleSections(container, kind, seat, checkedSet = null) {
  container.querySelectorAll('.check-group, .bundle-row').forEach((n) => n.remove());
  appendBundleSections(container, kind, seat, checkedSet);
}

// `autoSet` (optional) = names auto-INCLUDED for this session by `sessions:`
// scope. Such a row renders CHECKED + disabled + a dim `· auto` suffix so the
// forced injection is visible instead of a checkbox that lies (the spawn union
// re-adds it regardless of the persisted state). collect + the save reconcile
// exclude auto names so they're never written to the persisted record.
function renderAgentChecklist(container, enabledSet, autoSet = null, seat = null) {
  container.innerHTML = '';
  if (!agentLibCache.length && !hasBundleRows('agents', seat)) {
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
  appendBundleSections(container, 'agents', seat);
}
function collectAgentChecklist(container) {
  return Array.from(container.querySelectorAll('input[type="checkbox"]:checked:not(:disabled)')).map(cb => cb.value);
}

// Checked = this seat MAY run that registered command. The argv preview is the
// row hint so the operator sees what a grant actually authorizes.
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

// Polarity is INVERTED from exec's opt-in: checked = enabled, default ALL
// checked, because `intents` is opt-OUT (absent = everything on). `intentsList`
// is the raw persisted value, NOT a Set. Rendered off intentCatalogCache;
// refresh it (setIntentCatalogCache) before painting, like the exec registry.
//
// The semantics are INLINE rather than a call to intent-catalog's intentEnabled:
// that leaf would re-introduce the static require this seam exists to remove,
// and it answers TRUE for a plugin verb it has never heard of.
function intentRowChecked(row, intentsList) {
  if (!Array.isArray(intentsList)) return !row.privileged;
  return intentsList.includes(row.type);
}
function renderPluginChecklist(container, pluginsList) {
  container.innerHTML = '';
  if (!pluginCatalogCache.length) {
    container.innerHTML = '<span class="hint-text">No plugins loaded — enable some via Preferences ▸ Plugins.</span>';
    return;
  }
  const has = Array.isArray(pluginsList) ? new Set(pluginsList.map(String)) : null;
  for (const p of pluginCatalogCache) {
    const row = document.createElement('label');
    row.className = 'agent-check';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.value = p.id;
    cb.checked = has ? has.has(String(p.id)) : !!p.shipped;
    if (p.announce) row.dataset.tip = p.announce;
    const txt = document.createElement('span');
    txt.innerHTML = `<strong>${esc(p.name || p.id)}</strong>${p.announce ? ' — ' + esc(p.announce) : ''}`;
    row.appendChild(cb);
    row.appendChild(txt);
    container.appendChild(row);
  }
}
function collectPluginChecklist(container) {
  return Array.from(container.querySelectorAll('input[type="checkbox"]:checked')).map(cb => cb.value);
}

// The SHIPPED loaded plugins, which is the same set a seat with no list reaches
// (seatHasPlugin's absent case) — a new seat and a pre-upgrade one must start
// from the same place or the dialog hands out reach the gate then withholds.
// Not each manifest's `enabledByDefault`, which is agent-writable and would
// pre-tick a plugin the operator never enabled anywhere.
function defaultPluginTicks() {
  return pluginCatalogCache.filter((p) => p.shipped).map((p) => String(p.id));
}

// Core rows first and unchanged, then ONE `popover-subhead` per contributing
// plugin — an unticked plugin has no header and no rows at all. A SET, not the
// previous row: non-contiguous rows would draw a second header for one plugin.
function renderIntentChecklist(container, intentsList) {
  container.innerHTML = '';
  const nameOf = new Map(pluginCatalogCache.map((p) => [String(p.id), p.name || p.id]));
  const headed = new Set();
  for (const it of intentCatalogCache) {
    if (it.source && it.source !== 'core' && !headed.has(it.source)) {
      headed.add(it.source);
      const head = document.createElement('div');
      head.className = 'popover-subhead';
      head.textContent = nameOf.get(String(it.source)) || it.source;
      container.appendChild(head);
    }
    const row = document.createElement('label');
    row.className = 'agent-check';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.value = it.type;
    cb.checked = intentRowChecked(it, intentsList);
    const txt = document.createElement('span');
    txt.innerHTML = `<strong>${esc(it.label)}</strong>`;
    row.appendChild(cb);
    row.appendChild(txt);
    container.appendChild(row);
  }
}
// Thin DOM gatherer, and ONLY that: it returns the raw CHECKED SET, and the engine
// decides what that set means (`allowlistFromChecked`, called in session-args.js /
// the setIntents handler). The collapse used to happen here; it moved because only
// the engine knows the live row set — a renderer collapsing "all boxes checked" to
// null against a stale or plugin-less copy of the catalog would either drop a real
// grant or manufacture one (plugin plan MUST-FIX 3). `[]` (nothing checked) stays a
// real "everything gated" value on the wire.
function collectIntentChecklist(container) {
  return Array.from(container.querySelectorAll('input[type="checkbox"]:checked')).map(cb => cb.value);
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
function renderInjectChecklist(container, enabledSet, autoSet = null, seat = null) {
  container.innerHTML = '';
  if (!skillLibCache.length && !hasBundleRows('skills', seat)) {
    container.innerHTML = '<span class="hint-text">No skills in library — add some via the 🧩 Skills Library (Skills menu).</span>';
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
  appendBundleSections(container, 'skills', seat);
}
function collectInjectChecklist(container) {
  return Array.from(container.querySelectorAll('input[type="checkbox"]:checked:not(:disabled)')).map(cb => cb.value);
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

function renderToolAllowChecklist(container, allowedSet) {
  container.innerHTML = '';
  const names = [...claudeToolsCache];
  if (!names.length) {
    container.innerHTML = '<span class="hint-text">No tool catalog available.</span>';
    return;
  }
  for (const name of names) {
    const row = document.createElement('label');
    row.className = 'agent-check';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.value = name;
    cb.checked = !!(allowedSet && allowedSet.has(name));
    const txt = document.createElement('span');
    txt.innerHTML = `<strong>${esc(name)}</strong>`;
    row.appendChild(cb);
    row.appendChild(txt);
    container.appendChild(row);
  }
}

function collectToolAllowChecklist(container) {
  return Array.from(container.querySelectorAll('input[type="checkbox"]:checked')).map(cb => cb.value);
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
  // name -> source dir. These load only while the seat works under that dir, so
  // clodex's off list can't reach them: read-only, like a lower-layer off.
  const oos = new Map((opts.outOfScope || []).map((s) => [s.name, s.dir || null]));
  container.innerHTML = '';
  if (!names || !names.length) {
    container.innerHTML = '<span class="hint-text">No skills detected yet — they appear once the session has run a turn.</span>';
    return;
  }
  for (const name of names) {
    const eff = effective[name];
    const lowerOff = !!(eff && eff.value === 'off');
    const clodexOff = disabledSet.has(name);
    const outOfScope = oos.has(name);
    // Read-only when clodex's layer-4 write can't actually change it: a lower-
    // layer off we can't re-enable yet, a managed-policy lock, or a skill that
    // isn't loaded here at all.
    const readonly = skillsLocked || outOfScope || (lowerOff && !canReenable);
    const row = document.createElement('label');
    row.className = 'agent-check' + (readonly ? ' skill-readonly' : '');
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.value = name;
    cb.checked = !clodexOff && !lowerOff && !outOfScope;
    if (readonly) cb.disabled = true;
    const txt = document.createElement('span');
    let note = '';
    if (skillsLocked) note = ' <span class="skill-src">locked by policy</span>';
    else if (lowerOff) note = ` <span class="skill-src">off via ${esc(eff.source)} settings</span>`;
    else if (outOfScope) {
      const dir = oos.get(name);
      note = dir
        ? ` <span class="skill-src">only under ${esc(dir)}</span>`
        : ' <span class="skill-src">not loaded here</span>';
    }
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
  bundleSectionsOf, repaintBundleSections,
  renderExecChecklist, collectExecChecklist,
  renderIntentChecklist, collectIntentChecklist, intentRowChecked,
  renderPluginChecklist, collectPluginChecklist, defaultPluginTicks,
  renderBuiltinChecklist, collectBuiltinChecklist,
  renderInjectChecklist, collectInjectChecklist,
  renderToolChecklist, collectToolChecklist,
  renderToolAllowChecklist, collectToolAllowChecklist,
  renderSkillChecklist, collectSkillChecklist,
  setChecklistAll, wireBulkToggles,
  setPromptLibCache, setAgentLibCache, setSkillLibCache, setExecLibCache,
  setIntentCatalogCache,
  setPluginCatalogCache,
  getPluginCatalogCache,
  setClaudeToolsCache, setDefaultToolDenyCache,
  getPromptLibCache, getSkillLibCache, getDefaultToolDenyCache,
};
