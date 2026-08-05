// activity-tab.js — the drawer's `activity` tenant: a persistent view of what
// the window's Task subagents are doing. Replaces subagent-popover.js, whose
// feed died the moment the operator clicked anywhere else.
//
// COST INVARIANT, the thing not to regress: chips ride the 5s `session-proxy`
// payload the renderer already receives, so they are free. The DETAIL endpoint
// (`/_subagents` via proxy:subagentDetail) reads heavy request bodies and was
// deliberately kept off that cheap path — so it is fetched for exactly ONE feed,
// the selected one, and only while this tab is visible. A hidden or collapsed
// Activity tab polls nothing.
//
// That gating is the host's `onShow`/`onHide` pair and NOTHING ELSE. The host
// guarantees those are strictly alternating at-most-once edges (drawer-host.js
// rule 2), so the interval is acquired in one and released in the other with no
// idempotence here: a second guard would silently absorb a host regression
// instead of leaking a visible timer, which is the opposite of what the
// contract is for.
//
// DOM-bound, so no unit tests per the R1 rule — the feed state machine and the
// live/done/drop policy live in lib/ where they are tested.

const { esc, fmtCountdown, fmtUsd } = require('./lib/format');
const { createSubagentFeed, toolPreview } = require('./lib/subagent-feed');
const { classifySubagent } = require('./lib/subagent-policy');

const DETAIL_MS = 1500;   // the popover's cadence, unchanged
const DETAIL_MAXLEN = 800; // server-side clamp, unchanged
const TOOL_ARG_MAX = 600;
const TEXT_MAX = 1200;
// Feeds outlive their subagents on purpose (history is the point), so memory is
// bounded here: the oldest feeds that are neither live nor selected are evicted.
// A SOFT cap, not a guarantee — `pruneFeeds` skips live and selected feeds, so
// 40 concurrently-live subagents hold 40 feeds. `notified` is looser still: it
// is only ever cleaned by `dropParent`.
const MAX_RETAINED_FEEDS = 20;

// One key space for both halves of the UI — a chip and its feed must agree, and
// a parent session name plus a child key is the only identifier the wire gives.
// The space is a safe separator BECAUSE session names cannot contain one
// (`[a-zA-Z0-9._-]{1,64}`), which is also what makes `dropParent`'s prefix match
// exact rather than a guess.
const feedKeyOf = (name, key) => `${name} ${key}`;

function createActivityTab({ host, proxyState, proxyPollMs }) {
  let chipsEl = null;
  let bodyEl = null;
  let asOfEl = null;
  let notify = () => {};

  const feeds = new Map();      // feedKey -> { name, key, label, feed }
  const notified = new Set();   // child keys already badged (once per subagent)
  // feedKey -> a monotonic stamp taken when the key is FIRST observed. The chip
  // strip orders by this and never by anything the wire controls: the payload
  // arrives in RECENCY order (proxylab meta.py sorts sub_agents by last_seen
  // descending) and that order permutes every time two subs take turns, so
  // rendering it directly makes chips trade places under the operator's cursor
  // every 5s. Position is an operator affordance — you learn where a chip is —
  // and it must be stable for the life of the window, including after the sub
  // ends. Never renumbered, so an ended chip keeps its slot.
  const firstSeen = new Map();
  let seenSeq = 0;
  function stamp(fk) {
    if (!firstSeen.has(fk)) firstSeen.set(fk, ++seenSeq);
    return firstSeen.get(fk);
  }
  let selected = null;          // feedKey | null
  let pollTimer = null;
  let tickTimer = null;
  let gen = 0;                  // bumped per poll lifetime; see fetchDetail

  // Live subagents across the window, classified through the one shared policy.
  // Insertion order is parent-then-payload order, which is what the chip strip
  // renders — subagents of one session stay together.
  function liveSubs() {
    const out = new Map(); // feedKey -> { name, key, label, state, sub }
    for (const [name, st] of proxyState) {
      const p = st && st.payload;
      const ageS = st ? (Date.now() - st.at) / 1000 : 0;
      // Same deadness rule as the sidebar: a payload older than four poll
      // intervals is not evidence of anything, so it contributes no chips.
      if (!p || !p.linked || ageS > proxyPollMs * 4 / 1000) continue;
      if (!Array.isArray(p.subagents)) continue;
      for (const sub of p.subagents) {
        const state = classifySubagent(sub, ageS);
        if (!state) continue;
        out.set(feedKeyOf(name, sub.key), {
          name, key: sub.key, label: sub.label || sub.key, state, sub,
        });
      }
    }
    return out;
  }

  function feedFor(name, key, label) {
    const fk = feedKeyOf(name, key);
    stamp(fk);
    let rec = feeds.get(fk);
    if (!rec) {
      rec = { name, key, label: label || key, feed: createSubagentFeed() };
      feeds.set(fk, rec);
    } else if (label) {
      rec.label = label; // the wire's label can arrive after the first turn
    }
    return rec;
  }

  // Evict oldest-first, skipping anything live or on screen. Called after every
  // chip render, so a long session cannot accumulate feeds without bound.
  function pruneFeeds(live) {
    if (feeds.size <= MAX_RETAINED_FEEDS) return;
    for (const fk of feeds.keys()) {
      if (feeds.size <= MAX_RETAINED_FEEDS) break;
      if (fk === selected || live.has(fk)) continue;
      feeds.delete(fk);
    }
  }

  // --- rendering -------------------------------------------------------------

  function chipState(fk, live) {
    const rec = feeds.get(fk);
    // `ended` outranks the aging policy: session_cold means the proxy has
    // dropped the bodies, so no further turn can ever arrive regardless of how
    // recently the sub was seen.
    if (rec && rec.feed.ended()) return 'ended';
    const l = live.get(fk);
    return l ? l.state : 'ended';
  }

  // Badge accounting, deliberately DOM-FREE and ahead of the mount guard below.
  // The host mounts only the first registered tenant, and this one registers
  // second — so on a fresh window the pane does not exist until the operator
  // selects the tab. A badge that only counts once you have looked at the tab is
  // the feature inverted: its whole job is to report the tab you are NOT on.
  function noticeSubs(live) {
    for (const [fk, l] of live) {
      // Stamped HERE, in payload-iteration order, rather than lazily in the sort
      // comparator: a comparator assigns in whatever order it happens to visit
      // pairs, which would make the very first ordering depend on the sort
      // algorithm. This also runs while the pane is unmounted, so a sub observed
      // before the operator ever opened the tab still keeps its slot.
      stamp(fk);
      if (!notified.has(fk)) {
        notified.add(fk);
        // Once per SUBAGENT, never per turn: a badge that counted turns would
        // tick several times a minute per sub and stop meaning anything.
        notify('activity');
      }
      if (feeds.has(fk)) feedFor(l.name, l.key, l.label); // keep the label fresh
    }
  }

  function buildChip(fk, meta) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'activity-chip';
    chip.dataset.fk = fk;
    chip.innerHTML = '<span class="activity-chip-dot"></span>'
      + '<span class="activity-chip-parent"></span>'
      + '<span class="activity-chip-label"></span>';
    // Reads the CURRENT record at click time: the element outlives any single
    // render, so a captured label would go stale the first time the wire sends
    // a better one.
    chip.addEventListener('click', (e) => {
      e.stopPropagation();
      const rec = feeds.get(fk) || meta;
      selectFeed(fk, rec.name, rec.key, rec.label);
    });
    return chip;
  }

  function updateChip(chip, fk, meta, live) {
    const l = live.get(fk);
    const sub = l && l.sub;
    chip.dataset.state = chipState(fk, live);
    chip.classList.toggle('selected', fk === selected);
    const costTxt = sub && typeof sub.estUsd === 'number' ? `~${fmtUsd(sub.estUsd)}` : '';
    chip.title = `${meta.name} ▸ ${meta.label}`
      + `${sub && sub.model ? ' · ' + sub.model : ''}`
      + `${sub && sub.requests ? ' · ' + sub.requests + ' turn' + (sub.requests === 1 ? '' : 's') : ''}`
      + `${costTxt ? ' · ' + costTxt : ''}`;
    chip.querySelector('.activity-chip-parent').textContent = meta.name;
    chip.querySelector('.activity-chip-label').textContent = meta.label;
  }

  function renderChips() {
    const live = liveSubs();
    noticeSubs(live);
    pruneFeeds(live);
    if (!chipsEl) return; // unmounted — the badge accounting above still ran

    // Chips = live subs, plus any feed with retained history that is no longer
    // live. An aged-out sub keeps its chip (styled `ended`) rather than
    // vanishing while its history is still on screen.
    //
    // Sorted by first-seen stamp, NOT by the order either source iterates in:
    // `live` carries the wire's recency order, and `feeds` is insertion-ordered
    // but loses its place when pruneFeeds evicts. Ascending = oldest chip
    // leftmost, so a new sub appears at the end and nothing already on screen
    // moves.
    const keys = [...new Set([...live.keys(), ...feeds.keys()])]
      .sort((a, b) => stamp(a) - stamp(b));

    let empty = chipsEl.querySelector('.activity-chips-empty');
    if (!keys.length) {
      chipsEl.querySelectorAll('.activity-chip').forEach((el) => el.remove());
      if (!empty) {
        empty = document.createElement('div');
        empty.className = 'activity-chips-empty';
        empty.textContent = 'No subagents running.';
        chipsEl.appendChild(empty);
      }
      return;
    }
    if (empty) empty.remove();

    // Reconcile by key rather than rebuilding: this runs every 5s, and replacing
    // the strip would reset its horizontal scroll and blur a focused chip
    // underneath the operator. Same trick as the sidebar's child rows.
    const have = new Map();
    chipsEl.querySelectorAll('.activity-chip').forEach((el) => have.set(el.dataset.fk, el));
    let anchor = null;
    for (const fk of keys) {
      const meta = live.get(fk) || feeds.get(fk);
      const chip = have.get(fk) || buildChip(fk, meta);
      updateChip(chip, fk, meta, live);
      const next = anchor ? anchor.nextSibling : chipsEl.firstChild;
      if (next !== chip) chipsEl.insertBefore(chip, next);
      anchor = chip;
    }
    const keep = new Set(keys);
    for (const [fk, el] of have) { if (!keep.has(fk)) el.remove(); }
  }

  function renderFeed() {
    if (!bodyEl) return;
    const rec = selected && feeds.get(selected);
    if (!rec) {
      bodyEl.innerHTML = '<div class="subagent-detail-empty">'
        + 'Select a subagent above to follow what it is doing.</div>';
      renderAsOf();
      return;
    }

    const parts = [];
    const meta = rec.feed.meta();
    if (meta) {
      const bits = [];
      if (meta.role) bits.push(esc(meta.role));
      if (meta.model) bits.push(esc(meta.model));
      if (bits.length) parts.push(`<div class="subagent-detail-meta">${bits.join(' · ')}</div>`);
    }

    const entries = rec.feed.entries();
    if (!entries.length) {
      const reason = rec.feed.reason();
      const msg = reason === 'session_cold' ? 'Session ended — no activity was captured.'
        : reason === 'no_request_body' ? 'No activity captured yet.'
        : reason ? 'Subagent is no longer tracked.'
        : 'No activity captured yet.';
      parts.push(`<div class="subagent-detail-empty">${esc(msg)}</div>`);
    }

    for (const e of entries) {
      const entry = [];
      if (e.tool) {
        const preview = toolPreview(e.toolInput);
        const clamped = preview.length > TOOL_ARG_MAX ? preview.slice(0, TOOL_ARG_MAX) + '…' : preview;
        // Tool name is the colored first word, args flow inline after it: "Read: …".
        const nameTxt = clamped ? `${esc(e.tool)}:` : esc(e.tool);
        entry.push(`<div class="subagent-detail-tool"><span class="subagent-tool-name">${nameTxt}</span>`
          + (clamped ? ` <span class="subagent-tool-arg">${esc(clamped)}</span>` : '') + '</div>');
        if (e.truncated) entry.push('<div class="subagent-detail-note">(arguments truncated)</div>');
      }
      if (e.text) {
        const t = e.text.length > TEXT_MAX ? e.text.slice(0, TEXT_MAX) + '…' : e.text;
        entry.push(`<div class="subagent-detail-text">${esc(t)}</div>`);
      }
      parts.push(`<div class="subagent-feed-entry">${entry.join('')}</div>`);
    }

    if (rec.feed.ended()) {
      parts.push('<div class="subagent-detail-note">Session ended — no further activity.</div>');
    }
    bodyEl.innerHTML = parts.join('');
    renderAsOf();
  }

  // The honest half of the footer. The timestamp is server data (`turn_ts`) and
  // the countdown is client math, so this ticks once a second at ZERO fetch
  // cost — and it is the only motion in the tab. A spinner or a "live" pulse
  // would claim a liveness the pipe cannot deliver: the endpoint publishes a
  // turn only once that turn has COMPLETED.
  function renderAsOf() {
    if (!asOfEl) return;
    const rec = selected && feeds.get(selected);
    const entries = rec ? rec.feed.entries() : [];
    const latest = entries[entries.length - 1];
    if (!latest || latest.ts == null) { asOfEl.textContent = ''; return; }
    const agoS = Math.max(0, Math.round(Date.now() / 1000 - latest.ts));
    asOfEl.textContent = `last turn ${fmtCountdown(agoS)} ago`;
  }

  // --- polling ---------------------------------------------------------------

  async function fetchDetail() {
    const fk = selected;
    if (!fk) return;
    const rec = feeds.get(fk);
    if (!rec || rec.feed.ended()) return; // cold session: nothing more will arrive
    const myGen = gen;

    let res;
    try { res = await window.api.getProxySubagentDetail(rec.name, rec.key, DETAIL_MAXLEN); }
    catch (e) { res = { ok: false, error: String(e) }; }

    // The await straddles a possible hide, re-selection, or hide-then-show.
    // `pollTimer` alone would let a pre-hide response paint against a NEW poll
    // that has already ingested a newer turn — the stale turn would then append
    // after it and the feed would read out of order. `gen` is what makes the
    // check identify THIS poll rather than merely "some poll is running"; none
    // of the three is a re-entry guard on the host's onShow/onHide edges.
    if (!pollTimer || selected !== fk || myGen !== gen) return;

    if (!res || !res.ok) {
      // Transient fetch error: only surface it when there is no history to lose.
      if (!rec.feed.entries().length) {
        bodyEl.innerHTML = `<div class="subagent-detail-empty">${esc(res && res.error ? res.error : 'unavailable')}</div>`;
      }
      return;
    }

    // Re-render ONLY on a real change. The endpoint's steady state is the same
    // latest turn repeated every 1.5s, so `appended` is false most polls — and
    // renderFeed replaces the pane's children, which collapses scrollHeight and
    // clamps scrollTop to 0. Rendering unconditionally would yank an operator
    // who scrolled up to read history back to the top ~40 times a minute, which
    // is the one thing this tab exists to make possible. It also avoids
    // rebuilding up to 500 entries against the session terminal's main thread.
    const hadMeta = !!rec.feed.meta();
    const wasEnded = rec.feed.ended();
    const { appended } = rec.feed.ingest(res.data || {});
    const metaArrived = !hadMeta && !!rec.feed.meta();
    const endedFlipped = !wasEnded && rec.feed.ended();
    if (!appended && !metaArrived && !endedFlipped) return;

    // Keep the view pinned to the bottom when a fresh turn lands or the operator
    // is already there; otherwise leave their scroll alone so they can read back.
    const nearBottom = bodyEl.scrollHeight - bodyEl.scrollTop - bodyEl.clientHeight < 40;
    renderFeed();
    if (appended || nearBottom) bodyEl.scrollTop = bodyEl.scrollHeight;
    // The chip carries the ended state, and the flip arrives on a poll that
    // appended nothing (session_cold has no turn) — so this must not hang off
    // `appended`.
    if (endedFlipped) renderChips();
  }

  function startPolling() {
    gen++;
    fetchDetail();
    pollTimer = setInterval(fetchDetail, DETAIL_MS);
    tickTimer = setInterval(renderAsOf, 1000);
  }

  function stopPolling() {
    clearInterval(pollTimer); pollTimer = null;
    clearInterval(tickTimer); tickTimer = null;
  }

  // --- the tenant ------------------------------------------------------------

  function mount(pane) {
    // DOM only — the pane has no geometry yet (host rule 4). The one layout
    // write is the scroll-to-bottom in onShow, which is safe mid-transition
    // precisely because it is NOT a measurement: `scrollTop = scrollHeight` is
    // clamped by the browser, so it stays pinned to the bottom as the drawer
    // finishes opening. A tenant that computed rows from the box (the terminal)
    // would have to do that in onResize instead.
    pane.innerHTML = `
      <div class="activity-chips"></div>
      <div class="activity-body"></div>
      <div class="activity-footer">
        <span class="activity-boundary">updates at turn boundaries — the in-flight stream is not on the wire</span>
        <span class="activity-asof"></span>
      </div>`;
    chipsEl = pane.querySelector('.activity-chips');
    bodyEl = pane.querySelector('.activity-body');
    asOfEl = pane.querySelector('.activity-asof');
    renderChips();
    renderFeed();
  }

  notify = host.register({
    id: 'activity',
    label: 'Activity',
    available: () => true,
    mount,
    onShow() {
      renderChips();
      renderFeed();
      bodyEl.scrollTop = bodyEl.scrollHeight;
      startPolling();
    },
    onHide: stopPolling,
  });

  // --- surface for renderer.js ----------------------------------------------

  function selectFeed(fk, name, key, label) {
    if (selected === fk) return;
    selected = fk;
    feedFor(name, key, label);
    renderChips();
    renderFeed();
    if (bodyEl) bodyEl.scrollTop = bodyEl.scrollHeight;
    // A selection change mid-poll must not wait out the interval: the previous
    // feed's in-flight response is discarded by the `selected !== fk` check.
    if (pollTimer) fetchDetail();
  }

  // Child-row click. Opens the drawer on this tab — the one place the tenant
  // asks the host for attention, and it is operator-initiated (there is no
  // auto-expand on traffic anywhere in the drawer).
  function openActivityFeed(name, key, label) {
    selectFeed(feedKeyOf(name, key), name, key, label);
    host.open('activity');
  }

  // The parent session is gone from the sidebar: its feeds can never update
  // again and holding their history would be holding it forever.
  function dropParent(name) {
    for (const [fk, rec] of feeds) {
      if (rec.name !== name) continue;
      feeds.delete(fk);
      if (selected === fk) { selected = null; renderFeed(); }
    }
    for (const fk of [...notified]) {
      if (fk.startsWith(`${name} `)) notified.delete(fk);
    }
    // Same cleanup as `notified`, and for the same reason: the parent is gone,
    // so these keys can never be observed again. `seenSeq` is deliberately NOT
    // rewound — reusing a stamp would place a future chip in a dead one's slot.
    for (const fk of [...firstSeen.keys()]) {
      if (fk.startsWith(`${name} `)) firstSeen.delete(fk);
    }
    renderChips();
  }

  return { openActivityFeed, refreshChips: renderChips, dropParent };
}

module.exports = { createActivityTab };
