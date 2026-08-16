// popovers/team-roles-popover.js — the team-management popover (T29 Layer A
// Slice 3, the milestone surface). Right-click a team's sidebar group header →
// build/edit its roles with ZERO hand-editing of team.json. A LOCAL editor like
// checklist-popovers: reads/writes the manifest through window.api.team* directly,
// bypassing popoverApi (the local-vs-peer data seam — a team manifest is
// host-local, never peer-fetched).
//
// lead + reviewer rows are READ-ONLY (operator-owned topology, C1): their
// DEFINITIONS can't be edited or renamed here — the mutators bounce that anyway,
// so we don't offer a control that only errors. What each one does grow is the
// decision that IS the operator's: which seat fills `lead` (t420), and whether
// the team has a `reviewer` at all (t421 — Remove, plus an add-it-back row when
// it is absent, which re-mints Clodex's own def, never a caller-supplied one).
// Ordinary roles get inline brief/prompt/template edit
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
  teamRoleRows, validateAddRole, buildSavePatch, reservedRoleNote, DISPATCH_VALUES, DEFAULT_DISPATCH,
  parseDuration, formatDuration, formatBlockedBy, preflightByRole,
  leadSeatCandidates, leadResolution,
  absentReservedRoles, reservedRemovalWarning, absentReservedNote, REMOVABLE_RESERVED_ROLE_KEYS,
} = require('../lib/team-roles');
const { anchorRect, makeDraggable, resetDrag } = require('../lib/popover-drag');

// `promptText` is the in-app text-input modal from renderer.js — window.prompt()
// is a no-op in Electron, so rename MUST route through it (threaded in as a dep,
// not reached as a global). `openSessionDialog` is renderer.js's openDialog: the
// "Create lead seat…" affordance routes to the EXISTING spawn path with the name
// and the team root prefilled rather than growing a second way to make a session.
function initTeamRolesPopover({ promptText, openSessionDialog } = {}) {
  const popover = document.getElementById('team-roles-popover');
  const nameEl = document.getElementById('team-roles-popover-name');
  const listEl = document.getElementById('team-roles-list');
  const addName = document.getElementById('team-roles-add-name');
  const addBrief = document.getElementById('team-roles-add-brief');
  const addPrompt = document.getElementById('team-roles-add-prompt');
  const addTemplate = document.getElementById('team-roles-add-template');
  const addDispatch = document.getElementById('team-roles-add-dispatch');
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
  // prompt, a "built-in role" badge, and a one-line why); ordinary rows read
  // as editable — an "Edit this role" caption + three hinted inputs +
  // Save/Rename/Remove (delegated below).
  // What this team's manifest names that resolves to nothing, per role. A
  // failed/absent preflight leaves this empty and the rows render exactly as they
  // did before it existed — the checklist is additive, never a gate on the editor.
  let preflight = new Map();
  async function loadPreflight(name) {
    let res;
    try { res = await window.api.teamPreflight(name); } catch { res = null; }
    preflight = preflightByRole(res && res.ok ? res.findings : []);
  }

  // Who could be this team's lead, and does the current pointer resolve (t420).
  // Refreshed alongside the manifest, never cached across opens: a seat started
  // since the last open must appear, and a status line claiming a seat is live
  // after it exited is the one thing this row exists to stop being wrong about.
  //
  // Two DIFFERENT listings on purpose. `leadSessions` is the workspace's LIVE
  // rows, passed WHOLE to both helpers: `type` is what separates an eligible seat
  // from a live bash session, and `team` carries the engine's own membership
  // answer (worktree widening + deepest-root-wins). `leadKnown` is every reserved
  // name, live or persisted, across workspaces: it is what separates a stopped
  // lead (restarts by name — fine) from one that was never created (resolves to
  // nothing forever). Folding them into one listing would make those two states
  // indistinguishable, which is the bug this row fixes.
  //
  // Note the scopes differ — live rows are workspace-scoped, known names are
  // global — which is why the `stopped` note says "in this window".
  let leadSessions = [];
  let leadKnown = [];
  // The open team's root, kept for the "Create lead seat…" prefill — the dialog
  // wants a cwd, and the manifest is the only place that knows it.
  let currentRoot = '';
  async function loadLeadSeats() {
    let live;
    try { live = await window.api.listSessions(); } catch { live = null; }
    leadSessions = Array.isArray(live) ? live : [];
    let known;
    try { known = await window.api.reservedSessionNames(); } catch { known = null; }
    leadKnown = known && known.ok && Array.isArray(known.names) ? known.names : [];
  }

  // The lead ROLE is locked; the SEAT filling it is not. Built as DOM nodes, not
  // innerHTML: `lead` and the session names come from an agent-writable team.json
  // and from live session records, and every one of them lands here as a TEXT or
  // .value PROPERTY assignment. NEVER give this input a value="…" attribute — the
  // file header's rule, and the reason this whole block is imperative.
  function buildLeadSeatBlock(manifest) {
    const box = document.createElement('div');
    box.className = 'team-lead-seat';

    // Eligibility keys off the team NAME on each row (session-manager already
    // resolved it through cwdInProject), not off the root path.
    const teamName = (manifest && manifest.name) || '';
    const candidates = leadSeatCandidates(leadSessions, teamName);
    // The ROWS, not a name list: leadResolution needs the type to tell a live
    // agent from a live bash session, and passing names is what let a bash lead
    // render as "running now".
    const res = leadResolution(manifest && manifest.lead, { sessions: leadSessions, known: leadKnown });

    // Current state FIRST, in words: the crypto-app team must read as broken here
    // rather than as configured. `state` drives the colour; the note is the fix.
    const status = document.createElement('div');
    status.className = `team-lead-status ${res.state}`;
    const who = document.createElement('span');
    who.className = 'team-lead-who';
    who.textContent = res.name ? `seat: ${res.name}` : 'seat: (none)';
    const note = document.createElement('span');
    note.className = 'team-lead-note';
    note.textContent = res.note;
    status.appendChild(who);
    status.appendChild(note);
    box.appendChild(status);

    const field = document.createElement('label');
    field.className = 'team-role-field';
    const label = document.createElement('span');
    label.textContent = 'seat';
    const input = document.createElement('input');
    input.type = 'text';
    input.dataset.f = 'lead-seat';
    input.placeholder = 'seat name';
    input.value = res.name; // PROPERTY, never an attribute (agent-writable).
    field.appendChild(label);
    field.appendChild(input);
    box.appendChild(field);

    if (candidates.length) {
      const pick = document.createElement('label');
      pick.className = 'team-role-field';
      const pickLabel = document.createElement('span');
      pickLabel.textContent = 'pick';
      const sel = document.createElement('select');
      sel.dataset.f = 'lead-pick';
      const none = document.createElement('option');
      none.value = ''; none.textContent = '(choose a running seat)';
      sel.appendChild(none);
      for (const n of candidates) {
        const opt = document.createElement('option');
        opt.value = n; opt.textContent = n; // both by property
        sel.appendChild(opt);
      }
      // The picker fills the FIELD rather than writing straight through: the
      // field is the thing Set reads, and it must stay the single value the
      // operator confirms — a picker that wrote on change would also have to be
      // undoable, and there is nothing to undo a silent write with.
      sel.addEventListener('change', () => {
        if (sel.value) input.value = sel.value;
      });
      pick.appendChild(pickLabel);
      pick.appendChild(sel);
      box.appendChild(pick);
    } else {
      // WHY there is nothing to pick, not merely that there is nothing. A team
      // root holding only bash sessions is the measured case (crypto-app), and
      // an empty picker there reads as a broken popover instead of as the
      // explanation it is.
      const empty = document.createElement('div');
      empty.className = 'team-lead-empty';
      empty.textContent = 'No agent session of this team is running in this window. '
        + 'Bash sessions can’t be a lead — they have no messaging registry, so nothing could reach them. '
        + 'Create a lead seat, or type the name of a stopped one.';
      box.appendChild(empty);
    }

    const actions = document.createElement('div');
    actions.className = 'team-role-actions';
    const setBtn = document.createElement('button');
    setBtn.type = 'button';
    setBtn.dataset.act = 'set-lead';
    setBtn.textContent = 'Set lead';
    const createBtn = document.createElement('button');
    createBtn.type = 'button';
    createBtn.className = 'secondary';
    createBtn.dataset.act = 'create-lead';
    createBtn.textContent = 'Create lead seat…';
    actions.appendChild(setBtn);
    actions.appendChild(createBtn);
    box.appendChild(actions);

    const hint = document.createElement('div');
    hint.className = 'team-lead-hint';
    // Says the thing the UI would otherwise imply wrongly: this moves a POINTER.
    // The new seat starts with none of the old lead's context, and no state is
    // transferred — which is also why it is safe and reversible.
    hint.textContent = 'Changing this re-points the team at another seat. '
      + 'Nothing is handed over — the new lead starts fresh, and you can point it back at any time.';
    box.appendChild(hint);

    return box;
  }

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
          `<span class="team-role-badge" title="Clodex defines this role so a team always has one. Which seat fills it is yours to decide.">built-in role</span></div>` +
          `<div class="team-role-lock-note">${esc(reservedRoleNote(row.key))}</div>` +
          `<div class="team-role-ro-field"><span>brief</span><span class="ro-val">${esc(row.brief || '—')}</span></div>` +
          `<div class="team-role-ro-field"><span>prompt</span><span class="ro-val">${esc(row.prompt || '—')}</span></div>`;
        // The lead ROLE stays locked; which SEAT fills it does not (t420).
        if (row.key === 'lead') el.appendChild(buildLeadSeatBlock(manifest));
        // A reserved role's DEFINITION stays locked, but whether the team has one
        // at all is the operator's call (t421) — `reviewer` only, and only from
        // here: the backend takes an operator opt-in this channel passes and the
        // `[agent:team role-rm]` intent does not. `lead` has no such row, because
        // a team.json without it fails to load outright.
        if (REMOVABLE_RESERVED_ROLE_KEYS.has(row.key)) {
          const actions = document.createElement('div');
          actions.className = 'team-role-actions';
          const rm = document.createElement('button');
          rm.type = 'button';
          rm.className = 'secondary';
          rm.dataset.act = 'remove';
          rm.textContent = 'Remove';
          rm.title = 'Take this built-in role off the team. You can add it back here.';
          actions.appendChild(rm);
          el.appendChild(actions);
        }
      } else {
        // SECURITY: brief/prompt/template are agent-writable unconstrained strings
        // (only role KEYS are charset-gated). NEVER interpolate them into a
        // value="…" attribute — a `" onfocus="…` payload would break out of the
        // attribute and execute in this nodeIntegration renderer. Build the inputs
        // WITHOUT value attrs, then assign each `.value` by property below (a
        // property assignment can't escape an attribute context). Placeholders +
        // the caption are fixed strings — they signal this row is editable (C3).
        el.innerHTML =
          `<div class="team-role-head"><span class="team-role-key">${esc(row.key)}</span></div>` +
          `<div class="team-role-editcap">Edit this role</div>` +
          `<label class="team-role-field"><span>brief</span><input type="text" data-f="brief" placeholder="one line: what this role is for"></label>` +
          `<label class="team-role-field" title="Sets how this teammate behaves"><span>prompt</span><select data-f="prompt"></select></label>` +
          `<label class="team-role-field"><span>template</span><input type="text" data-f="template" placeholder="optional: spawn template name"></label>` +
          `<label class="team-role-field" title="What dispatching a ticket to this role does"><span>dispatch</span>` +
          `<select data-f="dispatch">` +
          `<option value="standing">standing — the live seat gets the spec</option>` +
          `<option value="worktree">worktree — one-shot seat, own branch + checkout</option>` +
          `</select></label>` +
          `<div class="team-role-actions">` +
          `<button type="button" data-act="save">Save</button>` +
          `<button type="button" data-act="rename" class="secondary">Rename</button>` +
          `<button type="button" data-act="remove" class="secondary">Remove</button>` +
          `</div>`;
        el.querySelector('input[data-f="brief"]').value = row.brief;
        // Prompt is a picker (must be a library prompt name — free text just
        // fails at spawn time; matches the Add Role form). Options come from the
        // same rail-filtered list; a stored prompt missing from the library still
        // has to display, so it's appended as a marked option rather than
        // silently blanking. Values/labels set by PROPERTY (agent-writable).
        const sel = el.querySelector('select[data-f="prompt"]');
        {
          const none = document.createElement('option');
          none.value = ''; none.textContent = '(no prompt)';
          sel.appendChild(none);
          for (const p of promptNames) {
            const opt = document.createElement('option');
            opt.value = p; opt.textContent = p;
            sel.appendChild(opt);
          }
          if (row.prompt && !promptNames.includes(row.prompt)) {
            const missing = document.createElement('option');
            missing.value = row.prompt;
            // THREE distinct facts, three messages. They have different fixes, and
            // one wording for all of them sent the operator hunting for a file that
            // was on disk the whole time. All set by PROPERTY (agent-writable).
            if (!promptsListingOk) {
              // The listing failed — an empty list is indistinguishable from a
              // genuinely empty library by count, so accuse the prompt of nothing.
              missing.textContent = row.prompt;
              missing.title = 'library listing unavailable';
            } else if (allPromptNames.includes(row.prompt)) {
              // Present on disk, but not an append-rail prompt: the picker won't
              // offer it and the seat won't compose it. The fix is `rail: append`
              // in its front matter, not writing the file.
              missing.textContent = `${row.prompt} (not an append-rail prompt)`;
              missing.title = 'this prompt exists but does not declare "rail: append", so it can\'t compose onto a role';
            } else {
              missing.textContent = `${row.prompt} (missing from library)`;
              missing.title = 'no system prompt by this name is installed';
            }
            sel.appendChild(missing);
          }
          sel.value = row.prompt;
        }
        el.querySelector('input[data-f="template"]').value = row.template;
        // A hand-edited team.json can hold a value this picker has no option for.
        // Fall back to the default rather than leaving the select blank, which
        // would send '' and have buildSavePatch drop the key silently.
        const disp = el.querySelector('select[data-f="dispatch"]');
        disp.value = DISPATCH_VALUES.includes(row.dispatch) ? row.dispatch : DEFAULT_DISPATCH;
      }
      // The preflight checklist, on BOTH arms: lead and reviewer are read-only
      // topology but they name prompts and templates like any other role, and a
      // reviewer with no prompt installed is the exact failure the spawn-time
      // warn already reports — the operator must be able to see it here too.
      //
      // Appended after the row's own markup rather than folded into either
      // innerHTML: `message` and `ref` come from an agent-writable team.json and
      // from template JSON, and this keeps every one of them a TEXT assignment
      // that cannot reach an attribute context in this nodeIntegration renderer.
      const owed = preflight.get(row.key) || [];
      if (owed.length) {
        const box = document.createElement('div');
        box.className = 'team-role-preflight';
        for (const f of owed) {
          const line = document.createElement('div');
          line.className = `team-role-preflight-line ${f.level === 'warn' ? 'warn' : 'note'}`;
          const tag = document.createElement('span');
          tag.className = 'team-role-preflight-kind';
          // The kind, not the level: "prompt"/"exec" is what the operator acts
          // on. Level is carried by the colour and by the leading mark.
          tag.textContent = `${f.level === 'warn' ? '!' : '·'} ${f.kind}`;
          const txt = document.createElement('span');
          txt.textContent = f.message;
          line.appendChild(tag);
          line.appendChild(txt);
          box.appendChild(line);
        }
        el.appendChild(box);
      }
      listEl.appendChild(el);
    }
    // A removable reserved role the team does NOT have still gets a row — the
    // orphan state has no other symptom until a ticket reaches the review step
    // and escalates, and a row that simply vanished is how it stayed invisible.
    // Built as nodes with fixed strings only: nothing here is agent-writable
    // (the key comes from a module constant, not from team.json).
    for (const key of absentReservedRoles(manifest)) {
      const el = document.createElement('div');
      el.className = 'team-role-row read-only absent';
      el.dataset.role = key;
      const head = document.createElement('div');
      head.className = 'team-role-head';
      const k = document.createElement('span');
      k.className = 'team-role-key';
      k.textContent = key;
      const badge = document.createElement('span');
      badge.className = 'team-role-badge';
      badge.textContent = 'not on this team';
      head.appendChild(k);
      head.appendChild(badge);
      el.appendChild(head);
      const note = document.createElement('div');
      note.className = 'team-role-lock-note';
      note.textContent = absentReservedNote(key);
      el.appendChild(note);
      const actions = document.createElement('div');
      actions.className = 'team-role-actions';
      const add = document.createElement('button');
      add.type = 'button';
      add.dataset.act = 'readd';
      add.textContent = 'Add it back';
      // Says what it writes. The def is Clodex's, not the operator's, and not
      // whatever a previous team.json held — that is the property that makes
      // remove-then-re-add safe to offer.
      add.title = "Adds Clodex's built-in definition of this role back to the team.";
      actions.appendChild(add);
      el.appendChild(actions);
      listEl.appendChild(el);
    }
  }

  async function refresh(teamName) {
    const res = await window.api.teamGet(teamName);
    if (!res || !res.ok) { setStatus(res && res.error ? res.error : 'team not found', true); return false; }
    nameEl.textContent = res.team.name;
    currentRoot = res.team.root || '';
    // BEFORE renderRows, and on every refresh rather than only on open: a role
    // whose prompt was just re-pointed by a Save must re-badge against the new
    // name, and a stale checklist accusing the previous value is worse than none.
    await loadPreflight(res.team.name);
    // Before renderRows, same reason as the preflight above: the lead row's
    // status line is rendered FROM these listings, so a stale one would state a
    // resolution the manifest no longer has.
    await loadLeadSeats();
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
  // New Session dialog's join flow uses. The list is cached module-side so
  // renderRows (also hit on post-mutation refresh) can build per-row pickers
  // without re-fetching.
  let promptNames = [];
  // Every system prompt on disk, rail or not — the second fact renderRows needs
  // to tell "not installed" from "installed but off the append rail".
  let allPromptNames = [];
  // Did the LAST prompts listing actually succeed? A transient IPC reject/timeout
  // (res null) or a handler error (res.ok === false) both collapse to an empty
  // list — indistinguishable from "the library is genuinely empty" by count alone.
  // renderRows uses this to avoid accusing a present-but-unlistable stored prompt
  // of being "missing from library". No retry loop — one shot per open/refresh.
  let promptsListingOk = true;
  async function populatePromptOptions() {
    let res;
    try { res = await window.api.teamRolePrompts(); } catch { res = null; }
    promptsListingOk = !!(res && res.ok);
    const prompts = (res && res.prompts) || [];
    promptNames = prompts;
    allPromptNames = (res && res.all) || [];
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
    // Anchor just below the header, clamped to the viewport. anchorRect absorbs
    // the anchor-less open the Teams menu (t288) performs.
    const r = anchorRect(anchorEl);
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
    if (act === 'set-lead') {
      const inp = rowEl.querySelector('input[data-f="lead-seat"]');
      const seat = ((inp && inp.value) || '').trim();
      if (!seat) { setStatus('enter or pick a seat name for the lead', true); return; }
      // NOT gated on the seat existing: a stopped lead is a legitimate value and
      // the backend accepts it. The status line on the re-rendered row is what
      // reports whether it resolves — a refusal here would block the case the
      // field is explicitly meant to accept.
      const res = await window.api.teamSetLead(name, seat);
      await afterMutation(res, `lead seat set to "${seat}"`);
      return;
    }
    if (act === 'create-lead') {
      const inp = rowEl.querySelector('input[data-f="lead-seat"]');
      const seat = ((inp && inp.value) || '').trim();
      if (!openSessionDialog) { setStatus('the new-session dialog is unavailable here', true); return; }
      // The manifest is NOT written here: the dialog can be cancelled, and a
      // pointer written for a seat that was never created is exactly the orphan
      // state this row exists to fix. Set the pointer after the seat exists.
      const teamRoot = currentRoot;
      closeTeamRolesPopover();
      // Un-awaited on purpose (the popover is already closed and has no status
      // line left to report into), so the rejection has to be absorbed here:
      // openDialog makes several awaited IPC calls, and one rejecting would
      // otherwise be an unhandled rejection with nothing left to catch it.
      Promise.resolve(openSessionDialog({ name: seat || `${name}-lead`, type: 'claude', cwd: teamRoot || undefined }))
        .catch(() => {});
      return;
    }
    if (act === 'save') {
      const val = (f) => {
        // prompt is a <select>, the rest are <input>s — match on data-f alone.
        const inp = rowEl.querySelector(`[data-f="${f}"]`);
        return inp ? inp.value : '';
      };
      // buildSavePatch sends brief/prompt (blank clears) but OMITS a blank
      // template — backend setRole throws NAME_RE on '' (no clear-template in v1).
      const patch = buildSavePatch({
        brief: val('brief'), prompt: val('prompt'), template: val('template'), dispatch: val('dispatch'),
      });
      const res = await window.api.teamSetRole(name, role, patch);
      await afterMutation(res, `role "${role}" saved`);
    } else if (act === 'rename') {
      const to = ((await promptText(`Rename role "${role}" to:`, role)) || '').trim();
      if (!to || to === role) return;
      const res = await window.api.teamRenameRole(name, role, to);
      await afterMutation(res, `role "${role}" renamed to "${to}"`);
    } else if (act === 'remove') {
      // A reserved role's removal names what is LOST, not just what is removed:
      // it is one click, it is destructive, and its only other symptom arrives a
      // ticket later at the review step. Ordinary roles keep the short confirm.
      const warn = REMOVABLE_RESERVED_ROLE_KEYS.has(role)
        ? `\n\n${reservedRemovalWarning(role)}\n\nYou can add it back from this popover.`
        : '';
      if (!window.confirm(`Remove role "${role}" from team "${name}"?${warn}`)) return;
      const res = await window.api.teamRemoveRole(name, role);
      await afterMutation(res, `role "${role}" removed`);
    } else if (act === 'readd') {
      // Latched before the await: a second click while the first is in flight
      // finds the role already minted, falls past the re-mint branch (gated on
      // absence) into the already-exists arm, and compares `{}` against the stock
      // def — surfacing "already exists with a different definition" for an
      // action that in fact succeeded.
      if (btn.disabled) return;
      btn.disabled = true;
      // `{}` because the backend IGNORES the def when re-minting a reserved key
      // and writes the stock one — sending a def here would suggest this surface
      // authors it, which is exactly the belief that makes the guard rot.
      let res;
      try {
        res = await window.api.teamAddRole(name, role, {});
      } finally {
        // The row is rebuilt by afterMutation on success; on a failure the button
        // survives, and a stuck-disabled control would strand the only way back.
        btn.disabled = false;
      }
      await afterMutation(res, `role "${role}" added back`);
    }
  });

  addBtn.addEventListener('click', async () => {
    const name = teamName();
    if (!name) return;
    const v = validateAddRole({ name: addName.value, template: addTemplate.value });
    if (!v.ok) { setStatus(v.error, true); return; }
    // Omit empty fields rather than writing literal nulls into the def (keeps the
    // manifest clean; the schema treats absent === null anyway).
    const def = {};
    if (addPrompt.value) def.prompt = addPrompt.value;
    if (v.template) def.template = v.template;
    const brief = addBrief.value.trim();
    if (brief) def.brief = brief;
    // Only the non-default is written: absent already reads as `standing`, so an
    // explicit one would put a value on disk that means exactly what its absence
    // does (the same rule migrateRoles follows).
    if (addDispatch.value === 'worktree') def.dispatch = 'worktree';
    const res = await window.api.teamAddRole(name, v.name, def);
    if (res && res.ok) {
      addName.value = ''; addBrief.value = ''; addTemplate.value = ''; addPrompt.value = '';
      addDispatch.value = DEFAULT_DISPATCH;
    }
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

  // Enter-to-submit on the single-line text inputs: pressing Enter fires the same
  // paired button as clicking it (Escape still closes — handled below, untouched).
  // SECURITY: this only calls an existing handler via the button's .click() — no
  // innerHTML, no attribute writes, nothing agent-writable touched. Same idiom as
  // the sandbox New-Box field (renderer.js) and the workbench editor. Multiline
  // inputs would guard on !e.shiftKey; these are all single-line, so plain Enter.
  const submitOnEnter = (input, button) => {
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); button.click(); }
    });
  };
  submitOnEnter(addName, addBtn);
  submitOnEnter(addBrief, addBtn);
  submitOnEnter(addTemplate, addBtn);
  submitOnEnter(watchdogInput, watchdogSet);
  // Per-row edit inputs (brief/template) are regenerated by renderRows, so wire
  // Enter through delegation on the list — same shape as the click delegation
  // above. Enter in a row input fires that row's Save button. The prompt <select>
  // is excluded (Enter there is native option-commit, not a submit).
  listEl.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || e.isComposing) return;
    const inp = e.target.closest('input[data-f]');
    if (!inp) return;
    const rowEl = inp.closest('.team-role-row');
    // The lead row has no Save — its input pairs with Set lead. Matched on the
    // field rather than on the row's role so a row that grows both buttons later
    // still fires the one belonging to the focused input.
    const act = inp.dataset.f === 'lead-seat' ? 'set-lead' : 'save';
    const btn = rowEl && rowEl.querySelector(`button[data-act="${act}"]`);
    if (!btn) return;
    e.preventDefault();
    btn.click();
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
