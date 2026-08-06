'use strict';
// selection-view.js — what the drawer's selection inspector SAYS, given the
// main process's inspect() answer. Pure leaf: no DOM, so the judgement that
// matters here is testable.
//
// The judgement that matters is the DISAGREEMENT. Clodex's memo and the proxy's
// registry are two independent claims about the same thing, and the interesting
// state is when they differ:
//
//   proxy has it, memo does not  — a POST timed out, was rolled back, and
//     landed anyway. Measured 2026-08-06: three arms logged `timeout`, the memo
//     went empty, and the peek rode the next request. The status line said
//     nothing was armed WHILE text was being sent. This is the case the whole
//     inspector exists for, so it must be stated, not smoothed over.
//   memo has it, proxy does not  — ordinary and benign: a one-shot popped on
//     the last request. Reporting it as a fault would train the operator to
//     ignore the one above.
//
// So a mismatch is only ALARMING in one direction, and the direction is the
// information. Anything that renders both as "out of sync" throws it away.
//
// NEW leaf (not a renderer.js extraction), so — following the prefs-gate.js and
// tool-gate.js precedent — deliberately NOT added to
// test/free-identifier-leaks.test.js RENDERER_SCANNED_MODULES.

// hint-arm's channel. Named here so the inspector can label it rather than
// showing a raw id, and so a selection row is never confused for a memory one.
const MEMORY_HINT_ID = 'memory-context';
const PEEK_HINT_ID = 'operator-selection';

function bytes(n) {
  if (!Number.isFinite(n)) return '';
  return n < 1024 ? `${n} B` : `${(n / 1024).toFixed(1)} kB`;
}

// Seconds left, from the proxy's own age rather than a local clock: the two
// processes' clocks need not agree, and a negative number reads as a bug.
function remainingS(h) {
  if (!h || typeof h.ttlS !== 'number' || typeof h.ageS !== 'number') return null;
  return Math.max(0, Math.round(h.ttlS - h.ageS));
}

function fmtLeft(sec) {
  if (sec == null) return '';
  if (sec >= 60) return `${Math.round(sec / 60)}m left`;
  return `${sec}s left`;
}

// rows the popover renders, in the order it renders them. Each row is
// self-describing: kind drives the label and the styling, and `note` carries
// the one thing the operator could not work out from the text itself.
function buildRows(data) {
  if (!data) return { rows: [], note: 'No active session.' };
  if (!data.enabled) {
    return { rows: [], note: 'Sending selected text is off. Preferences → "Send text I select in the panel".' };
  }
  const rows = [];
  const proxyHints = (data.proxy && Array.isArray(data.proxy.hints)) ? data.proxy.hints : [];
  const byId = new Map(proxyHints.map((h) => [h.id, h]));

  // ── the peek, from the PROXY first ─────────────────────────────────────
  // The proxy's copy is the one that will actually ride, so it is the one
  // quoted. The memo is consulted only to describe a disagreement.
  const livePeek = byId.get(PEEK_HINT_ID) || null;
  const memoPeek = (data.local && data.local.peek) || null;
  if (livePeek) {
    rows.push({
      kind: 'peek',
      title: 'Selected text',
      text: livePeek.text,
      meta: [fmtLeft(remainingS(livePeek)), 'one-shot'].filter(Boolean).join(' · '),
      note: memoPeek ? '' : 'Clodex did not think this was armed — a POST timed out but landed.',
      warn: !memoPeek,
    });
  } else if (memoPeek) {
    // Benign by far the most often: it popped on the last request. Said
    // plainly so the alarming direction above stays distinguishable.
    rows.push({
      kind: 'peek-gone',
      title: 'Selected text',
      text: memoPeek.text,
      meta: 'delivered or expired',
      note: data.proxy && data.proxy.error
        ? `Could not check the proxy: ${data.proxy.error}`
        : 'The proxy no longer holds this — it rode a request, or its 2 minutes ran out.',
      warn: false,
    });
  }

  // ── attachments waiting in the queue file ──────────────────────────────
  const queued = Array.isArray(data.queued) ? data.queued : [];
  for (const text of queued) {
    rows.push({
      kind: 'attach',
      title: 'Copied text',
      text,
      meta: 'waiting for your next message',
      note: '',
      warn: false,
    });
  }
  // The file is the truth; `pending` is only what this process believes it
  // wrote. A drain between the two is the ordinary explanation and is not worth
  // a row of its own — but a pending list with an EMPTY file after no submit is
  // how a lost attachment would look, so the count is stated when they differ.
  const pending = (data.local && data.local.pending) || [];
  if (pending.length !== queued.length) {
    rows.push({
      kind: 'note',
      title: '',
      text: '',
      meta: '',
      note: `Clodex queued ${pending.length}, the file holds ${queued.length} — the hook drains on each message.`,
      warn: false,
    });
  }

  // ── the memory hint, which shares the same tail block ──────────────────
  // Not this feature's channel, and shown anyway: both land in the same
  // uncached tail on the same request, neither knows about the other, and the
  // operator has had no way to see them together.
  const mem = byId.get(MEMORY_HINT_ID);
  if (mem) {
    rows.push({
      kind: 'memory',
      title: 'Memory hint',
      text: mem.text,
      meta: [fmtLeft(remainingS(mem)), 'one-shot'].filter(Boolean).join(' · '),
      note: '',
      warn: false,
    });
  }

  // Anything else registered on the route — a probe, another tool. Unlabelled
  // rather than hidden: an unexplained hint riding the operator's requests is
  // exactly what they opened this to find.
  for (const h of proxyHints) {
    if (h.id === PEEK_HINT_ID || h.id === MEMORY_HINT_ID) continue;
    rows.push({
      kind: 'other',
      title: h.id,
      text: h.text,
      meta: [fmtLeft(remainingS(h)), h.turnStartOnly ? 'turn start' : ''].filter(Boolean).join(' · '),
      note: '',
      warn: false,
    });
  }

  if (rows.length) return { rows, note: '' };
  if (data.proxy && data.proxy.error) {
    return { rows, note: `Nothing queued. Could not reach the proxy: ${data.proxy.error}` };
  }
  if (data.proxy && !data.proxy.routed) {
    // Copy still works here — its channel is a file the CLI's own hook reads —
    // so this must not read as "the feature is off".
    return { rows, note: 'Nothing is riding. This session does not route through wirescope, so selecting will not send — Copy still will.' };
  }
  return { rows, note: 'Nothing is on its way to this agent.' };
}

// The header count: what would arrive if the agent were asked something RIGHT
// NOW. Deliberately counts the proxy's registrations and the file's lines, not
// the memo — the badge is the instrument's headline and inherits its rule.
function liveCount(data) {
  if (!data || !data.enabled) return 0;
  const hints = (data.proxy && Array.isArray(data.proxy.hints)) ? data.proxy.hints.length : 0;
  const queued = Array.isArray(data.queued) ? data.queued.length : 0;
  return hints + queued;
}

module.exports = { buildRows, liveCount, bytes, remainingS, fmtLeft, MEMORY_HINT_ID, PEEK_HINT_ID };
