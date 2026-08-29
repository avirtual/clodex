// Post-cut paragraph-boundary check for a comment-deletion pass.
//
// The gap it closes: an applier guard that only checks "is this span all
// comment lines" happily cuts the HEAD off a sentence and leaves the tail as
// the paragraph's new opening line. The residue reads as a complete claim and
// can invert the original one — a cut left "// createWorktree (it reaches
// git argv), so this only rejects the empty form", which reverses which side
// validates the branch name.
//
// Two shapes, both cheap to detect on the OPENING line of a comment block:
//   - opens lowercase, or on a clause connector (so/and/but/which/because/…)
//   - the block is a single bare `//` with no prose (an orphaned separator)
//
// Identifier-initial openers (`_loadTicket returns…`, `null, not {}: …`) are
// legitimate sentences and are exempted by the camelCase/underscore test.
const fs = require('fs');

const CONNECTOR = /^(so|and|but|or|which|that|because|since|then|thus|hence|yet|while|where|when|though|although|unless|rather|instead|also|plus|nor)\b/i;
const IDENTIFIERISH = /^(?:[a-z][A-Za-z0-9]*[A-Z]|_[A-Za-z]|`|'|")/;

function check(file, upto = Infinity) {
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  const flags = [];
  for (let i = 0; i < Math.min(lines.length, upto); i++) {
    const t = lines[i].trim();
    if (!t.startsWith('//')) continue;
    const prev = (lines[i - 1] || '').trim();
    if (prev.startsWith('//')) continue;          // not the block's opening line
    let body = t.replace(/^\/\/\s?/, '').trim();
    let at = i;
    let text = t;

    // A bare `//` opener is not itself the block's prose: when prose follows, the
    // line below is the real opening line, and the `prev.startsWith('//')` skip
    // above would otherwise retire it unexamined.
    if (!body) {
      const next = (lines[i + 1] || '').trim();
      const nextBody = next.startsWith('//') ? next.replace(/^\/\/\s?/, '').trim() : '';
      if (!nextBody) {
        flags.push({ line: i + 1, why: 'orphaned bare // with no prose', text: t });
        continue;
      }
      if (i + 1 >= Math.min(lines.length, upto)) continue;
      body = nextBody;
      at = i + 1;
      text = next;
    }
    if (/^[─=—*]/.test(body)) continue;           // banner rule
    if (IDENTIFIERISH.test(body)) continue;       // `_loadTicket returns…`, `null, not…`
    if (CONNECTOR.test(body)) {
      flags.push({ line: at + 1, why: `opens on connector "${body.split(/\s+/)[0]}"`, text });
    } else if (/^[a-z]/.test(body)) {
      flags.push({ line: at + 1, why: 'opens lowercase — likely a severed sentence head', text });
    }
  }
  return flags;
}

if (require.main === module) {
  const [file, upto] = process.argv.slice(2);
  const flags = check(file, upto ? Number(upto) : Infinity);
  for (const f of flags) console.log(`  L${f.line}  ${f.why}\n      ${f.text}`);
  console.log(flags.length ? `\n${flags.length} flag(s) — each needs a human ruling.` : 'clean');
}
module.exports = { check };
