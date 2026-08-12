'use strict';

/**
 * tickets-viewer — renderer half. Read-only board: teams on the left, the
 * selected team's open tickets on the right, recently-closed below them.
 *
 * Pull-on-open, no ambient state and no poll, matching memory-viewer: nothing
 * is read until the overlay is opened, and what you see is as of that moment.
 * A live board would need a watcher on every team's tickets.json for a surface
 * a user looks at for ten seconds at a time.
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

module.exports.humanizeAge = humanizeAge;
module.exports.ageLine = ageLine;
module.exports.summaryText = summaryText;

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

  function wire(rootEl) {
    rootEl.innerHTML = '';
    const modal = el('div', 'tv-modal');
    const topbar = el('div', 'tv-topbar');
    topbar.appendChild(el('div', 'tv-title', 'Tickets'));
    topbar.appendChild(el('div', 'tv-subtitle', 'read-only — open, assign and close with [agent:task …]'));
    const closeBtn = el('button', 'tv-close', '×');
    closeBtn.title = 'Close';
    closeBtn.addEventListener('click', () => surface.close());
    topbar.appendChild(closeBtn);

    const body = el('div', 'tv-body');
    const teamsPane = el('div', 'tv-teams');
    const boardPane = el('div', 'tv-board');
    body.appendChild(teamsPane);
    body.appendChild(boardPane);
    modal.appendChild(topbar);
    modal.appendChild(body);
    rootEl.appendChild(modal);

    let selected = null;
    let selectSeq = 0;
    let reloadSeq = 0;

    function ticketRow(t, opts) {
      const row = el('div', t.stalled ? 'tv-ticket tv-stalled' : 'tv-ticket');

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
      // different action for the lead (assign) than a stalled assigned one.
      const who = el('span', t.assignee ? 'tv-assignee' : 'tv-assignee tv-unassigned',
        t.shownFor || t.assignee || 'unassigned');
      meta.appendChild(who);
      meta.appendChild(el('span', 'tv-age', opts && opts.closed
        ? `closed ${t.closedAt === null ? 'at an unknown time' : `${humanizeAge(t.now - t.closedAt)} ago`}`
        : ageLine(t)));
      if (opts && opts.closed && t.closedBy) meta.appendChild(el('span', 'tv-closed-by', `by ${t.closedBy}`));
      if (t.stalled) {
        // Two different situations for the lead: nobody has chased this yet, or
        // the watchdog already did and it is still quiet.
        const flag = el('span', 'tv-stall-flag', t.nudged ? 'stalled · nudged' : 'stalled');
        flag.title = t.nudged
          ? 'Quiet past the team’s stall threshold; the watchdog has already nudged the seat once.'
          : 'Quiet past the team’s stall threshold.';
        meta.appendChild(flag);
      } else if (t.parked && !(opts && opts.closed)) {
        // Ahead of the backlog branch, and both are reachable: a parked ticket
        // can also be unassigned, and "parked" is the more specific of the two
        // (a decision the lead already made and can reverse) while "backlog"
        // reads as one nobody has made yet.
        const flag = el('span', 'tv-backlog-flag', 'parked');
        flag.title = 'Held out of dispatch by the lead. The seat has NOT been sent the spec; assign it to release.';
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
      row.appendChild(meta);

      // The artifact path is how a fresh seat recovers a dead worker's task, so
      // its ABSENCE is information: a ticket with no tasks/ dir in its spec has
      // nothing on disk to pick up, and a blank cell would read as a rendering
      // gap instead.
      const art = el('div', t.taskDir ? 'tv-artifact' : 'tv-artifact tv-no-artifact',
        t.taskDir || 'no task directory in the spec');
      if (t.taskDir) art.title = t.taskDir;
      row.appendChild(art);

      return row;
    }

    function renderBoard(res) {
      boardPane.innerHTML = '';
      if (!res.ok) {
        // Not the same as an empty board, and the difference is the whole
        // point: one says "nothing open", the other says "do not believe me".
        boardPane.appendChild(el('div', 'tv-error', `Could not read this team's tickets: ${res.error || 'unknown error'}`));
        return;
      }

      // The tickets read fine; the team.json beside them would not survive
      // core's loader. Shown above the board rather than in place of it — the
      // rows are real — but shown, because a team the app cannot resolve must
      // not look entirely healthy here.
      if (res.warning) {
        boardPane.appendChild(el('div', 'tv-warning', `This team’s manifest is unusable: ${res.warning}`));
      }

      const openHead = el('div', 'tv-section-head', `Open (${res.open.length})`);
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

    async function selectTeam(team) {
      // A monotonic token, not `selected !== team`: team identity cannot tell
      // two requests for the SAME team apart, and a reload during an in-flight
      // fetch makes that collision reachable.
      //
      // BOTH tokens are captured. A reload landing mid-fetch clears the pane and
      // starts its own select; gating on selectSeq alone lets this one's result
      // paint over that, so the board would show one team while the sidebar
      // highlights another.
      const my = ++selectSeq;
      const myReload = reloadSeq;
      selected = team;
      for (const row of teamsPane.querySelectorAll('.tv-team-row')) {
        row.classList.toggle('tv-selected', row.dataset.tvTeam === team);
      }
      boardPane.innerHTML = '';
      boardPane.appendChild(el('div', 'tv-empty', 'Loading…'));
      const res = await ask('board', team);
      if (!alive() || my !== selectSeq || myReload !== reloadSeq) return;
      renderBoard(res);
    }

    function renderTeams(res) {
      teamsPane.innerHTML = '';
      if (!res.ok) {
        teamsPane.appendChild(el('div', 'tv-error', `Could not read the teams directory: ${res.error || 'unknown error'}`));
        boardPane.innerHTML = '';
        return;
      }
      const list = Array.isArray(res.teams) ? res.teams : [];
      if (!list.length) {
        teamsPane.appendChild(el('div', 'tv-empty', 'No teams yet.'));
        boardPane.innerHTML = '';
        boardPane.appendChild(el('div', 'tv-empty', 'A team is created with [agent:team …]; tickets follow it.'));
        return;
      }
      for (const t of list) {
        const row = el('div', 'tv-team-row');
        row.dataset.tvTeam = t.team;
        row.appendChild(el('span', 'tv-team-name', t.team));
        if (t.error) {
          // The team is still selectable — the board pane repeats the reason in
          // full. What must not happen is this row looking like "0 open".
          const bad = el('span', 'tv-team-error', '!');
          bad.title = t.error;
          row.appendChild(bad);
        } else {
          if (t.warning) {
            // Distinct from the error marker above: the tickets ARE readable
            // here, so the row keeps its count. Only the manifest is bad.
            const warn = el('span', 'tv-team-warning', '⚠');
            warn.title = t.warning;
            row.appendChild(warn);
          }
          if (t.stalled) {
            const s = el('span', 'tv-team-stalled', String(t.stalled));
            s.title = `${t.stalled} open ticket(s) quiet past this team's stall threshold`;
            row.appendChild(s);
          }
          if (t.backlog) {
            // Its own chip, and deliberately not summed with the stalled one:
            // these two numbers ask the lead for different actions.
            const b = el('span', 'tv-team-backlog', String(t.backlog));
            b.title = `${t.backlog} open ticket(s) with no assignee — the watchdog never nudges these`;
            row.appendChild(b);
          }
          if (t.parked) {
            const p = el('span', 'tv-team-backlog', String(t.parked));
            p.title = `${t.parked} open ticket(s) parked — assigned or not, held out of dispatch until released`;
            row.appendChild(p);
          }
          row.appendChild(el('span', 'tv-team-count', `${t.open} open`));
        }
        row.addEventListener('click', () => {
          selectTeam(t.team).catch((e) => rhost.log.error('select failed', e));
        });
        teamsPane.appendChild(row);
      }
      if (!selected || !list.some((t) => t.team === selected)) {
        selected = list[0].team;
      }
      selectTeam(selected).catch((e) => rhost.log.error('select failed', e));
    }

    async function reload() {
      const my = ++reloadSeq;
      teamsPane.innerHTML = '';
      teamsPane.appendChild(el('div', 'tv-empty', 'Loading…'));
      const res = await ask('teams');
      if (!alive() || my !== reloadSeq) return;
      renderTeams(res);
    }

    return () => { reload().catch((e) => rhost.log.error('reload failed', e)); };
  }

  rhost.ui.sidebar.footerButton({
    id: 'open',
    glyph: '▤',
    label: 'Tickets',
    tip: 'The team ticket board',
    onClick: () => surface.open(),
  });

  return () => { torn = true; };
};
