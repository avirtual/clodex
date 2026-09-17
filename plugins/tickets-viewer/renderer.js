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

const SEARCH_DEBOUNCE_MS = 250;

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

function hitAgeText(h, now) {
  const closed = h && (h.state === 'done' || h.state === 'cancelled');
  if (!closed) return '';
  if (h.closedAt === null || h.closedAt === undefined) return 'closed at an unknown time';
  return `closed ${humanizeAge(now - h.closedAt)} ago`;
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

const CLOSED_PAGE_SIZE = 50;

function verdictChipClass(verdict) {
  const slug = String(verdict == null ? '' : verdict).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return slug ? `tv-verdict-chip tv-verdict-${slug}` : 'tv-verdict-chip';
}

function roundsText(n) {
  const count = Number.isFinite(Number(n)) ? Number(n) : 0;
  return `${count} round${count === 1 ? '' : 's'}`;
}

function pagerText(offset, shown, total) {
  return `${offset + 1}–${offset + shown} of ${total}`;
}

function money(usd) {
  const n = Number(usd);
  if (!Number.isFinite(n)) return '';
  return n >= 100 ? `$${Math.round(n).toLocaleString('en-US')}` : `$${n.toFixed(2)}`;
}

function costText(cost) {
  if (!cost) return '';
  if (cost.usd === null || cost.usd === undefined) return 'cost unknown';
  const total = cost.live || !Number.isFinite(Number(cost.reviewsUsd))
    ? Number(cost.usd)
    : Number(cost.usd) + Number(cost.reviewsUsd);
  return `~${money(total)}${cost.live ? ' ·live' : ''}`;
}

function costTitle(cost) {
  if (!cost) return '';
  if (cost.live) return 'Live figure for the seat holding this ticket — it is still spending.';
  if (cost.usd === null || cost.usd === undefined) {
    return cost.attribution === 'seat-lifetime'
      ? 'The seat that closed this ticket outlives it, so its ledger is an upper bound on the ticket rather than a measurement of it.'
      : 'No seat could be resolved for this ticket, so what it spent is unknown — not zero.';
  }
  const parts = [`hand ${money(cost.usd)}`];
  if (Number.isFinite(Number(cost.reviewsUsd))) {
    parts.push(`review ${money(cost.reviewsUsd)}${cost.rounds ? ` over ${cost.rounds} round${cost.rounds === 1 ? '' : 's'}` : ''}`);
  }
  return parts.join(' + ');
}

function teamCostText(res) {
  if (!res || !res.ok || !res.usd) return '';
  return `team ${res.team}: ~${money(res.usd.total)}`;
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

module.exports.SEARCH_DEBOUNCE_MS = SEARCH_DEBOUNCE_MS;
module.exports.humanizeAge = humanizeAge;
module.exports.ageLine = ageLine;
module.exports.hitAgeText = hitAgeText;
module.exports.summaryText = summaryText;
module.exports.projectLabel = projectLabel;
module.exports.deliveryNote = deliveryNote;
module.exports.money = money;
module.exports.costText = costText;
module.exports.costTitle = costTitle;
module.exports.teamCostText = teamCostText;

module.exports.activate = (rhost) => {
  let torn = false;
  const alive = () => !torn;
  let cancelPending = null;

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
    let searchSeq = 0;
    let searchTimer = null;
    let closedSeq = 0;
    let closedView = null;

    const searchEl = el('input', 'tv-search');
    searchEl.type = 'search';
    searchEl.placeholder = 'Search tickets…';
    const sectionsEl = el('div', 'tv-sections');
    let shellMounted = false;

    function clearBoardPane() {
      boardPane.innerHTML = '';
      shellMounted = false;
      editorEl = null;
    }

    function mountBoardShell() {
      if (shellMounted) return;
      boardPane.innerHTML = '';
      boardPane.appendChild(searchEl);
      boardPane.appendChild(sectionsEl);
      shellMounted = true;
    }
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
      if (editorEl && editorEl.parentNode === sectionsEl) sectionsEl.removeChild(editorEl);
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
      if (sectionsEl.firstChild) sectionsEl.insertBefore(panel, sectionsEl.firstChild);
      else sectionsEl.appendChild(panel);
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

    function specBlock(text, missing) {
      return text && text.trim()
        ? el('pre', 'tv-spec', text)
        : el('div', 'tv-spec tv-no-spec', missing);
    }

    function stamp(at, verb) {
      if (at === null || at === undefined) return `${verb} at an unknown time`;
      return `${verb} ${humanizeAge(Date.now() - at)} ago`;
    }

    function roundBlock(r) {
      const box = el('div', 'tv-round');
      const head = el('div', 'tv-round-head', `Round ${r.round} — ${r.verdict || 'awaiting verdict'}`);
      if (r.reviewedAt !== null && r.reviewedAt !== undefined) {
        head.appendChild(el('span', 'tv-round-age', stamp(r.reviewedAt, 'reviewed')));
      }
      box.appendChild(head);

      if (r.report === null || r.report === undefined) box.appendChild(el('div', 'tv-empty', 'no report recorded'));
      else box.appendChild(el('pre', 'tv-spec', r.report));

      if (r.mustFix !== null && r.mustFix !== undefined) {
        const box2 = el('div', 'tv-mustfix');
        box2.appendChild(el('div', 'tv-mustfix-label', 'Must fix'));
        box2.appendChild(el('pre', 'tv-spec', r.mustFix));
        box.appendChild(box2);
      }
      if (r.diffStat) {
        box.appendChild(el('div', 'tv-diffstat', `${r.diffStat.files} files, +${r.diffStat.added} −${r.diffStat.removed}`));
      }
      if (r.verdictText !== null && r.verdictText !== undefined) {
        let shown = null;
        const toggle = button('tv-btn', 'Show verdict', 'The reviewer\'s full verdict file', () => {
          if (shown) { box.removeChild(shown); shown = null; toggle.textContent = 'Show verdict'; return; }
          shown = el('pre', 'tv-verdict', r.verdictText);
          box.appendChild(shown);
          toggle.textContent = 'Hide verdict';
        });
        box.appendChild(toggle);
      }
      return box;
    }

    function goBack() {
      const q = String(searchEl.value || '').trim();
      if (!q && closedView) {
        renderClosed(selected, closedView).catch((e) => rhost.log.error('closed failed', e));
        return;
      }
      if (q) {
        mountBoardShell();
        sectionsEl.innerHTML = '';
        editorEl = null;
        sectionsEl.appendChild(el('div', 'tv-empty', 'Loading…'));
        runSearch(q).catch((e) => rhost.log.error('search failed', e));
        return;
      }
      selectProject(selected).catch((e) => rhost.log.error('select failed', e));
    }

    function renderTicket(t) {
      const wrap = el('div', 'tv-detail');
      wrap.appendChild(button('tv-back', '← Back', 'Back to the board', () => { goBack(); }));

      const head = el('div', 'tv-detail-head');
      head.appendChild(el('span', 'tv-id', t.id));
      head.appendChild(el('span', 'tv-detail-title', t.title));
      head.appendChild(el('span', 'tv-detail-state', t.state));
      head.appendChild(el('span', 'tv-assignee', t.shownFor || t.assignee || 'unassigned'));
      head.appendChild(el('span', 'tv-age', stamp(t.openedAt, 'opened')));
      if (t.closedAt !== null && t.closedAt !== undefined) head.appendChild(el('span', 'tv-age', stamp(t.closedAt, 'closed')));
      wrap.appendChild(head);

      wrap.appendChild(el('div', 'tv-section-head', 'Spec'));
      wrap.appendChild(specBlock(t.spec, 'no spec recorded for this ticket'));

      const respecs = Array.isArray(t.respecs) ? t.respecs : [];
      if (respecs.length) {
        wrap.appendChild(el('div', 'tv-section-head', `Respecs (${respecs.length})`));
        for (const r of respecs) {
          wrap.appendChild(el('div', 'tv-respec-at', stamp(r.at, 'respec\'d')));
          wrap.appendChild(specBlock(r.spec, 'no spec recorded for this respec'));
        }
      }

      const rounds = Array.isArray(t.rounds) ? t.rounds : [];
      wrap.appendChild(el('div', 'tv-section-head', `Review rounds (${rounds.length})`));
      if (!rounds.length) wrap.appendChild(el('div', 'tv-empty', 'no review rounds recorded'));
      else for (const r of rounds) wrap.appendChild(roundBlock(r));

      if (t.mergeMsg !== null && t.mergeMsg !== undefined) {
        wrap.appendChild(el('div', 'tv-section-head', 'Merge'));
        wrap.appendChild(el('pre', 'tv-spec', t.mergeMsg));
      }

      const art = el('div', t.taskDirPath ? 'tv-artifact' : 'tv-artifact tv-no-artifact',
        t.taskDirPath || 'no task directory in the spec');
      if (t.taskDirPath) art.title = t.taskDirPath;
      wrap.appendChild(art);
      return wrap;
    }

    async function renderDetail(project, id) {
      const my = ++selectSeq;
      const myReload = reloadSeq;
      clearBoardPane();
      const pane = el('div', 'tv-detail');
      pane.appendChild(el('div', 'tv-empty', 'Loading…'));
      boardPane.appendChild(pane);

      const res = await ask('ticket', { project, id });
      if (!alive() || my !== selectSeq || myReload !== reloadSeq) return;
      clearBoardPane();
      if (!res.ok || !res.ticket) {
        boardPane.appendChild(button('tv-back', '← Back', 'Back to the board', () => { goBack(); }));
        boardPane.appendChild(el('div', 'tv-error', `Could not read ${id}: ${res.error || 'unknown error'}`));
        return;
      }
      boardPane.appendChild(renderTicket(res.ticket));
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

      head.title = 'Click to open this ticket\'s history';
      head.addEventListener('click', () => {
        renderDetail(selected, t.id).catch((e) => rhost.log.error('detail failed', e));
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
      const spend = costText(t.cost);
      if (spend) {
        const cell = el('span', t.cost && t.cost.live ? 'tv-cost tv-cost-live' : 'tv-cost', spend);
        cell.title = costTitle(t.cost);
        meta.appendChild(cell);
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

    function renderBoard(res, cost) {
      mountBoardShell();
      editorEl = null;
      sectionsEl.innerHTML = '';
      if (!res.ok) {
        // Not the same as an empty board, and the difference is the whole
        // point: one says "nothing open", the other says "do not believe me".
        sectionsEl.appendChild(el('div', 'tv-error', `Could not read this project's tickets: ${res.error || 'unknown error'}`));
        return;
      }

      // The tickets read fine; the team.json beside them would not survive
      // core's loader. Shown above the board rather than in place of it — the
      // rows are real — but shown, because a team the app cannot resolve must
      // not look entirely healthy here.
      if (res.warning) {
        sectionsEl.appendChild(el('div', 'tv-warning', `This project's team manifest is unusable: ${res.warning}`));
      }

      const openHead = el('div', 'tv-section-head', `Open (${res.open.length})`);
      const teamTotal = teamCostText(cost);
      if (teamTotal) {
        const cell = el('span', 'tv-team-cost', teamTotal);
        cell.title = 'Everything this team has booked: tickets, review rounds and standing seats.';
        openHead.appendChild(cell);
      }
      // The one action that is not about an existing row, so it lives on the
      // section head rather than in the rows.
      openHead.appendChild(button('tv-btn tv-btn-primary tv-add', '+ New ticket',
        'Open a ticket on this board', () => openAdd()));
      sectionsEl.appendChild(openHead);

      if (!res.open.length) {
        sectionsEl.appendChild(el('div', 'tv-empty', 'No open tickets.'));
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
        for (const t of res.open) sectionsEl.appendChild(ticketRow({ ...t, now: res.now }));
      }

      const summary = summaryText(res.counts);
      if (summary) {
        const closedTotal = (res.counts.done || 0) + (res.counts.cancelled || 0);
        if (closedTotal > 0) {
          const line = el('div', 'tv-summary tv-summary-link', summary);
          line.setAttribute('role', 'button');
          line.tabIndex = 0;
          line.title = 'Browse closed tickets';
          line.addEventListener('click', () => {
            renderClosed(selected, { state: 'all', offset: 0 }).catch((e) => rhost.log.error('closed failed', e));
          });
          sectionsEl.appendChild(line);
        } else {
          sectionsEl.appendChild(el('div', 'tv-summary', summary));
        }
      }

      // Below the open list and visually quieter — present when wanted, never
      // competing with open work for the top of the pane.
      if (res.recent.length) {
        const head = el('div', 'tv-section-head tv-section-quiet',
          `Recently closed (last ${humanizeAge(res.counts.recentWindowMs)})`);
        if (res.counts.recentOver > 0) {
          head.appendChild(el('span', 'tv-stall-count', `+${res.counts.recentOver} more`));
        }
        sectionsEl.appendChild(head);
        for (const t of res.recent) {
          sectionsEl.appendChild(ticketRow({ ...t, now: res.now }, { closed: true }));
        }
      }
    }

    function hitRow(h) {
      const row = el('div', 'tv-ticket tv-hit');
      const head = el('div', 'tv-ticket-head');
      head.appendChild(el('span', 'tv-id', h.id));
      const titleSpan = el('span', 'tv-ticket-title', h.title);
      titleSpan.title = h.title;
      head.appendChild(titleSpan);
      head.title = 'Click to open this ticket\'s history';
      head.addEventListener('click', () => {
        renderDetail(selected, h.id).catch((e) => rhost.log.error('detail failed', e));
      });
      row.appendChild(head);

      const meta = el('div', 'tv-meta');
      meta.appendChild(el('span', 'tv-hit-state', h.state));
      const age = hitAgeText(h, Date.now());
      if (age) meta.appendChild(el('span', 'tv-age', age));
      row.appendChild(meta);

      row.appendChild(el('div', 'tv-snippet', h.snippet));
      return row;
    }

    function renderHits(res) {
      const keptEditor = editorEl;
      sectionsEl.innerHTML = '';
      editorEl = keptEditor;
      if (keptEditor) sectionsEl.appendChild(keptEditor);
      if (!res.ok) {
        sectionsEl.appendChild(el('div', 'tv-error', `Could not search this project: ${res.error || 'unknown error'}`));
        return;
      }
      const hits = Array.isArray(res.hits) ? res.hits : [];
      if (!hits.length) {
        sectionsEl.appendChild(el('div', 'tv-empty', 'no tickets match'));
        return;
      }
      const list = el('div', 'tv-hits');
      for (const h of hits) list.appendChild(hitRow(h));
      sectionsEl.appendChild(list);
    }

    function closedRow(r) {
      const row = el('div', 'tv-ticket tv-closed-row');
      const head = el('div', 'tv-ticket-head');
      head.appendChild(el('span', 'tv-id', r.id));
      const titleSpan = el('span', 'tv-ticket-title', r.title);
      titleSpan.title = r.title;
      head.appendChild(titleSpan);
      head.title = 'Click to open this ticket\'s history';
      head.addEventListener('click', () => {
        renderDetail(selected, r.id).catch((e) => rhost.log.error('detail failed', e));
      });
      row.appendChild(head);

      const meta = el('div', 'tv-meta');
      meta.appendChild(el('span', 'tv-hit-state', r.state));
      meta.appendChild(el('span', 'tv-assignee', r.assignee || 'unassigned'));
      const age = hitAgeText(r, Date.now());
      if (age) meta.appendChild(el('span', 'tv-age', age));
      if (r.verdict !== null && r.verdict !== undefined && r.verdict !== '') {
        meta.appendChild(el('span', verdictChipClass(r.verdict), r.verdict));
      }
      if (r.rounds > 0) meta.appendChild(el('span', 'tv-rounds', roundsText(r.rounds)));
      row.appendChild(meta);
      return row;
    }

    async function renderClosed(project, view) {
      const state = view && view.state ? view.state : 'all';
      const offset = view && view.offset ? view.offset : 0;
      closedView = { state, offset };
      const my = ++closedSeq;
      const mySelect = selectSeq;
      const myReload = reloadSeq;
      mountBoardShell();
      editorEl = null;
      sectionsEl.innerHTML = '';
      sectionsEl.appendChild(el('div', 'tv-empty', 'Loading…'));

      const res = await ask('closed', { project, state, offset, limit: CLOSED_PAGE_SIZE });
      if (!alive() || my !== closedSeq || mySelect !== selectSeq || myReload !== reloadSeq) return;

      sectionsEl.innerHTML = '';
      const head = el('div', 'tv-section-head tv-closed-head', 'Closed tickets');
      head.appendChild(button('tv-back', '← Back', 'Back to the board', () => {
        closedView = null;
        goBack();
      }));
      for (const [label, value] of [['All', 'all'], ['Done', 'done'], ['Cancelled', 'cancelled']]) {
        head.appendChild(button(value === state ? 'tv-filter tv-filter-active' : 'tv-filter', label,
          `Show ${label.toLowerCase()} tickets`, () => {
            renderClosed(project, { state: value, offset: 0 }).catch((e) => rhost.log.error('closed failed', e));
          }));
      }
      sectionsEl.appendChild(head);

      if (!res.ok) {
        sectionsEl.appendChild(el('div', 'tv-error', `Could not list closed tickets: ${res.error || 'unknown error'}`));
        return;
      }
      const rows = Array.isArray(res.rows) ? res.rows : [];
      if (!rows.length) {
        sectionsEl.appendChild(el('div', 'tv-empty', 'no closed tickets'));
        return;
      }
      const list = el('div', 'tv-hits');
      for (const r of rows) list.appendChild(closedRow(r));
      sectionsEl.appendChild(list);

      const pager = el('div', 'tv-pager', pagerText(res.offset, rows.length, res.total));
      const newer = button('tv-pager-btn', 'Newer', 'The previous page', () => {
        renderClosed(project, { state, offset: Math.max(0, res.offset - res.limit) })
          .catch((e) => rhost.log.error('closed failed', e));
      });
      newer.disabled = res.offset <= 0;
      const older = button('tv-pager-btn', 'Older', 'The next page', () => {
        renderClosed(project, { state, offset: res.offset + res.limit })
          .catch((e) => rhost.log.error('closed failed', e));
      });
      older.disabled = res.offset + rows.length >= res.total;
      pager.appendChild(newer);
      pager.appendChild(older);
      sectionsEl.appendChild(pager);
    }

    async function runSearch(q) {
      const my = ++searchSeq;
      const mySelect = selectSeq;
      const myReload = reloadSeq;
      const res = await ask('search', { project: selected, q });
      if (!alive() || my !== searchSeq || mySelect !== selectSeq || myReload !== reloadSeq) return;
      renderHits(res);
    }

    searchEl.addEventListener('input', () => {
      if (searchTimer !== null) clearTimeout(searchTimer);
      searchTimer = setTimeout(() => {
        searchTimer = null;
        const q = String(searchEl.value || '').trim();
        if (!q) {
          searchSeq += 1;
          if (selected) selectProject(selected).catch((e) => rhost.log.error('select failed', e));
          return;
        }
        runSearch(q).catch((e) => rhost.log.error('search failed', e));
      }, SEARCH_DEBOUNCE_MS);
    });

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
      closedView = null;
      for (const row of projectsPane.querySelectorAll('.tv-team-row')) {
        row.classList.toggle('tv-selected', row.dataset.tvProject === key);
      }
      mountBoardShell();
      editorEl = null;
      sectionsEl.innerHTML = '';
      sectionsEl.appendChild(el('div', 'tv-empty', 'Loading…'));
      // Both, together: the assign controls the board paints are only as good
      // as the session list beside them, and fetching them apart would let a
      // board render with a stale picker.
      const [res, live, cost] = await Promise.all([ask('board', key), ask('sessions'), ask('teamCost', key)]);
      if (!alive() || my !== selectSeq || myReload !== reloadSeq) return;
      // A failed session list is not a failed board: the rows are still worth
      // showing, with a picker that offers nothing. Same for the cost line.
      liveSessions = live.ok && Array.isArray(live.sessions) ? live.sessions : [];
      renderBoard(res, cost);
    }

    function renderProjects(res) {
      projectsPane.innerHTML = '';
      if (!res.ok) {
        projectsPane.appendChild(el('div', 'tv-error', `Could not read the projects directory: ${res.error || 'unknown error'}`));
        clearBoardPane();
        return;
      }
      const list = Array.isArray(res.projects) ? res.projects : [];
      if (!list.length) {
        projectsPane.appendChild(el('div', 'tv-empty', 'No projects yet.'));
        clearBoardPane();
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

    cancelPending = () => { if (searchTimer !== null) { clearTimeout(searchTimer); searchTimer = null; } };
    return () => { reload().catch((e) => rhost.log.error('reload failed', e)); };
  }

  rhost.ui.sidebar.footerButton({
    id: 'open',
    glyph: '▤',
    label: 'Tickets',
    tip: 'The project ticket board',
    onClick: () => surface.open(),
  });

  return () => { torn = true; if (cancelPending) cancelPending(); };
};
