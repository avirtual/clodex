// body-preview.js — one-line preview of a stored intent body, for readouts
// (remind list, memory list, the memory digest index, notify-user).
//
// WHY THIS IS NOT `body.split('\n')[0]`. The greedy body assembly in
// session-manager.js (`_scanJsonlText`'s intent loop) joins the intent line's
// trailing text to the following lines with a newline. When the intent line
// carries NO trailing text — the `[agent:remind in 1m]` + body-on-next-lines
// shape — that first fragment is empty, so a fully intact body is stored with a
// LEADING newline. Taking line 0 of that yields `''`, and every readout then
// reports present data as absent.
//
// That failure is worse than a cosmetic one: a blank row does not look broken,
// it looks like an empty body. It has already taught a false standing rule
// once ("bodies on following lines are silently dropped" — they are not; they
// are stored complete and fire complete).
//
// The storage is deliberately left alone. A body whose first line is empty is a
// faithful record of what was written, and nine greedy verbs plus the message
// spill, the memory store and ticket spec bodies consume that exact shape.
//
// Whitespace-only input previews as '' on purpose: a body with no non-blank
// line genuinely has nothing to show, so blank is the honest answer there and
// the caller's own `|| fallback` can take over.

// A cut line ends in '…' and the result never EXCEEDS max: the callers' widths
// are layout budgets, so an ellipsis added on top of max trades this defect for
// an overflow. That is what `max - 1` buys. max < 1 has no room for the mark, so
// nothing it could return would be both marked and within budget.
function previewLine(text, max) {
  if (typeof text !== 'string') return '';
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (max === undefined) return trimmed;
    if (max < 1) return '';
    if (trimmed.length <= max) return trimmed;
    return trimmed.slice(0, max - 1).trimEnd() + '…';
  }
  return '';
}

module.exports = { previewLine };
