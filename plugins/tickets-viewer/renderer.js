'use strict';

/**
 * tickets-viewer — renderer half. Projects on the left, the selected project's
 * open tickets on the right, recently-closed below them. The left pane lists
 * PROJECTS, not teams: the board belongs to the project (t301), so a solo
 * operator with no team reaches every one of these actions.
 *
 * Pull-on-open, no ambient state and no poll, matching memory-viewer: nothing
 * is read until the overlay is opened, and what you see is as of that moment.
 * A live board would need a watcher on every project's tickets.json for a
 * surface a user looks at for ten seconds at a time. Every mutation refreshes
 * the board it changed, which is what keeps a pull-on-open surface honest after
 * a write.
 */

// Core's humanizeAge, deliberately reproduced: the board sits beside
// `[agent:task list]` output and two different roundings of the same age read
// as two different ages.
function humanizeAge(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.round(h / 24)}d`;
}

/**
 * The two halves of a row's age line. Split out and exported because it is the
 * one piece of judgement in this file: `age` is how long the ticket has
 * EXISTED, `quiet` is how long its assignee has been silent, and a board that
 * shows one number cannot tell a long job from an abandoned one.
 */
function ageLine(t) {
  const parts = [];
  parts.push(t.ageMs === null ? 'opened: unknown' : `open ${humanizeAge(t.ageMs)}`);
  if (t.quietMs !== null) parts.push(`quiet ${humanizeAge(t.quietMs)}`);
  return parts.join(' · ');
}

/**
 * The trailer under the open list. Every count it names is one the board does
 * NOT show as rows, so a number that is zero must be omitted rather than
 * printed as `0` — a trailer of zeroes trains the eye to skip the line where
 * the non-zero ones appear.
 */
function summaryText(counts) {
  if (!counts) return '';
  const parts = [];
  if (counts.done) parts.push(`${counts.done} done`);
  if (counts.cancelled) parts.push(`${counts.cancelled} cancelled`);
  if (counts.unknownState) parts.push(`${counts.unknownState} in an unrecognised state`);
  if (counts.malformed) parts.push(`${counts.malformed} unreadable record(s)`);
  return parts.join(' · ');
}

/**
 * The label for a project row. The KEY carries a hash the operator never typed
 * and cannot act on, so the leaf leads; the team, when one names the project,
 * is what most operators actually recognise it by.
 */
function projectLabel(p) {
  if (!p) return '';
  return p.team ? `${p.leaf || p.key} · ${p.team}` : (p.leaf || p.key);
}

/**
 * What a write that changed the board but could not reach the seat should say.
 *
 * A separate function because the distinction is the point: the ticket IS
 * assigned, so this is not an error and must not paint like one, but an
 * assignment nobody was told about is the one outcome that otherwise looks
 * exactly like success.
 */
function deliveryNote(assignee, delivered) {
  if (!assignee) return '';
  return delivered ? '' : `${assignee} is not running — the ticket is assigned but the spec was not delivered.`;
}

module.exports.humanizeAge = humanizeAge;
module.exports.ageLine = ageLine;
module.exports.summaryText = summaryText;
module.exports.projectLabel = projectLabel;
module.exports.deliveryNote = deliveryNote;

module.exports.activate = (rhost) => {
  let torn = false;
  const alive = () => !torn;

  /**
   * Resolves to `{ ok: true, … }` or `{ ok: false, error }` — never null, and
   * never a bare empty result on failure. Every caller renders those two
   * differently, and collapsing them here is precisely how an empty board and a
   * broken one become the same picture.
   */
  function ask(method, arg) {
    if (!alive()) return Promise.resolve({ ok: false, error: 'closed' });
    // Through Promise.resolve().then, not called bare: a synchronous throw out
    // of invoke() would otherwise escape into whoever asked.
    return Promise.resolve()
      .then(() => rhost.invoke(method, arg))
      .then((res) => {
        if (!res || typeof res !== 'object') return { ok: false, error: 'no response from the tickets engine' };
        return res;
      })
      .catch((e) => {
        rhost.log.error(`${method} failed`, e);
        return { ok: false, error: (e && e.message) || 'the tickets engine did not answer' };
      });
  }

  function toastError(res) {
    rhost.ui.showToast((res && res.error) || 'the tickets engine did not answer', { kind: 'error' });
  }

  let refresh = null; // assigned by mount; mount always precedes onOpen

  const surface = rhost.ui.surfaces.overlay({
    id: 'main',
    mount(rootEl) { refresh = wire(rootEl); },
    onOpen() { if (refresh) refresh(); },
  });

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    // textContent, never innerHTML: titles, assignees and task paths are agent-
    // authored content and must render as text.
    if (text !== undefined) e.textContent = text;
    return e;
  }

  function button(cls, label, tip, onClick) {
    const b = el('button', cls, label);
    if (tip) b.title = tip;
    b.addEventListener('click', onClick);
    return b;
  }

  function wire(rootEl) {
    rootEl.innerHTML = '';
    const modal = el('div', 'tv-modal');
    const topbar = el('div', 'tv-topbar');
    topbar.appendChild(el('div', 'tv-title', 'Tickets'));
    topbar.appendChild(el('div', 'tv-subtitle', 'the project ticket board'));
    const closeBtn = el('button', 'tv-close', '×');
    closeBtn.title = 'Close';
    closeBtn.addEventListener('click', () => surface.close());
    topbar.appendChild(closeBtn);

    const body = el('div', 'tv-body');
    const projectsPane = el('div', 'tv-teams');
    const boardPane = el('div', 'tv-board');
    body.appendChild(projectsPane);
    body.appendChild(boardPane);
    modal.appendChild(topbar);
    modal.appendChild(body);
    rootEl.appendChild(modal);

    let selected = null;
    let selectSeq = 0;
    let reloadSeq = 0;
    // Live session names for the assign picker. Refreshed with the board rather
    // than held from activation: a session list captured once would offer seats
    // that died since the overlay was last opened.
    let liveSessions = [];

    /**
     * Re-read and repaint the CURRENT project. Every mutation ends here rather
     * than patching the row it changed: the engine derives title, taskDir,
     * stall flags and counts from the record it just wrote, so re-reading is
     * what keeps the screen equal to the disk. A patched row would drift from
     * the board on the very first field the renderer forgot.
     */
    function reselect() {
      if (!selected) return Promise.resolve();
      return selectProject(selected);
    }

    /**
     * Run a mutating call, report a failure, and repaint on success.
     * `note` is for the half-success an error toast would misreport — an
     * assignment written but not delivered.
     */
    async function mutate(method, payload, note) {
      const res = await ask(method, payload);
      if (!alive()) return res;
      if (!res.ok) { toastError(res); return res; }
      if (note) {
        const text = note(res);
        if (text) rhost.ui.showToast(text, { kind: 'error' });
      }
      await reselect();
      return res;
    }

    // ── the editor ────────────────────────────────────────────────────────
    //
    // One inline panel serves add and edit-spec. Inline rather than a
    // window.confirm/prompt pair because a spec is multi-line text: prompt()
    // collapses it to one line and would silently rewrite every spec edited
    // through it. confirm() is still right for the terminal actions below,
    // where the question genuinely is yes/no.
    let editorEl = null;

    function closeEditor() {
      if (editorEl && editorEl.parentNode === boardPane) boardPane.removeChild(editorEl);
      editorEl = null;
    }

    function openEditor(opts) {
      closeEditor();
      const panel = el('div', 'tv-editor');
      panel.appendChild(el('div', 'tv-editor-head', opts.heading));

      const area = el('textarea', 'tv-editor-spec');
      area.value = opts.spec || '';
      area.placeholder = 'The ticket spec. Its first non-empty line becomes the title.';
      panel.appendChild(area);

      // Only the add form picks an assignee. Reassignment is its own action on
      // the row, so offering the field here too would give one operation two
      // entry points that could disagree.
      let picker = null;
      if (opts.assignable) {
        picker = el('select', 'tv-editor-assignee');
        const none = el('option', '', 'unassigned (backlog)');
        none.value = '';
        picker.appendChild(none);
        for (const name of liveSessions) {
          const o = el('option', '', name);
          o.value = name;
          picker.appendChild(o);
        }
        const row = el('div', 'tv-editor-row');
        row.appendChild(el('span', 'tv-editor-label', 'Assign to'));
        row.appendChild(picker);
        panel.appendChild(row);
      }

      const actions = el('div', 'tv-editor-actions');
      actions.appendChild(button('tv-btn tv-btn-primary', opts.submitLabel, '', async () => {
        const spec = String(area.value || '');
        // Checked here as well as in the engine so the operator is told before
        // a round trip, and in the engine because this half cannot enforce it.
        if (!spec.trim()) { rhost.ui.showToast('a ticket needs a spec', { kind: 'error' }); return; }
        const res = await opts.submit(spec, picker ? String(picker.value || '') : '');
        if (res && res.ok) closeEditor();
      }));
      actions.appendChild(button('tv-btn', 'Cancel', '', () => closeEditor()));
      panel.appendChild(actions);

      // Prepended: the panel is the thing just asked for, and a board with
      // forty rows would otherwise open it below the fold.
      if (boardPane.firstChild) boardPane.insertBefore(panel, boardPane.firstChild);
      else boardPane.appendChild(panel);
      editorEl = panel;
      if (area.focus) area.focus();
    }

    function openAdd() {
      openEditor({
        heading: 'New ticket',
        spec: '',
        assignable: true,
        submitLabel: 'Open ticket',
        submit: (spec, assignee) => mutate('add', { project: selected, spec, assignee },
          (res) => deliveryNote(assignee, res.delivered)),
      });
    }

    function openEditSpec(t) {
      openEditor({
        heading: `Edit spec — ${t.id}`,
        spec: t.spec,
        assignable: false,
        submitLabel: 'Save spec',
        submit: (spec) => mutate('editSpec', { project: selected, id: t.id, spec }),
      });
    }

    // ── row actions ───────────────────────────────────────────────────────

    /**
     * The assign / reassign control. A select rather than a free-text field:
     * with no team an assignee IS a live session name, so the set of valid
     * answers is known and typing one is a chance to typo a ticket into a seat
     * that does not exist.
     *
     * The head option names the current holder as `shownFor` — the ROLE the
     * ticket was filed under, when it has one — and never the raw `assignee`.
     * Core re-pins `assignee` to a concrete seat at delivery, so rendering the
     * pin here would make this control name a seat for the same ticket the
     * board's own assignee cell, `[agent:task list]` and the exec leaf all call
     * `hand`. It is display only; the value it carries is the empty no-change
     * one, so nothing is assigned by reading it.
     */
    function assignControl(t) {
      const sel = el('select', 'tv-assign');
      sel.title = 'Assign this ticket to a live session';
      const holder = t.shownFor || t.assignee;
      const head = el('option', '', holder ? `${holder} (unchanged)` : 'unassigned — pick a seat');
      head.value = '';
      sel.appendChild(head);
      for (const name of liveSessions) {
        if (name === t.assignee) continue;
        const o = el('option', '', name);
        o.value = name;
        sel.appendChild(o);
      }
      sel.addEventListener('change', async () => {
        const who = String(sel.value || '');
        if (!who) return;
        await mutate('assign', { project: selected, id: t.id, assignee: who },
          (res) => deliveryNote(who, res.delivered));
      });
      return sel;
    }

    function rowActions(t) {
      const bar = el('div', 'tv-actions');
      bar.appendChild(assignControl(t));
      bar.appendChild(button('tv-btn', 'Edit spec', 'Replace this ticket\'s spec', () => openEditSpec(t)));
      // Both terminal actions confirm, and the memory-viewer precedent is the
      // reason: a confirmation is for what cannot be undone. Neither can be —
      // the board has no reopen action, so a mis-click is a trip to
      // `[agent:task reject]` or a hand-edit of tickets.json.
      bar.appendChild(button('tv-btn', 'Close', 'Mark this ticket done', async () => {
        if (!confirm(`Close ${t.id} as done?\n\n${t.title}`)) return;
        await mutate('close', { project: selected, id: t.id });
      }));
      bar.appendChild(button('tv-btn tv-btn-danger', 'Cancel', 'Cancel this ticket', async () => {
        if (!confirm(`Cancel ${t.id}?\n\n${t.title}\n\nCancelled tickets are not counted as done.`)) return;
        await mutate('cancel', { project: selected, id: t.id });
      }));
      return bar;
    }

    function ticketRow(t, opts) {
      // The failed merge takes the row-level mark AHEAD of the stall, and the
      // precedence is load-bearing rather than arbitrary: `stalled` is not
      // gated on the row being open — shape() computes it for closed rows too —
      // so a merge that failed and then sat past the threshold satisfies both,
      // and the amber stall edge would otherwise hide the red one. Of the two
      // the failure is the actionable claim: the stall is its consequence, and
      // chasing the seat is not what clears it.
      //
      // `mergeWaiting` deliberately gets no row mark at all — it resolves by
      // itself, and painting the row would recreate on this board the "looks
      // like it needs a human" confusion that made core keep the fields apart.
      const row = el('div', t.mergeError
        ? 'tv-ticket tv-merge-failed'
        : (t.stalled ? 'tv-ticket tv-stalled' : 'tv-ticket'));

      const head = el('div', 'tv-ticket-head');
      head.appendChild(el('span', 'tv-id', t.id));
      const titleSpan = el('span', 'tv-ticket-title', t.title);
      // .tv-ticket-title ellipsizes, so hover is the only way back to a long
      // title. Set on the span and not just the head: the nearer element wins,
      // and head's own title is the click hint.
      titleSpan.title = t.title;
      head.appendChild(titleSpan);
      row.appendChild(head);

      // Collapsed by default and built lazily: the board's strength is that
      // twenty-one rows fit on one screen, and a spec runs to a couple of KB.
      // Expanding is the reader asking for one of them, not the default view.
      let specEl = null;
      head.title = 'Click to show the ticket spec';
      head.addEventListener('click', () => {
        if (specEl) { row.removeChild(specEl); specEl = null; return; }
        // Tested TRIMMED, rendered WHOLE: a spec of "\n\n" is truthy and would
        // open a blank box, which is the rendering gap the no-spec branch
        // exists to prevent. The height cap lives in CSS, not in a substring
        // here, so nothing is silently dropped.
        specEl = t.spec && t.spec.trim()
          ? el('pre', 'tv-spec', t.spec)
          : el('div', 'tv-spec tv-no-spec', 'no spec recorded for this ticket');
        row.appendChild(specEl);
      });

      const meta = el('div', 'tv-meta');
      // An unassigned open ticket is backlog, not an unlabelled row: it is a
      // different action for the operator (assign) than a stalled assigned one.
      const who = el('span', t.assignee ? 'tv-assignee' : 'tv-assignee tv-unassigned',
        t.shownFor || t.assignee || 'unassigned');
      meta.appendChild(who);
      meta.appendChild(el('span', 'tv-age', opts && opts.closed
        ? `closed ${t.closedAt === null ? 'at an unknown time' : `${humanizeAge(t.now - t.closedAt)} ago`}`
        : ageLine(t)));
      if (opts && opts.closed && t.closedBy) meta.appendChild(el('span', 'tv-closed-by', `by ${t.closedBy}`));
      if (t.stalled) {
        // Two different situations for the operator: nobody has chased this
        // yet, or the watchdog already did and it is still quiet.
        const flag = el('span', 'tv-stall-flag', t.nudged ? 'stalled · nudged' : 'stalled');
        flag.title = t.nudged
          ? 'Quiet past the stall threshold; the watchdog has already nudged the seat once.'
          : 'Quiet past the stall threshold.';
        meta.appendChild(flag);
      } else if (t.parked && !(opts && opts.closed)) {
        // Ahead of the backlog branch, and both are reachable: a parked ticket
        // can also be unassigned, and "parked" is the more specific of the two
        // (a decision already made and reversible) while "backlog" reads as one
        // nobody has made yet.
        const flag = el('span', 'tv-backlog-flag', 'parked');
        flag.title = 'Held out of dispatch. The seat has NOT been sent the spec; assign it to release.';
        meta.appendChild(flag);
      } else if (t.backlog && !(opts && opts.closed)) {
        // Its own flag, never the stalled one: core's watchdog exempts
        // unassigned tickets outright, so this row has not gone quiet — it was
        // never given to anyone. Age is still worth seeing (a backlog ticket
        // sitting for a week is a decision nobody has made), but it must not
        // count toward the stall total or the section head.
        const flag = el('span', 'tv-backlog-flag', 'backlog');
        flag.title = 'Unassigned, so the watchdog never nudges it. Assign it or close it.';
        meta.appendChild(flag);
      }

      // Both merge marks sit OUTSIDE the chain above, which is mutually
      // exclusive — a merge state is orthogonal to a stall, and a row can
      // truthfully carry one of each. Neither is gated on `!opts.closed` the
      // way the parked and backlog arms are: a merge mark's normal home is the
      // recently-closed block, since the loop merges after `task done` and an
      // ACCEPT verdict, so gating them would hide the common case.
      //
      // Rendered as BADGES rather than as the text boards' `(merge waiting: …)`
      // / ` !! MERGE FAILED: …` suffixes, but preserving what those shapes
      // encode: a lead scanning the board separates "needs me" from "waiting
      // its turn" WITHOUT reading the words. Here that distinction rides colour
      // and weight — red and bold against dim and regular — plus the row-level
      // border below, which only the failure gets.
      if (t.mergeWaiting) {
        const flag = el('span', 'tv-merge-waiting', `merge waiting: ${t.mergeWaiting}`);
        flag.title = 'The auto-merge was deferred and is still coming. No action needed.';
        meta.appendChild(flag);
      }
      if (t.mergeError) {
        const flag = el('span', 'tv-merge-error', `merge failed: ${t.mergeError}`);
        flag.title = 'The merge loop gave up at this step. This ticket needs the lead to merge by hand.';
        meta.appendChild(flag);
      }
      row.appendChild(meta);

      // The artifact path is how a fresh seat recovers a dead worker's task, so
      // its ABSENCE is information: a ticket with no tasks/ dir in its spec has
      // nothing on disk to pick up, and a blank cell would read as a rendering
      // gap instead.
      const art = el('div', t.taskDir ? 'tv-artifact' : 'tv-artifact tv-no-artifact',
        t.taskDir || 'no task directory in the spec');
      if (t.taskDir) art.title = t.taskDir;
      row.appendChild(art);

      // Open rows only. A closed ticket has no lifecycle action left on this
      // board — reopening is `[agent:task reject]`, which carries the notice to
      // the seat that a silent state flip here would not.
      if (!(opts && opts.closed)) row.appendChild(rowActions(t));

      return row;
    }

    function renderBoard(res) {
      boardPane.innerHTML = '';
      editorEl = null;
      if (!res.ok) {
        // Not the same as an empty board, and the difference is the whole
        // point: one says "nothing open", the other says "do not believe me".
        boardPane.appendChild(el('div', 'tv-error', `Could not read this project's tickets: ${res.error || 'unknown error'}`));
        return;
      }

      // The tickets read fine; the team.json beside them would not survive
      // core's loader. Shown above the board rather than in place of it — the
      // rows are real — but shown, because a team the app cannot resolve must
      // not look entirely healthy here.
      if (res.warning) {
        boardPane.appendChild(el('div', 'tv-warning', `This project's team manifest is unusable: ${res.warning}`));
      }

      const openHead = el('div', 'tv-section-head', `Open (${res.open.length})`);
      // The one action that is not about an existing row, so it lives on the
      // section head rather than in the rows.
      openHead.appendChild(button('tv-btn tv-btn-primary tv-add', '+ New ticket',
        'Open a ticket on this board', () => openAdd()));
      boardPane.appendChild(openHead);

      if (!res.open.length) {
        boardPane.appendChild(el('div', 'tv-empty', 'No open tickets.'));
      } else {
        const stalledCount = res.open.filter((t) => t.stalled).length;
        if (stalledCount) {
          openHead.appendChild(el('span', 'tv-stall-count',
            `${stalledCount} quiet longer than ${humanizeAge(res.stallMs)}`));
        }
        const backlogCount = res.open.filter((t) => t.backlog).length;
        if (backlogCount) {
          openHead.appendChild(el('span', 'tv-backlog-count', `${backlogCount} unassigned`));
        }
        // Counted over ALL parked rows, including the unassigned ones the line
        // above also counts. The two heads answer different questions ("who
        // decides this" vs "what is held back") and a parked backlog ticket is
        // honestly both.
        const parkedCount = res.open.filter((t) => t.parked).length;
        if (parkedCount) {
          openHead.appendChild(el('span', 'tv-backlog-count', `${parkedCount} parked`));
        }
        for (const t of res.open) boardPane.appendChild(ticketRow({ ...t, now: res.now }));
      }

      const summary = summaryText(res.counts);
      if (summary) boardPane.appendChild(el('div', 'tv-summary', summary));

      // Below the open list and visually quieter — present when wanted, never
      // competing with open work for the top of the pane.
      if (res.recent.length) {
        const head = el('div', 'tv-section-head tv-section-quiet',
          `Recently closed (last ${humanizeAge(res.counts.recentWindowMs)})`);
        if (res.counts.recentOver > 0) {
          head.appendChild(el('span', 'tv-stall-count', `+${res.counts.recentOver} more`));
        }
        boardPane.appendChild(head);
        for (const t of res.recent) {
          boardPane.appendChild(ticketRow({ ...t, now: res.now }, { closed: true }));
        }
      }
    }

    async function selectProject(key) {
      // A monotonic token, not `selected !== key`: identity cannot tell two
      // requests for the SAME project apart, and a reload during an in-flight
      // fetch makes that collision reachable.
      //
      // BOTH tokens are captured. A reload landing mid-fetch clears the pane and
      // starts its own select; gating on selectSeq alone lets this one's result
      // paint over that, so the board would show one project while the sidebar
      // highlights another.
      const my = ++selectSeq;
      const myReload = reloadSeq;
      selected = key;
      for (const row of projectsPane.querySelectorAll('.tv-team-row')) {
        row.classList.toggle('tv-selected', row.dataset.tvProject === key);
      }
      boardPane.innerHTML = '';
      editorEl = null;
      boardPane.appendChild(el('div', 'tv-empty', 'Loading…'));
      // Both, together: the assign controls the board paints are only as good
      // as the session list beside them, and fetching them apart would let a
      // board render with a stale picker.
      const [res, live] = await Promise.all([ask('board', key), ask('sessions')]);
      if (!alive() || my !== selectSeq || myReload !== reloadSeq) return;
      // A failed session list is not a failed board: the rows are still worth
      // showing, with a picker that offers nothing.
      liveSessions = live.ok && Array.isArray(live.sessions) ? live.sessions : [];
      renderBoard(res);
    }

    function renderProjects(res) {
      projectsPane.innerHTML = '';
      if (!res.ok) {
        projectsPane.appendChild(el('div', 'tv-error', `Could not read the projects directory: ${res.error || 'unknown error'}`));
        boardPane.innerHTML = '';
        return;
      }
      const list = Array.isArray(res.projects) ? res.projects : [];
      if (!list.length) {
        projectsPane.appendChild(el('div', 'tv-empty', 'No projects yet.'));
        boardPane.innerHTML = '';
        boardPane.appendChild(el('div', 'tv-empty', 'A board appears here once a project has its first ticket.'));
        return;
      }
      for (const p of list) {
        const row = el('div', 'tv-team-row');
        row.dataset.tvProject = p.key;
        const name = el('span', 'tv-team-name', projectLabel(p));
        // The key and root are the disambiguators when two checkouts share a
        // leaf name, and neither fits the row.
        name.title = p.root ? `${p.key}\n${p.root}` : p.key;
        row.appendChild(name);
        if (p.error) {
          // The project is still selectable — the board pane repeats the reason
          // in full. What must not happen is this row looking like "0 open".
          const bad = el('span', 'tv-team-error', '!');
          bad.title = p.error;
          row.appendChild(bad);
        } else {
          if (p.warning) {
            // Distinct from the error marker above: the tickets ARE readable
            // here, so the row keeps its count. Only the manifest is bad.
            const warn = el('span', 'tv-team-warning', '⚠');
            warn.title = p.warning;
            row.appendChild(warn);
          }
          if (p.stalled) {
            const s = el('span', 'tv-team-stalled', String(p.stalled));
            s.title = `${p.stalled} open ticket(s) quiet past the stall threshold`;
            row.appendChild(s);
          }
          if (p.backlog) {
            // Its own chip, and deliberately not summed with the stalled one:
            // these two numbers ask for different actions.
            const b = el('span', 'tv-team-backlog', String(p.backlog));
            b.title = `${p.backlog} open ticket(s) with no assignee — the watchdog never nudges these`;
            row.appendChild(b);
          }
          if (p.parked) {
            const pk = el('span', 'tv-team-backlog', String(p.parked));
            pk.title = `${p.parked} open ticket(s) parked — assigned or not, held out of dispatch until released`;
            row.appendChild(pk);
          }
          row.appendChild(el('span', 'tv-team-count', `${p.open} open`));
        }
        row.addEventListener('click', () => {
          selectProject(p.key).catch((e) => rhost.log.error('select failed', e));
        });
        projectsPane.appendChild(row);
      }
      if (!selected || !list.some((p) => p.key === selected)) {
        selected = list[0].key;
      }
      selectProject(selected).catch((e) => rhost.log.error('select failed', e));
    }

    async function reload() {
      const my = ++reloadSeq;
      projectsPane.innerHTML = '';
      projectsPane.appendChild(el('div', 'tv-empty', 'Loading…'));
      const res = await ask('projects');
      if (!alive() || my !== reloadSeq) return;
      renderProjects(res);
    }

    return () => { reload().catch((e) => rhost.log.error('reload failed', e)); };
  }

  rhost.ui.sidebar.footerButton({
    id: 'open',
    glyph: '▤',
    label: 'Tickets',
    tip: 'The project ticket board',
    onClick: () => surface.open(),
  });

  return () => { torn = true; };
};
