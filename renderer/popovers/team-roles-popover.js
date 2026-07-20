// popovers/team-roles-popover.js — the team-management popover (T29 Layer A
// Slice 3, the milestone surface). Right-click a team's sidebar group header →
// build/edit its roles with ZERO hand-editing of team.json. A LOCAL editor like
// checklist-popovers: reads/writes the manifest through window.api.team* directly,
// bypassing popoverApi (the local-vs-peer data seam — a team manifest is
// host-local, never peer-fetched).
//
// lead + reviewer rows are READ-ONLY (operator-owned topology, C1): shown with a
// badge, no controls — the mutators bounce them anyway, so we don't offer a
// control that only errors. Ordinary roles get inline brief/prompt/template edit
// (→ teamSetRole), Rename (→ teamRenameRole), Remove (→ teamRemoveRole). A
// remove/rename the backend FAIL-CLOSES (C5: a live/persisted seat or an open
// ticket still encodes the role) surfaces the blocking names INLINE — no
// force/migrate in v1 (spec Q3). Add-role + the team stall-watchdog round it out.
// After every successful mutation we re-fetch teamGet so the popover is the single
// source of truth (the mutators also return the reloaded manifest).
//
// DOM-bound, so no unit tests — the pure row-model/validator/formatter helpers in
// lib/team-roles.js are tested instead; wire fidelity is the guarantee here.

const { esc } = require('../lib/format');
const {
  teamRoleRows, validateAddRole, buildSavePatch, reservedRoleNote,
  parseDuration, formatDuration, formatBlockedBy,
} = require('../lib/team-roles');
const { makeDraggable, resetDrag } = require('../lib/popover-drag');

// `promptText` is the in-app text-input modal from renderer.js — window.prompt()
// is a no-op in Electron, so rename MUST route through it (threaded in as a dep,
// not reached as a global).
function initTeamRolesPopover({ promptText } = {}) {
  const popover = document.getElementById('team-roles-popover');
  const nameEl = document.getElementById('team-roles-popover-name');
  const listEl = document.getElementById('team-roles-list');
  const addName = document.getElementById('team-roles-add-name');
  const addBrief = document.getElementById('team-roles-add-brief');
  const addPrompt = document.getElementById('team-roles-add-prompt');
  const addTemplate = document.getElementById('team-roles-add-template');
  const addBtn = document.getElementById('team-roles-add-btn');
  const watchdogInput = document.getElementById('team-roles-watchdog-ms');
  const watchdogSet = document.getElementById('team-roles-watchdog-set');
  const watchdogClear = document.getElementById('team-roles-watchdog-clear');
  const statusEl = document.getElementById('team-roles-status');
  const helpBtn = document.getElementById('team-roles-help-btn');
  const helpPanel = document.getElementById('team-roles-help');

  const setStatus = (msg, warn = false) => {
    statusEl.textContent = msg || '';
    statusEl.classList.toggle('warn', !!(warn && msg));
  };

  function closeTeamRolesPopover() {
    popover.classList.add('hidden');
    popover.dataset.name = '';
  }

  // Render one row per role. Reserved rows TEACH their lock (read-only brief +
  // prompt, a "managed by Clodex" badge, and a one-line why); ordinary rows read
  // as editable — an "Edit this role" caption + three hinted inputs +
  // Save/Rename/Remove (delegated below).
  function renderRows(manifest) {
    listEl.innerHTML = '';
    for (const row of teamRoleRows(manifest)) {
      const el = document.createElement('div');
      el.className = 'team-role-row';
      el.dataset.role = row.key;
      if (row.readOnly) {
        // Reserved (lead/reviewer): explained-and-locked. brief + prompt are shown
        // read-only. SECURITY: these are agent-writable strings — rendered as
        // ESCAPED TEXT between tags (never into an attribute), same rule as the
        // editable branch. The lock note is a fixed, newcomer-facing string.
        el.classList.add('read-only');
        el.innerHTML =
          `<div class="team-role-head"><span class="team-role-key">${esc(row.key)}</span>` +
          `<span class="team-role-inst">${esc(row.instantiate)}</span>` +
          `<span class="team-role-badge" title="Managed by Clodex — you don't need to change anything here">managed by Clodex</span></div>` +
          `<div class="team-role-lock-note">${esc(reservedRoleNote(row.key))}</div>` +
          `<div class="team-role-ro-field"><span>brief</span><span class="ro-val">${esc(row.brief || '—')}</span></div>` +
          `<div class="team-role-ro-field"><span>prompt</span><span class="ro-val">${esc(row.prompt || '—')}</span></div>`;
      } else {
        // SECURITY: brief/prompt/template are agent-writable unconstrained strings
        // (only role KEYS are charset-gated). NEVER interpolate them into a
        // value="…" attribute — a `" onfocus="…` payload would break out of the
        // attribute and execute in this nodeIntegration renderer. Build the inputs
        // WITHOUT value attrs, then assign each `.value` by property below (a
        // property assignment can't escape an attribute context). Placeholders +
        // the caption are fixed strings — they signal this row is editable (C3).
        el.innerHTML =
          `<div class="team-role-head"><span class="team-role-key">${esc(row.key)}</span>` +
          `<span class="team-role-inst">${esc(row.instantiate)}</span></div>` +
          `<div class="team-role-editcap">Edit this role</div>` +
          `<label class="team-role-field"><span>brief</span><input type="text" data-f="brief" placeholder="one line: what this role is for"></label>` +
          `<label class="team-role-field"><span>prompt</span><input type="text" data-f="prompt" placeholder="system-prompt name from the library, sets how this teammate behaves"></label>` +
          `<label class="team-role-field"><span>template</span><input type="text" data-f="template" placeholder="optional: spawn template name"></label>` +
          `<div class="team-role-actions">` +
          `<button type="button" data-act="save">Save</button>` +
          `<button type="button" data-act="rename" class="secondary">Rename</button>` +
          `<button type="button" data-act="remove" class="secondary">Remove</button>` +
          `</div>`;
        el.querySelector('input[data-f="brief"]').value = row.brief;
        el.querySelector('input[data-f="prompt"]').value = row.prompt;
        el.querySelector('input[data-f="template"]').value = row.template;
      }
      listEl.appendChild(el);
    }
  }

  async function refresh(teamName) {
    const res = await window.api.teamGet(teamName);
    if (!res || !res.ok) { setStatus(res && res.error ? res.error : 'team not found', true); return false; }
    nameEl.textContent = res.team.name;
    renderRows(res.team);
    // Show the stored (read-clamped) watchdog back in friendly units, not raw ms.
    watchdogInput.value = res.team.watchdogMs != null ? formatDuration(res.team.watchdogMs) : '';
    return true;
  }

  // The current team name the popover is bound to (from the group header).
  const teamName = () => popover.dataset.name || null;

  // Re-fetch + re-render after a mutation, keeping any error visible.
  async function afterMutation(res, okMsg) {
    if (!res || !res.ok) {
      const block = res && res.blockedBy ? formatBlockedBy(res.blockedBy) : '';
      setStatus(block ? `can't: ${block} — reassign/retire them first` : (res && res.error) || 'update failed', true);
      // A fail-closed block still means no write happened; leave the rows as-is.
      return;
    }
    setStatus(okMsg || '');
    await refresh(teamName());
  }

  // Populate the add-role prompt picker from the same rail-filtered source the
  // New Session dialog's join flow uses.
  async function populatePromptOptions() {
    let res;
    try { res = await window.api.teamRolePrompts(); } catch { res = null; }
    const prompts = (res && res.prompts) || [];
    addPrompt.innerHTML = '<option value="">(no prompt)</option>';
    for (const p of prompts) {
      const opt = document.createElement('option');
      opt.value = p; opt.textContent = p;
      addPrompt.appendChild(opt);
    }
  }

  async function openTeamRolesPopover(name, anchorEl) {
    setStatus('');
    helpPanel.classList.add('hidden'); // help starts collapsed on every open
    resetDrag(popover);                // a fresh open re-anchors; drop any drag offset
    await populatePromptOptions();
    addName.value = ''; addBrief.value = ''; addTemplate.value = ''; addPrompt.value = '';
    popover.dataset.name = name;
    const ok = await refresh(name);
    if (!ok) { popover.dataset.name = ''; return; } // not a team / unreadable → show nothing
    popover.classList.remove('hidden');
    // Anchor just below the header, clamped to the viewport.
    const r = anchorEl.getBoundingClientRect();
    const w = popover.offsetWidth;
    popover.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - w - 8))}px`;
    const wantTop = r.bottom + 6;
    const maxTop = Math.max(8, window.innerHeight - popover.offsetHeight - 8);
    popover.style.top = `${Math.min(wantTop, maxTop)}px`;
    popover.style.bottom = 'auto';
  }

  // Per-role actions (Save/Rename/Remove) via event delegation on the list.
  listEl.addEventListener('click', async (e) => {
    const btn = e.target.closest('button[data-act]');
    if (!btn) return;
    const rowEl = btn.closest('.team-role-row');
    if (!rowEl) return;
    const role = rowEl.dataset.role;
    const name = teamName();
    if (!name || !role) return;
    const act = btn.dataset.act;
    if (act === 'save') {
      const val = (f) => {
        const inp = rowEl.querySelector(`input[data-f="${f}"]`);
        return inp ? inp.value : '';
      };
      // buildSavePatch sends brief/prompt (blank clears) but OMITS a blank
      // template — backend setRole throws NAME_RE on '' (no clear-template in v1).
      const patch = buildSavePatch({ brief: val('brief'), prompt: val('prompt'), template: val('template') });
      const res = await window.api.teamSetRole(name, role, patch);
      await afterMutation(res, `role "${role}" saved`);
    } else if (act === 'rename') {
      const to = ((await promptText(`Rename role "${role}" to:`, role)) || '').trim();
      if (!to || to === role) return;
      const res = await window.api.teamRenameRole(name, role, to);
      await afterMutation(res, `role "${role}" renamed to "${to}"`);
    } else if (act === 'remove') {
      if (!window.confirm(`Remove role "${role}" from team "${name}"?`)) return;
      const res = await window.api.teamRemoveRole(name, role);
      await afterMutation(res, `role "${role}" removed`);
    }
  });

  addBtn.addEventListener('click', async () => {
    const name = teamName();
    if (!name) return;
    const v = validateAddRole({ name: addName.value, template: addTemplate.value });
    if (!v.ok) { setStatus(v.error, true); return; }
    // Omit empty fields rather than writing literal nulls into the def (keeps the
    // manifest clean; the schema treats absent === null anyway).
    const def = { instantiate: 'session' };
    if (addPrompt.value) def.prompt = addPrompt.value;
    if (v.template) def.template = v.template;
    const brief = addBrief.value.trim();
    if (brief) def.brief = brief;
    const res = await window.api.teamAddRole(name, v.name, def);
    if (res && res.ok) { addName.value = ''; addBrief.value = ''; addTemplate.value = ''; addPrompt.value = ''; }
    await afterMutation(res, `role "${v.name}" added`);
  });

  watchdogSet.addEventListener('click', async () => {
    const name = teamName();
    if (!name) return;
    // MF-1 (Slice-4 review): every hint promises "blank = default", so blank+Set
    // must BE Clear — not a parse error contradicting the hint the user just read.
    if (!watchdogInput.value.trim()) {
      const res = await window.api.teamSetWatchdog(name, null);
      await afterMutation(res, 'watchdog cleared (back to default)');
      return;
    }
    // Friendly units: "30m", "2h", "90s", or a bare number (minutes). parseDuration
    // gives the ms the backend wants; the raw-ms field is gone.
    const parsed = parseDuration(watchdogInput.value);
    if (!parsed.ok) { setStatus(parsed.error, true); return; }
    const ms = parsed.ms;
    const res = await window.api.teamSetWatchdog(name, ms);
    // watchdogMs is consume-clamped into [5min, 7d] at read (loadManifest), so the
    // reloaded value can differ from what was typed — say so, in friendly units,
    // rather than silently reporting a different number.
    const applied = res && res.ok ? res.team.watchdogMs : ms;
    const clamped = res && res.ok && applied !== ms ? ' (clamped to the 5min–7d range)' : '';
    await afterMutation(res, `watchdog set to ${formatDuration(applied)}${clamped}`);
  });

  watchdogClear.addEventListener('click', async () => {
    const name = teamName();
    if (!name) return;
    const res = await window.api.teamSetWatchdog(name, null);
    await afterMutation(res, 'watchdog cleared (back to default)');
  });

  // "?" help toggle. The reusable pattern: a `data-help` panel in the popover +
  // this one-line toggle; other input popovers can adopt it later (wired here
  // only for now, per the slice's scope).
  helpBtn.addEventListener('click', () => helpPanel.classList.toggle('hidden'));

  // Draggable by its title bar (shared helper). resetDrag on every open keeps the
  // anchor positioning authoritative.
  makeDraggable(popover);

  document.getElementById('team-roles-popover-close').addEventListener('click', closeTeamRolesPopover);
  document.getElementById('team-roles-popover-done').addEventListener('click', closeTeamRolesPopover);
  document.addEventListener('mousedown', (e) => {
    if (popover.classList.contains('hidden')) return;
    if (popover.contains(e.target)) return;
    closeTeamRolesPopover();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !popover.classList.contains('hidden')) closeTeamRolesPopover();
  });

  return { openTeamRolesPopover };
}

module.exports = { initTeamRolesPopover };
