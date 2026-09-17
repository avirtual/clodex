'use strict';

const PROSE_VERDICT_NUDGE = 'Your verdict reached no one: it was written as plain output, and only the [agent:review-done] intent delivers it to the lead and closes the review. Re-emit it now, verbatim, as:\n[agent:review-done] <your full verdict>\n[agent:end]';

const VERDICT_LINE_RE = /\*\*VERDICT\*\*|^\s*[-*]?\s*VERDICT\s*:/m;
const VERDICT_WORD_RE = /\b(ACCEPT|REWORK)\b/;

function proseVerdictNeedsNudge({ text, intents, session } = {}) {
  if (!session || !session.reviewFor) return false;
  if (session._verdictNudged) return false;
  if (typeof text !== 'string' || !text) return false;
  if (!VERDICT_LINE_RE.test(text)) return false;
  if (!VERDICT_WORD_RE.test(text)) return false;
  const list = Array.isArray(intents) ? intents : [];
  for (const intent of list) {
    if (intent && (intent.type === 'review-done' || intent.name === 'review-done')) return false;
  }
  return true;
}

module.exports = { proseVerdictNeedsNudge, PROSE_VERDICT_NUDGE };
