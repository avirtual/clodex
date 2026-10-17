'use strict';

const { parseIntent, fencedLines } = require('./intent-scanner');
const { scanIntentLines } = require('./intent-segments');

const TICKET_CLAIM_RE = /\b(?:ticket|t\d{2,5})\b[^.\n]{0,80}\b(?:filed|dispatched|rejected|respec'?d|cancell?ed)\b|\b(?:filed|dispatched|rejected|respec'?d|cancell?ed)\b[^.\n]{0,80}\b(?:ticket|t\d{2,5})\b/i;
const CLAIM_WORD_RE = /\b(?:filed|dispatched|rejected|respec'?d|cancell?ed)\b/i;
const RETROSPECTIVE_RE = /\b(already|earlier|previously|was|were|had|has been|have been|last (night|time|turn|session)|yesterday|since)\b/i;
const FOLLOWUPS_RE = /followups/i;
const MINTING_WORD_RE = /^(?:filed|dispatched)$/i;
const TICKET_ID_RE = /\bt\d{2,5}\b/i;
const FILING_SUBS = new Set(['add', 'reject', 'respec', 'cancel']);
const EMPTY_BODY_SUBS = new Set(['add', 'reject', 'respec']);

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

function liveClaimWord(prose) {
  for (const sentence of prose.split(/[.?!;\n]/)) {
    const claim = TICKET_CLAIM_RE.exec(sentence);
    if (!claim) continue;
    if (RETROSPECTIVE_RE.test(sentence) || FOLLOWUPS_RE.test(sentence)) continue;
    const word = CLAIM_WORD_RE.exec(claim[0])[0].toLowerCase();
    if (MINTING_WORD_RE.test(word) && TICKET_ID_RE.test(sentence)) continue;
    return word;
  }
  return null;
}

function isFilingVerb(intent) {
  return !!intent && intent.type === 'task' && FILING_SUBS.has(intent.sub);
}

function stepTicketClaims({ verbSeen = false, claimWord = null } = {}, { text, intents, turnEnd } = {}) {
  const list = Array.isArray(intents) ? intents : [];
  const nudges = [];
  for (const i of list) {
    if (!isFilingVerb(i) || !EMPTY_BODY_SUBS.has(i.sub)) continue;
    if (i.bodyOpen || String(i.body == null ? '' : i.body).trim()) continue;
    const head = `[agent:task ${i.sub}${i.id ? ' ' + i.id : ''}]`;
    nudges.push({
      word: `empty ${i.sub}`,
      text: `[agent:intent] ${head} carried an EMPTY body — the hand received only a reopen/title. `
        + 'Re-emit it with the full body, closed by [agent:end].',
    });
  }
  const seen = verbSeen || list.some(isFilingVerb);
  let word = claimWord;
  if (!word && typeof text === 'string' && text) {
    word = liveClaimWord(proseOf(text));
  }
  if (!turnEnd) return { state: { verbSeen: seen, claimWord: word }, nudges };
  if (word && !seen) {
    nudges.push({
      word,
      text: `[agent:intent] your prose says a ticket was ${word} but this turn carried no [agent:task ...] intent — `
        + 'nothing was filed. Emit the intent with its full body, closed by [agent:end].',
    });
  }
  return { state: { verbSeen: false, claimWord: null }, nudges };
}

module.exports = { TICKET_CLAIM_RE, RETROSPECTIVE_RE, FOLLOWUPS_RE, MINTING_WORD_RE, TICKET_ID_RE, isFilingVerb, stepTicketClaims };
