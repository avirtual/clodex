'use strict';

// A cascade resolver for source-shape pins: given a stylesheet and an element
// chain, answer WHICH rule wins a property. Substring pins ("the file carries
// this rule") cannot see the class of bug that put this file here — a rule that
// is present, correct and outranked. Two of them shipped in the chrome layer:
// `.dialog-head h3 { margin: 0 }` (0,1,1) sitting under `#dialog h3` (1,0,1),
// and `#dialog label.agent-check input { height: auto }` under a later
// `#dialog input` (the layer's control treatment). Both read fine in the source
// and did nothing in the browser.
//
// Deliberately partial: descendant combinators, ids, classes, `[attr="v"]` and
// tag names only. A selector carrying `:`, `>`, `+` or `~` is skipped, which is
// SAFE for these pins — the skipped rule can only be one that would have won,
// so a skip costs a false pass, never a false red. Callers assert on the
// returned selector, so a resolver that stopped seeing the real winner says so
// by naming a different one.

function parseRules(src) {
  const stripped = src.replace(/\/\*[\s\S]*?\*\//g, ' ');
  const rules = [];
  let i = 0;
  for (;;) {
    const open = stripped.indexOf('{', i);
    if (open < 0) break;
    const close = stripped.indexOf('}', open);
    if (close < 0) break;
    const selector = stripped.slice(i, open).trim().replace(/\s+/g, ' ');
    if (selector && !selector.startsWith('@')) {
      rules.push({ selector, body: stripped.slice(open + 1, close), at: open });
    }
    i = close + 1;
  }
  return rules;
}

function splitCompound(compound) {
  const parts = [];
  let rest = compound;
  const head = rest.match(/^[a-zA-Z][a-zA-Z0-9]*|^\*/);
  if (head) { parts.push(head[0]); rest = rest.slice(head[0].length); }
  while (rest) {
    const m = rest.match(/^#[\w-]+|^\.[\w-]+|^\[[^\]]*\]/);
    if (!m) return null;
    parts.push(m[0]);
    rest = rest.slice(m[0].length);
  }
  return parts;
}

function matchesCompound(compound, el) {
  if (/[:>+~]/.test(compound)) return false;
  const parts = splitCompound(compound);
  if (!parts || !parts.length) return false;
  for (const part of parts) {
    if (part.startsWith('#')) { if (el.id !== part.slice(1)) return false; }
    else if (part.startsWith('.')) { if (!(el.classes || []).includes(part.slice(1))) return false; }
    else if (part.startsWith('[')) {
      const m = part.match(/^\[([\w-]+)="?([^"\]]*)"?\]$/);
      if (!m || (el.attrs || {})[m[1]] !== m[2]) return false;
    } else if (part !== '*' && part !== el.tag) return false;
  }
  return true;
}

function matchesChain(selector, chain) {
  const compounds = selector.split(' ').filter(Boolean);
  if (!compounds.length) return false;
  if (!matchesCompound(compounds[compounds.length - 1], chain[chain.length - 1])) return false;
  let ci = chain.length - 2;
  for (let k = compounds.length - 2; k >= 0; k--) {
    let found = false;
    while (ci >= 0) {
      if (matchesCompound(compounds[k], chain[ci])) { found = true; ci--; break; }
      ci--;
    }
    if (!found) return false;
  }
  return true;
}

function specificity(selector) {
  const ids = (selector.match(/#[\w-]+/g) || []).length;
  const cls = (selector.match(/\.[\w-]+|\[[^\]]*\]/g) || []).length;
  const tags = (selector.replace(/#[\w-]+|\.[\w-]+|\[[^\]]*\]/g, ' ')
    .match(/[a-zA-Z][a-zA-Z0-9]*/g) || []).length;
  return ids * 10000 + cls * 100 + tags;
}

// The winner for `prop` on `chain`: higher specificity first, source order as
// the tiebreak — the two things that decided both bugs above.
function winningDeclaration(css, chain, prop) {
  let best = null;
  const re = new RegExp(`(?:^|;)\\s*${prop}\\s*:\\s*([^;]+)`);
  for (const rule of parseRules(css)) {
    const decl = rule.body.match(re);
    if (!decl) continue;
    for (const sel of rule.selector.split(',').map((s) => s.trim())) {
      if (!matchesChain(sel, chain)) continue;
      const score = specificity(sel);
      if (!best || score > best.score || (score === best.score && rule.at > best.at)) {
        best = { selector: sel, value: decl[1].trim(), score, at: rule.at };
      }
    }
  }
  return best;
}

module.exports = { parseRules, matchesChain, specificity, winningDeclaration };
