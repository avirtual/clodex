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
  teamStage, roleSummaries, absentStockRoles, absentStockNote, offerDispatchLine, fieldReveal,
  reconcileReveal, clearableFields,
  reservedRemovalWarning, REMOVABLE_RESERVED_ROLE_KEYS,
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
  const addCwd = document.getElementById('team-roles-add-cwd');
  const addDispatch = document.getElementById('team-roles-add-dispatch');
  const addBtn = document.getElementById('team-roles-add-btn');
  // B1: the Add Role controls live behind a disclosure now. The section wrapper
  // is still what `setup` hides; the PANEL is what the toggle opens, so the two
  // gates stay independent — a stage change must not silently open the form.
  const addToggle = document.getElementById('team-roles-newrole-toggle');
  const addPanel = document.getElementById('team-roles-newrole-panel');
  const addCancel = document.getElementById('team-roles-newrole-cancel');
  const addDispatchHelp = document.getElementById('team-roles-dispatch-help');
  // The two whole sections `setup` hides. Wrappers rather than per-control
  // toggles: the subhead and hint belong to the section, and hiding the inputs
  // alone would leave two headings standing over nothing.
  const addSection = document.getElementById('team-roles-add-section');
  const watchdogSection = document.getElementById('team-roles-watchdog-section');
  const watchdogInput = document.getElementById('team-roles-watchdog-ms');
  const watchdogSet = document.getElementById('team-roles-watchdog-set');
  const watchdogClear = document.getElementById('team-roles-watchdog-clear');
  const statusEl = document.getElementById('team-roles-status');
  const helpBtn = document.getElementById('team-roles-help-btn');
  const settingsBtn = document.getElementById('team-roles-settings-btn');
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

  // What each dispatch mode DOES, one line each. Shown as the segment's `title`
  // and as the Add Role helper text — never as a visible option label, which is
  // what made the old select a sentence wide in a narrow popover.
  // Which stale fields may offer a Clear, derived from buildSavePatch rather than
  // listed here — a hardcoded list would drift the moment the backend grows
  // clear-template semantics, in the direction of promising one it cannot keep.
  const CLEARABLE = clearableFields();

  const DISPATCH_HELP = {
    standing: 'standing — the live seat holding this role gets the spec.',
    spawn: 'spawn — a one-shot seat in the shared checkout, no branch of its own.',
    worktree: 'worktree — a one-shot seat on its own branch, in its own checkout.',
  };

  // B4: the dispatch picker as a segmented control, built from NATIVE radios
  // rather than role="radio" divs. The keyboard and ARIA behaviour REVISION 1
  // requires — arrow keys moving between segments, Space/Enter selecting, one
  // tab stop for the group, checked state exposed — is then the platform's, not
  // a keydown handler of ours that has to be right on every browser. The labels
  // are CSS-styled segments; the inputs themselves are visually hidden but
  // remain focusable and hit-testable through their labels.
  //
  // `name` is per-render-unique so two open editors (or the same role re-rendered)
  // can never share a radio group — same-named radios anywhere in the document
  // are ONE group, and a second row would silently uncheck the first.
  let dispatchGroupSeq = 0;
  function buildDispatchSegments(current, onChange) {
    const group = document.createElement('div');
    group.className = 'team-role-segments';
    // A native radio group is already a radiogroup to the a11y tree; the label
    // is what it lacks, since the visible caption sits outside the control.
    group.setAttribute('role', 'radiogroup');
    group.setAttribute('aria-label', 'dispatch');
    const gname = `dispatch-seg-${++dispatchGroupSeq}`;
    for (const value of DISPATCH_VALUES) {
      const seg = document.createElement('label');
      seg.className = 'team-role-segment';
      // The explanation rides `title`, per B4 — the visible label stays one word.
      seg.title = DISPATCH_HELP[value] || value;
      const radio = document.createElement('input');
      radio.type = 'radio';
      radio.name = gname;
      radio.value = value;          // PROPERTY, never an attribute.
      radio.dataset.f = 'dispatch';
      radio.checked = value === current;
      radio.addEventListener('change', () => {
        if (radio.checked && typeof onChange === 'function') onChange(radio.value);
      });
      const txt = document.createElement('span');
      txt.textContent = value;      // one word, by property
      seg.appendChild(radio);
      seg.appendChild(txt);
      group.appendChild(seg);
    }
    return group;
  }

  // B3/R4: the cwd + template fields, in whatever state fieldReveal says. Built
  // imperatively and rebuilt on every dispatch change.
  //
  // SECURITY: `cwd` and `template` are agent-writable unconstrained strings from
  // team.json. Every one of them lands here as a `.value` PROPERTY or a
  // textContent — never in a value="…" attribute, which a `" onfocus="` payload
  // would break out of in this nodeIntegration renderer.
  function renderRevealedFields(box, reveal, values) {
    box.innerHTML = '';
    for (const f of ['template', 'cwd']) {
      const state = reveal[f];
      // 'hidden' only ever applies to an ALREADY-EMPTY value (fieldReveal's own
      // invariant, pinned in its tests), so omitting the field here cannot lose
      // data — buildSavePatch will send '' for a cwd that was already ''.
      if (state === 'hidden') continue;
      const field = document.createElement('label');
      field.className = `team-role-field ${state === 'stale' ? 'stale' : ''}`.trim();
      field.dataset.field = f;
      const label = document.createElement('span');
      label.textContent = f;
      const input = document.createElement('input');
      input.type = 'text';
      input.dataset.f = f;
      input.placeholder = f === 'cwd' ? 'optional: subdirectory (e.g. api)' : 'optional: spawn template name';
      input.value = (values && values[f]) || ''; // PROPERTY (agent-writable).
      field.appendChild(label);
      field.appendChild(input);
      if (state === 'stale') {
        // The R4 case: a value IS stored but the role dispatches standing, so
        // nothing consumes it. It must stay VISIBLE — buildSavePatch always sends
        // `cwd`, so a hidden non-empty one would be resubmitted on every save
        // with no way for the operator to see or remove it.
        input.disabled = true;
        const why = document.createElement('span');
        why.className = 'team-role-stale-note';
        why.textContent = 'not used while standing';
        const clearable = CLEARABLE.includes(f);
        // A Clear is a PROMISE that Save removes the value, and it is only
        // keepable where buildSavePatch transmits a blank. It does for `cwd`
        // (setRole deletes the key on empty); it does NOT for `template`, which
        // is omitted when blank because setRole validates any present template
        // against NAME_RE and throws on ''. Offering one there round-trips to
        // "saved" with the value still on disk and no error anywhere — the
        // operator is told a removal happened that did not. The stock `hand`
        // role is exactly this shape (a template, no dispatch, so standing), so
        // it is the DEFAULT team's first expanded row, not an edge case.
        why.title = clearable
          ? `A standing role's seat is operator-created, so ${f} does nothing for it. Clear it, or switch dispatch to spawn/worktree.`
          : `A standing role's seat is operator-created, so ${f} does nothing for it. It can't be cleared from the app in this version — switch dispatch to spawn/worktree, or remove it in team.json.`;
        field.appendChild(why);
        if (clearable) {
          const clear = document.createElement('button');
          clear.type = 'button';
          clear.className = 'secondary team-role-stale-clear';
          // Deliberately NO data-act: the list's click delegation matches
          // `button[data-act]`, and a value there would route this button through
          // the row action switch on every click to match nothing. Its own
          // listener below is the whole behaviour.
          clear.textContent = 'Clear';
          clear.title = `Remove the stored ${f}. Takes effect when you Save.`;
          // Clears the INPUT only; Save is still what writes. A button that wrote
          // straight through would be a destructive action with no confirm and no
          // undo, on a field the operator may have opened the row just to read.
          clear.addEventListener('click', () => {
            input.value = '';
            input.disabled = false;
            field.classList.remove('stale');
            why.remove();
            clear.remove();
          });
          field.appendChild(clear);
        }
      }
      box.appendChild(field);
    }
  }

  // Which role's editor is open. ONE at a time by construction — expanding a
  // second collapses the first, so this is a single key rather than a set. Reset
  // to null on every open (the acceptance test is measured fully collapsed);
  // PRESERVED across a post-mutation refresh, because a Save that collapsed the
  // row you just saved would hide its own result.
  let expandedRole = null;

  // The state dot on a summary line. The lead's dot follows its POINTER
  // resolution, not its seat count: a lead whose seat is stopped is fine and a
  // pointer that resolves to nothing is not, and seat-counting cannot tell those
  // apart. Every other role has no pointer, so presence is all there is.
  function dotStateFor(summary, res) {
    if (summary.key === 'lead' && res) {
      if (res.state === 'live') return 'ok';
      if (res.state === 'stopped') return 'idle';
      return 'warn';
    }
    if (!summary.seats.total) return 'none';
    return summary.seats.working ? 'ok' : 'idle';
  }

  // The collapsed line: dot, key, one-line note, dispatch chip, disclosure.
  // Built imperatively — `key` is charset-gated by ROLE_RE but the note carries
  // SEAT NAMES, and neither may reach an attribute in this nodeIntegration
  // renderer. Every string below lands as textContent.
  function buildSummaryLine(summary, { res, expanded, owed }) {
    const head = document.createElement('div');
    head.className = 'team-role-summary';

    const dot = document.createElement('span');
    dot.className = `team-role-dot ${dotStateFor(summary, res)}`;
    // The dot alone is not information for a screen reader, and colour alone is
    // not information for anyone who cannot distinguish it.
    dot.title = summary.key === 'lead' && res ? res.note : `${summary.seats.total} seat(s), ${summary.seats.working} working`;
    head.appendChild(dot);

    const k = document.createElement('span');
    k.className = 'team-role-key';
    k.textContent = summary.key;
    head.appendChild(k);

    const note = document.createElement('span');
    note.className = 'team-role-note';
    // The lead's line names the SEAT its pointer holds, even when that seat is
    // not running: `roleSummaries` counts live rows, and "no seat" is the wrong
    // word for a stopped lead that restarts under this name. The dot and the
    // title carry the state.
    note.textContent = summary.key === 'lead' && res ? (res.name || 'no seat') : summary.note;
    head.appendChild(note);

    // R2: the dispatch CONCEPT stays on screen even when the field is collapsed.
    const chip = document.createElement('span');
    chip.className = 'team-role-chip';
    chip.textContent = summary.dispatch;
    chip.title = 'What dispatching a ticket to this role does';
    head.appendChild(chip);

    // A collapsed row must not swallow an unresolved reference. The checklist
    // itself lives in the body; this is the marker that says there is one.
    if (owed && owed.length) {
      const warns = owed.filter((f) => f.level === 'warn').length;
      const mark = document.createElement('span');
      mark.className = `team-role-owed ${warns ? 'warn' : 'note'}`;
      mark.textContent = warns ? '!' : '·';
      mark.title = `${owed.length} unresolved reference(s) — expand for detail`;
      head.appendChild(mark);
    }

    const disclose = document.createElement('button');
    disclose.type = 'button';
    disclose.className = 'team-role-disclose';
    disclose.dataset.act = 'disclose';
    disclose.setAttribute('aria-expanded', expanded ? 'true' : 'false');
    disclose.textContent = expanded ? '▾' : '▸';
    disclose.title = expanded ? 'Collapse this role' : 'Expand this role';
    head.appendChild(disclose);

    return head;
  }

  // One absent stock role, offered back (R3). ONE component for every stock key
  // rather than a wizard mode, so a lead-only team looks like a setup screen
  // without being a second code path. Fixed strings only — the key comes from a
  // module constant and the note from a fixed table, nothing here is
  // agent-writable — and the def it mints is the BACKEND's, never this surface's.
  function buildOfferCard(key, { note, dispatchLine }) {
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
    const noteEl = document.createElement('div');
    noteEl.className = 'team-role-lock-note';
    noteEl.textContent = note;
    el.appendChild(noteEl);
    // R2 again: an offer names how tickets would reach the role, so the concept
    // is learnable from a team that does not have the role yet.
    const disp = document.createElement('div');
    disp.className = 'team-role-offer-dispatch';
    disp.textContent = dispatchLine;
    el.appendChild(disp);
    const actions = document.createElement('div');
    actions.className = 'team-role-actions';
    const add = document.createElement('button');
    add.type = 'button';
    add.dataset.act = 'readd';
    add.textContent = 'Enable';
    // Says what it writes. The def is Clodex's, not the operator's, and not
    // whatever a previous team.json held — that is the property that makes
    // remove-then-re-add safe to offer.
    add.title = "Adds Clodex's built-in definition of this role to the team.";
    actions.appendChild(add);
    el.appendChild(actions);
    return el;
  }

  // The lead decision, with a heading, hoisted OUT of the role list. Used by
  // `setup` (where it is the only thing on screen) and by `repair` (where it
  // sits above the collapsed rows carrying the reason).
  function buildLeadBlockCard(manifest, res, stage) {
    const el = document.createElement('div');
    el.className = `team-role-row team-lead-card ${stage}`;
    el.dataset.role = 'lead';
    const head = document.createElement('div');
    head.className = 'team-role-head';
    const k = document.createElement('span');
    k.className = 'team-role-key';
    k.textContent = stage === 'setup' ? 'Choose this team’s lead' : 'This team’s lead needs attention';
    head.appendChild(k);
    el.appendChild(head);
    const why = document.createElement('div');
    why.className = 'team-role-lock-note';
    // The RESOLUTION's own note is the reason — it is the sentence that names
    // the fix, and restating it here in different words is how the two drift.
    why.textContent = res.note;
    el.appendChild(why);
    el.appendChild(buildLeadSeatBlock(manifest));
    if (stage === 'setup') {
      const after = document.createElement('div');
      after.className = 'team-lead-hint';
      after.textContent = 'Roles appear here once this team has a lead.';
      el.appendChild(after);
    }
    return el;
  }

  function renderRows(manifest) {
    listEl.innerHTML = '';
    const res = leadResolution(manifest && manifest.lead, { sessions: leadSessions, known: leadKnown });
    const stage = teamStage(res);
    // `setup` is the ONE stage that hides the rest of the popover: with no lead
    // there is exactly one decision to make, and every other control acts on a
    // team that cannot dispatch anything yet. `repair` keeps them — an operator
    // repairing a pointer still needs to see what the team was configured to do.
    addSection.classList.toggle('hidden', stage === 'setup');
    // The watchdog's visibility belongs to the GEAR now (B2), not to the stage:
    // renderRows runs on every post-mutation refresh, so a `toggle(…, stage ===
    // 'setup')` here would re-SHOW the section every time the operator saved
    // anything — the gear would look like it had come back open by itself.
    // `setup` still suppresses it, along with the gear that opens it, because
    // there is no team to configure a watchdog for yet.
    if (stage === 'setup') {
      watchdogSection.classList.add('hidden');
      settingsBtn.setAttribute('aria-expanded', 'false');
    }
    settingsBtn.classList.toggle('hidden', stage === 'setup');
    if (stage !== 'normal') listEl.appendChild(buildLeadBlockCard(manifest, res, stage));
    if (stage === 'setup') return;
    const summaries = roleSummaries(manifest, leadSessions, { lead: manifest && manifest.lead });
    const summaryByKey = new Map(summaries.map((s) => [s.key, s]));
    for (const row of teamRoleRows(manifest)) {
      const el = document.createElement('div');
      el.className = 'team-role-row';
      el.dataset.role = row.key;
      const owed = preflight.get(row.key) || [];
      const expanded = expandedRole === row.key;
      el.appendChild(buildSummaryLine(summaryByKey.get(row.key), { res, expanded, owed }));
      // The editor lives in a body element that the summary line discloses. Its
      // MARKUP is unchanged — the same innerHTML strings, the same property
      // assignments after them — so the security shape of both arms is exactly
      // what it was; only the container it hangs from is new.
      const body = document.createElement('div');
      body.className = 'team-role-body';
      if (!expanded) body.classList.add('hidden');
      el.appendChild(body);
      if (row.readOnly) {
        // Reserved (lead/reviewer): explained-and-locked. brief + prompt are shown
        // read-only. SECURITY: these are agent-writable strings — rendered as
        // ESCAPED TEXT between tags (never into an attribute), same rule as the
        // editable branch. The lock note is a fixed, newcomer-facing string.
        el.classList.add('read-only');
        body.innerHTML =
          `<div class="team-role-head"><span class="team-role-key">${esc(row.key)}</span>` +
          `<span class="team-role-badge" title="Clodex defines this role so a team always has one. Which seat fills it is yours to decide.">built-in role</span></div>` +
          `<div class="team-role-lock-note">${esc(reservedRoleNote(row.key))}</div>` +
          `<div class="team-role-ro-field"><span>brief</span><span class="ro-val">${esc(row.brief || '—')}</span></div>` +
          `<div class="team-role-ro-field"><span>prompt</span><span class="ro-val">${esc(row.prompt || '—')}</span></div>`;
        // The lead ROLE stays locked; which SEAT fills it does not (t420).
        // Gated on `normal` because a non-normal stage ALREADY hoisted a lead
        // block card above the list: two live seat editors for one setting, each
        // internally consistent under the row-scoped click delegation, would show
        // divergent values for the same field on exactly the screen whose job is
        // to fix a broken pointer.
        if (row.key === 'lead' && stage === 'normal') body.appendChild(buildLeadSeatBlock(manifest));
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
          body.appendChild(actions);
        }
      } else {
        // SECURITY: brief/prompt/template/cwd are agent-writable unconstrained strings
        // (only role KEYS are charset-gated). NEVER interpolate them into a
        // value="…" attribute — a `" onfocus="…` payload would break out of the
        // attribute and execute in this nodeIntegration renderer. Build the inputs
        // WITHOUT value attrs, then assign each `.value` by property below (a
        // property assignment can't escape an attribute context). Placeholders +
        // the caption are fixed strings — they signal this row is editable (C3).
        body.innerHTML =
          `<div class="team-role-head"><span class="team-role-key">${esc(row.key)}</span></div>` +
          `<div class="team-role-editcap">Edit this role</div>` +
          `<label class="team-role-field"><span>brief</span><input type="text" data-f="brief" placeholder="one line: what this role is for"></label>` +
          `<label class="team-role-field" title="Sets how this teammate behaves"><span>prompt</span><select data-f="prompt"></select></label>` +
          `<div class="team-role-dispatch" data-f-group="dispatch"></div>` +
          `<div class="team-role-reveal" data-reveal></div>` +
          `<div class="team-role-actions">` +
          `<button type="button" data-act="save">Save</button>` +
          `<button type="button" data-act="rename" class="secondary">Rename</button>` +
          `<button type="button" data-act="remove" class="secondary">Remove</button>` +
          `</div>`;
        body.querySelector('input[data-f="brief"]').value = row.brief;
        // Prompt is a picker (must be a library prompt name — free text just
        // fails at spawn time; matches the Add Role form). Options come from the
        // same rail-filtered list; a stored prompt missing from the library still
        // has to display, so it's appended as a marked option rather than
        // silently blanking. Values/labels set by PROPERTY (agent-writable).
        const sel = body.querySelector('select[data-f="prompt"]');
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
        // `template` and `cwd` are NOT assigned here any more: both are built by
        // renderRevealedFields below, which may legitimately omit either one (B3),
        // and a querySelector for a field the reveal rules hid returns null. Their
        // values land there, by property, from the same `row`.
        // B4: dispatch is a segmented radiogroup, not a sentence-length select.
        // A hand-edited team.json can hold a value no segment carries; the
        // control falls back to the default rather than leaving nothing checked,
        // which would send '' and have buildSavePatch drop the key silently.
        const initialDispatch = DISPATCH_VALUES.includes(row.dispatch) ? row.dispatch : DEFAULT_DISPATCH;
        const revealBox = body.querySelector('[data-reveal]');
        // The reveal follows the dispatch control WITHOUT a save round-trip (B3).
        //
        // What the fields currently HOLD, not what is on disk. Rebuilding empties
        // the container and re-seeds it, so seeding from `row` would silently
        // revert unsaved input: typing a cwd then picking another ACTIVE dispatch
        // reverted it (edit → edit, nothing needed rebuilding at all), and
        // clearing a stale cwd then switching to spawn brought the cleared value
        // back so the next Save re-wrote it. A field returning from `hidden`
        // reads '' here and that is correct — fieldReveal only hides an already
        // empty value, which is the same invariant that makes hiding lossless.
        const liveValues = () => {
          const read = (f) => {
            const el = revealBox.querySelector(`input[data-f="${f}"]`);
            return el ? el.value : '';
          };
          return { cwd: read('cwd'), template: read('template') };
        };
        // The reveal currently ON SCREEN, so an unchanged transition can skip the
        // rebuild entirely rather than destroy and recreate identical fields.
        let shownReveal = null;
        const paintReveal = (dispatch) => {
          // State from the STORED def, values from the LIVE inputs — see
          // reconcileReveal's header for why those two sources differ.
          const { reveal, rebuild } = reconcileReveal(shownReveal, dispatch, { cwd: row.cwd, template: row.template });
          if (!rebuild) return;
          renderRevealedFields(revealBox, reveal, liveValues());
          shownReveal = reveal;
        };
        body.querySelector('[data-f-group="dispatch"]').appendChild(
          buildDispatchSegments(initialDispatch, paintReveal),
        );
        // The FIRST paint seeds from the stored def: there are no inputs to carry
        // forward yet, and this is the one moment `row` is the right source.
        shownReveal = fieldReveal(initialDispatch, { cwd: row.cwd, template: row.template });
        renderRevealedFields(revealBox, shownReveal, { cwd: row.cwd, template: row.template });
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
        // In the BODY, behind the disclosure: a collapsed row keeps only the
        // marker on its summary line. The checklist is several lines per finding
        // and putting it outside the body would defeat the collapse on exactly
        // the teams that most need to fit.
        body.appendChild(box);
      }
      listEl.appendChild(el);
    }
    // Every absent STOCK role gets an offer card — the same component for a
    // removed reviewer, a removed hand, and a lead-only team that never had
    // either. The orphan state has no other symptom until a ticket reaches a
    // role that does not exist, and a role that simply vanished from the list is
    // how it stayed invisible. Offers come last, below the roles the team has.
    // Not rendered in `repair`: it lists what the team HAS so the operator can
    // decide about the lead, and an Enable button there acts on a team that
    // cannot dispatch anything yet.
    if (stage === 'normal') {
      for (const key of absentStockRoles(manifest)) {
        listEl.appendChild(buildOfferCard(key, { note: absentStockNote(key), dispatchLine: offerDispatchLine() }));
      }
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
    // Every open starts fully collapsed — the acceptance test (lead + hand +
    // reviewer + one custom role fitting without scrolling) is measured in this
    // state, so it must be the state an open lands in, not one the operator has
    // to reach by collapsing what a previous open left behind.
    expandedRole = null;
    // Both progressive disclosures start closed on every open — the acceptance
    // measurement is taken in this state, so it must be the state an open LANDS
    // in, not one the operator has to reach by collapsing what a previous open
    // left behind.
    setAddPanel(false);
    watchdogSection.classList.add('hidden');
    settingsBtn.setAttribute('aria-expanded', 'false');
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
    if (act === 'disclose') {
      // ONE row open at a time: this assignment IS the collapse of the previous
      // one, since renderRows reads a single key. Re-render rather than toggling
      // a class, so the summary line's arrow, aria-expanded and the body agree
      // by construction instead of by two code paths kept in step.
      expandedRole = expandedRole === role ? null : role;
      const res = await window.api.teamGet(name);
      if (res && res.ok) renderRows(res.team);
      return;
    }
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
      // dispatch is a RADIO GROUP (B4), so the plain lookup above would return
      // the first segment rather than the chosen one — i.e. `standing` on every
      // save, silently reverting a worktree role. Read the checked member.
      const dispatchVal = () => {
        const on = rowEl.querySelector('input[data-f="dispatch"]:checked');
        return on ? on.value : '';
      };
      // A field fieldReveal HID is absent from the DOM, and `val` returns '' for
      // it — which is the right patch value in both cases: `cwd` is hidden only
      // when it is already blank (so '' is a no-op clear), and buildSavePatch
      // OMITS a blank `template`, leaving the stored one untouched.

      // buildSavePatch sends brief/prompt (blank clears) but OMITS a blank
      // template — backend setRole throws NAME_RE on '' (no clear-template in v1).
      const patch = buildSavePatch({
        brief: val('brief'), prompt: val('prompt'), template: val('template'), dispatch: dispatchVal(),
        cwd: val('cwd'),
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
      // `{}` because the BACKEND owns the definition of a stock role: a reserved
      // key is re-minted from the stock def with `def` ignored outright, and an
      // empty def on a non-reserved stock key (`hand`) is substituted for the
      // stock one at the operator door. Mirroring STOCK_ROLE_DEFS here to send a
      // real def would put a second copy of every stock role in the renderer and
      // make this surface look like the author of them — exactly the belief that
      // makes the reserved-key guard rot.
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

  // B1: the Add Role subpanel. Collapsed to a single `+ Add role` button at rest
  // — the largest block of resting height the popover had left.
  //
  // Collapsing RESETS the fields: an abandoned half-filled form that reappeared
  // on the next open would read as saved state for a role that was never added.
  const resetAddForm = () => {
    addName.value = ''; addBrief.value = ''; addTemplate.value = '';
    addPrompt.value = ''; addCwd.value = '';
    addDispatch.value = DEFAULT_DISPATCH;
    paintAddReveal();
  };
  const setAddPanel = (open) => {
    addPanel.classList.toggle('hidden', !open);
    addToggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    // The toggle stays visible while open so the operator can collapse it back
    // without adding anything; only its caption changes.
    addToggle.textContent = open ? '− Add role' : '+ Add role';
    if (!open) resetAddForm();
    else addName.focus();
  };
  // B3 in the Add Role subpanel: the same reveal rules as the row editor. Nothing
  // is stored yet here, so `stale` is unreachable BY CONSTRUCTION — a field the
  // operator typed into and then switched away from would otherwise be re-shown
  // as "stale" while it has never been anywhere near disk. The typed value is
  // preserved across a hide (the input is not destroyed, only hidden) and
  // deliberately NOT sent: the add handler reads the field only when the dispatch
  // makes it live, so a value typed under `spawn` and then switched to
  // `standing` cannot be written invisibly.
  function paintAddReveal() {
    const reveal = fieldReveal(addDispatch.value, { cwd: '', template: '' });
    for (const [f, el] of [['cwd', addCwd], ['template', addTemplate]]) {
      const field = el.closest('.team-role-field');
      if (field) field.classList.toggle('hidden', reveal[f] === 'hidden');
    }
    addDispatchHelp.textContent = DISPATCH_HELP[addDispatch.value] || '';
  }
  addToggle.addEventListener('click', () => setAddPanel(addPanel.classList.contains('hidden')));
  addCancel.addEventListener('click', () => setAddPanel(false));
  addDispatch.addEventListener('change', paintAddReveal);

  // B2: the stall watchdog is a TEAM-level setting, not part of the role flow —
  // behind the gear, same show/hide shape as the `?` help panel beside it.
  settingsBtn.addEventListener('click', () => {
    const nowHidden = watchdogSection.classList.toggle('hidden');
    settingsBtn.setAttribute('aria-expanded', nowHidden ? 'false' : 'true');
  });

  addBtn.addEventListener('click', async () => {
    const name = teamName();
    if (!name) return;
    // The template is validated only when the chosen dispatch actually consumes
    // it: a `foo/bar` typed under spawn and then switched to standing is off
    // screen, and erroring about a field the operator cannot see is a dead end.
    // Same gate that decides whether it is written, below.
    const addReveal = fieldReveal(addDispatch.value, { cwd: '', template: '' });
    const v = validateAddRole({
      name: addName.value,
      template: addReveal.template === 'hidden' ? '' : addTemplate.value,
    });
    if (!v.ok) { setStatus(v.error, true); return; }
    // Omit empty fields rather than writing literal nulls into the def (keeps the
    // manifest clean; the schema treats absent === null anyway).
    const def = {};
    if (addPrompt.value) def.prompt = addPrompt.value;
    // Same gate as `cwd` below: inert under a standing dispatch, so not written.
    // `v.template` is already '' in that case (validateAddRole was given the
    // gated value), so this is belt-and-braces against the two drifting apart.
    if (v.template && addReveal.template !== 'hidden') def.template = v.template;
    const brief = addBrief.value.trim();
    if (brief) def.brief = brief;
    // Omitted when blank, like the fields above: absent already means "the team
    // root", so writing '' would put a value on disk that means what its absence
    // means. A bad path is refused by addRole with the reason, which surfaces on
    // the status line — no mirror of that validation here.
    // Only when the chosen dispatch actually consumes it (B3). A value typed
    // under `spawn` and then switched to `standing` is inert, and writing it
    // would mint exactly the haunted config R4 exists to prevent — on a role
    // that is brand new and has no reason to carry one.
    const cwd = addCwd.value.trim();
    if (cwd && addReveal.cwd !== 'hidden') def.cwd = cwd;
    // Only the non-default is written: absent already reads as `standing`, so an
    // explicit one would put a value on disk that means exactly what its absence
    // does (the same rule migrateRoles follows).
    //
    // Gated on the shared value list, not on one hardcoded value. A per-value
    // test silently DROPS every other option the picker offers — which is what
    // this did to `spawn` — so the failure is a role saved as `standing` with no
    // error anywhere. Fail-closed on top: an option this build does not know is
    // not written, so a stale bundle cannot post an unrecognized dispatch.
    if (addDispatch.value !== DEFAULT_DISPATCH && DISPATCH_VALUES.includes(addDispatch.value)) {
      def.dispatch = addDispatch.value;
    }
    const res = await window.api.teamAddRole(name, v.name, def);
    // Collapse on success: the role now has a row of its own in the list above,
    // and a still-open form holding the values that made it invites a duplicate.
    if (res && res.ok) setAddPanel(false);
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
    // RADIOS EXCLUDED. B4's dispatch segments carry data-f="dispatch", so without
    // this an Enter while arrowing between modes submits the row immediately —
    // mid-decision, and on the one control the operator is most likely to be
    // driving from the keyboard. Enter is a submit for the TEXT fields only.
    if (inp.type === 'radio') return;
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
