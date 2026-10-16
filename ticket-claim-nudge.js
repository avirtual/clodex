'use strict';

const { parseIntent, fencedLines } = require('./intent-scanner');
const { scanIntentLines } = require('./intent-segments');

const TICKET_CLAIM_RE = /\b(?:ticket|t\d{2,5})\b[^.\n]{0,80}\b(?:filed|dispatched|rejected|respec'?d|cancell?ed)\b|\b(?:filed|dispatched|rejected|respec'?d|cancell?ed)\b[^.\n]{0,80}\b(?:ticket|t\d{2,5})\b/i;
const CLAIM_WORD_RE = /\b(?:filed|dispatched|rejected|respec'?d|cancell?ed)\b/i;
const FILING_SUBS = new Set(['add', 'reject', 'respec', 'cancel']);

function proseOf(text) {
  const lines = text.split('\n');
  const fenced = fencedLines(lines);
  const out = [];
  for (const seg of scanIntentLines(lines)) {
    if (seg.kind !== 'prose') continue;
    for (let i = seg.from; i < seg.to; i++) {
      if (fenced[i]) continue;
      const p = parseIntent(lines[i].trim());
      if (p && p.type === 'escape') continue;
      out.push(lines[i]);
    }
  }
  return out.join('\n');
}

function ticketClaimNudges({ text, intents, taskSeat } = {}) {
  if (!taskSeat) return [];
  const filing = (Array.isArray(intents) ? intents : [])
    .filter((i) => i && i.type === 'task' && FILING_SUBS.has(i.sub));
  const nudges = [];
  for (const i of filing) {
    if (i.bodyOpen || String(i.body == null ? '' : i.body).trim()) continue;
    const head = `[agent:task ${i.sub}${i.id ? ' ' + i.id : ''}]`;
    nudges.push({
      word: `empty ${i.sub}`,
      text: `[agent:intent] ${head} carried an EMPTY body — the hand received only a reopen/title. `
        + 'Re-emit it with the full body, closed by [agent:end].',
    });
  }
  if (filing.length || typeof text !== 'string' || !text) return nudges;
  const claim = TICKET_CLAIM_RE.exec(proseOf(text));
  if (!claim) return nudges;
  const word = CLAIM_WORD_RE.exec(claim[0])[0].toLowerCase();
  nudges.push({
    word,
    text: `[agent:intent] your prose says a ticket was ${word} but this turn carried no [agent:task ...] intent — `
      + 'nothing was filed. Emit the intent with its full body, closed by [agent:end].',
  });
  return nudges;
}

module.exports = { TICKET_CLAIM_RE, ticketClaimNudges };
