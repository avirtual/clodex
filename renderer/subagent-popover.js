// subagent-popover.js — the on-demand live-activity popover for one subagent
// child row. Polls /_subagents (via main) while open and renders an appending
// feed of the turns it catches. Self-contained: no core-state Maps — the opener
// passes name/key/anchorRow, and everything else is the popover's own DOM +
// window.api. Imports esc/fmtCountdown from lib/format.
//
// The parent's child-row list (applySubagents / subagentRows) stays in
// renderer.js — it is core tab rendering (sessionList/proxyState). It reaches
// this island only through the returned open/close + three predicates that read
// the popover's DOM state without touching the element directly.
//
// DOM-bound, so no unit tests per the R1 rule — move-only fidelity is the
// guarantee.

const { esc, fmtCountdown } = require('./lib/format');

function initSubagentPopover() {
  // --- Subagent live-activity popover ------------------------------------------
  // On-demand detail for one child row. Polls /_subagents (via main) every
  // SUBAGENT_DETAIL_MS while open — NEVER folded into the 5s session poll, the
  // request body it reads is heavy. Shows at most one-turn-stale activity (the
  // in-flight token stream isn't on the wire as a request body until the next
  // turn); `turn_ts` lets us label it honestly as "as of Ns ago".
  const subagentPopover = document.getElementById('subagent-popover');
  const subagentPopoverName = document.getElementById('subagent-popover-name');
  const subagentPopoverBody = document.getElementById('subagent-popover-body');
  const SUBAGENT_DETAIL_MS = 1500;
  let subagentPollTimer = null;

  // Accumulating live feed. The detail endpoint only ever returns the latest
  // COMPLETED turn (keyed by turn_ts), so instead of replacing the body each poll
  // we dedup by turn_ts and APPEND each newly-seen turn as an entry — the popover
  // reads as a running log of what the sub did, not a slideshow. Honest caveat:
  // we only observe the latest completed turn per poll, so a sub that finishes
  // several turns faster than our 1.5s cadence will skip the in-between ones — the
  // feed is "the turns we caught", not a guaranteed-complete transcript.
  let subagentFeed = [];           // [{ ts, tool, toolInput, truncated, text }]
  let subagentFeedSeen = new Set(); // turn signatures already appended
  let subagentFeedMeta = null;      // { role, model } captured once
  let subagentFeedEnded = false;    // session went cold — stop, but keep history

  function resetSubagentFeed() {
    subagentFeed = [];
    subagentFeedSeen = new Set();
    subagentFeedMeta = null;
    subagentFeedEnded = false;
  }

  function closeSubagentPopover() {
    if (subagentPollTimer) { clearInterval(subagentPollTimer); subagentPollTimer = null; }
    subagentPopover.classList.add('hidden');
    subagentPopover.dataset.name = '';
    subagentPopover.dataset.key = '';
    resetSubagentFeed();
  }

  function openSubagentPopover(name, key, anchorRow) {
    // Toggle off if re-clicking the same row.
    if (!subagentPopover.classList.contains('hidden')
        && subagentPopover.dataset.name === name && subagentPopover.dataset.key === key) {
      return closeSubagentPopover();
    }
    if (subagentPollTimer) { clearInterval(subagentPollTimer); subagentPollTimer = null; }
    subagentPopover.dataset.name = name;
    subagentPopover.dataset.key = key;
    resetSubagentFeed();
    const label = anchorRow.querySelector('.child-label')?.textContent || key;
    subagentPopoverName.textContent = label;
    subagentPopoverBody.innerHTML = '<div class="subagent-detail-empty">Loading…</div>';
    subagentPopover.classList.remove('hidden');
    // Anchor to the row, clamped to the viewport (mirrors the other popovers).
    // The box can be tall (content-driven, up to 78vh), so clamp top by the box's
    // actual height — not a fixed 60px — or a popover opened from a low row would
    // spill off the bottom edge.
    const r = anchorRow.getBoundingClientRect();
    const w = subagentPopover.offsetWidth || 760;
    // Reserve the box's MAX possible height (CSS max-height is 78vh): offsetHeight
    // here is just the "Loading…" stub, and the box grows downward as content
    // arrives anchored at this top, so clamping by the stub height would let a
    // fully-loaded popover spill off the bottom. Budget the worst case so even a
    // full-height box fits; a short popover just sits a little higher (harmless).
    const hMax = window.innerHeight * 0.78;
    subagentPopover.style.left = `${Math.max(8, Math.min(r.right + 6, window.innerWidth - w - 8))}px`;
    subagentPopover.style.top = `${Math.max(8, Math.min(r.top, window.innerHeight - hMax - 8))}px`;
    subagentPopover.style.bottom = 'auto';
    const poll = () => fetchSubagentDetail(name, key);
    poll();
    subagentPollTimer = setInterval(poll, SUBAGENT_DETAIL_MS);
  }

  async function fetchSubagentDetail(name, key) {
    // Bail if the popover was closed / retargeted while a fetch was in flight.
    const stillOpen = () => subagentPopover.dataset.name === name && subagentPopover.dataset.key === key
      && !subagentPopover.classList.contains('hidden');
    if (!stillOpen()) return;
    let res;
    try { res = await window.api.getProxySubagentDetail(name, key, 800); }
    catch (e) { res = { ok: false, error: String(e) }; }
    if (!stillOpen()) return;
    if (!res || !res.ok) {
      // Transient fetch error — only show it if we have no history to preserve.
      if (!subagentFeed.length) {
        subagentPopoverBody.innerHTML = `<div class="subagent-detail-empty">${esc(res && res.error ? res.error : 'unavailable')}</div>`;
      }
      return;
    }
    const d = res.data || {};
    if (d.found === false) {
      // A missing child mid-stream: once we've accumulated history, keep showing
      // it rather than wiping the feed. session_cold means the in-memory bodies are
      // gone, so stop polling — but leave the captured log on screen with an end
      // note. With no history yet, fall back to the plain reason message.
      if (subagentFeed.length) {
        if (d.reason === 'session_cold' && !subagentFeedEnded) {
          subagentFeedEnded = true;
          if (subagentPollTimer) { clearInterval(subagentPollTimer); subagentPollTimer = null; }
          renderSubagentFeed();
        }
        return;
      }
      const reason = d.reason === 'session_cold' ? 'Session ended — no live activity.'
        : d.reason === 'no_request_body' ? 'No activity captured yet.'
        : 'Subagent is no longer tracked.';
      subagentPopoverBody.innerHTML = `<div class="subagent-detail-empty">${esc(reason)}</div>`;
      if (d.reason === 'session_cold') closeSubagentPopover();
      return;
    }
    // Append this turn if it's new, then re-render. Keep the view pinned to the
    // bottom when a fresh turn lands or the user is already there; otherwise leave
    // their scroll position alone so they can read back through earlier turns.
    const appended = ingestSubagentTurn(d);
    const sc = subagentPopoverBody;
    const nearBottom = sc.scrollHeight - sc.scrollTop - sc.clientHeight < 40;
    renderSubagentFeed();
    if (appended || nearBottom) sc.scrollTop = sc.scrollHeight;
  }

  // Fold one detail response into the feed. Dedup by turn_ts (the per-turn key);
  // without one, fall back to a content signature so identical repeats don't pile
  // up. Returns true iff a new entry was appended.
  function ingestSubagentTurn(d) {
    if (!subagentFeedMeta && (d.role || d.model)) {
      subagentFeedMeta = { role: d.role || null, model: d.model || null };
    }
    if (!d.last_tool && !d.last_text) return false; // nothing to show this turn
    const sig = (typeof d.turn_ts === 'number')
      ? `t:${d.turn_ts}`
      : `c:${d.last_tool || ''}|${(d.last_text || '').slice(0, 80)}`;
    if (subagentFeedSeen.has(sig)) return false;
    subagentFeedSeen.add(sig);
    subagentFeed.push({
      ts: typeof d.turn_ts === 'number' ? d.turn_ts : null,
      tool: d.last_tool || null,
      toolInput: d.last_tool_input || null,
      truncated: !!d.truncated,
      text: d.last_text || null,
    });
    return true;
  }

  // Pull a compact one-line preview out of a tool_use input object. The keys are
  // whatever the model emitted (wirescope forwards it verbatim) so we probe the
  // common primaries and fall back to compact JSON — always truncating on render
  // since an unexpected key could be large even past the server-side maxlen clamp.
  function subagentToolPreview(input) {
    if (!input || typeof input !== 'object') return '';
    for (const k of ['command', 'file_path', 'path', 'pattern', 'query', 'url', 'prompt', 'description']) {
      if (typeof input[k] === 'string' && input[k]) return input[k];
    }
    try { return JSON.stringify(input); } catch { return ''; }
  }

  function renderSubagentFeed() {
    const parts = [];
    if (subagentFeedMeta) {
      const meta = [];
      if (subagentFeedMeta.role) meta.push(esc(subagentFeedMeta.role));
      if (subagentFeedMeta.model) meta.push(esc(subagentFeedMeta.model));
      if (meta.length) parts.push(`<div class="subagent-detail-meta">${meta.join(' · ')}</div>`);
    }
    if (!subagentFeed.length) {
      parts.push('<div class="subagent-detail-empty">No activity captured yet.</div>');
      subagentPopoverBody.innerHTML = parts.join('');
      return;
    }
    subagentFeed.forEach((e) => {
      const entry = [];
      if (e.tool) {
        const preview = subagentToolPreview(e.toolInput);
        const clamped = preview.length > 600 ? preview.slice(0, 600) + '…' : preview;
        // Tool name is the colored first word, args flow inline after it: "Read: …".
        const nameTxt = clamped ? `${esc(e.tool)}:` : esc(e.tool);
        entry.push(`<div class="subagent-detail-tool"><span class="subagent-tool-name">${nameTxt}</span>` +
          (clamped ? ` <span class="subagent-tool-arg">${esc(clamped)}</span>` : '') + '</div>');
        if (e.truncated) entry.push('<div class="subagent-detail-note">(arguments truncated)</div>');
      }
      if (e.text) {
        const t = e.text.length > 1200 ? e.text.slice(0, 1200) + '…' : e.text;
        entry.push(`<div class="subagent-detail-text">${esc(t)}</div>`);
      }
      parts.push(`<div class="subagent-feed-entry">${entry.join('')}</div>`);
    });
    // One timestamp for the whole feed, on the latest turn — reads as a live
    // conversation rather than a stack of separately-stamped segments.
    const latest = subagentFeed[subagentFeed.length - 1];
    if (latest && latest.ts != null) {
      const agoS = Math.max(0, Math.round(Date.now() / 1000 - latest.ts));
      parts.push(`<div class="subagent-detail-asof">${fmtCountdown(agoS)} ago</div>`);
    }
    if (subagentFeedEnded) {
      parts.push('<div class="subagent-detail-note">Session ended — no further activity.</div>');
    }
    subagentPopoverBody.innerHTML = parts.join('');
  }

  document.getElementById('subagent-popover-close').addEventListener('click', closeSubagentPopover);
  document.addEventListener('click', (e) => {
    if (subagentPopover.classList.contains('hidden')) return;
    if (subagentPopover.contains(e.target)) return;
    if (e.target.closest('.session-child')) return; // row clicks toggle themselves
    closeSubagentPopover();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !subagentPopover.classList.contains('hidden')) closeSubagentPopover();
  });
  // Predicates for the external spots that read the popover's DOM state.
  const isSubagentPopoverForParent = (name) => subagentPopover.dataset.name === name;
  const isSubagentPopoverOpen = () => !subagentPopover.classList.contains('hidden');
  const subagentPopoverKeyForParent = (name) =>
    (subagentPopover.dataset.name === name ? subagentPopover.dataset.key : '');

  return {
    openSubagentPopover, closeSubagentPopover,
    isSubagentPopoverForParent, isSubagentPopoverOpen, subagentPopoverKeyForParent,
  };
}

module.exports = { initSubagentPopover };
