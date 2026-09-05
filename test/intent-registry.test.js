'use strict';

// Differential + contract tests for intent-registry.js (plugin plan §2.3).
//
// The load-bearing one is `parseIntent === parseIntentLegacy`: the registry walk
// is a MOVE of the regex chain, so the only acceptable evidence is that the two
// agree on every input, field by field, over a corpus large enough to catch a
// reordering. `parseIntentLegacy` below is the chain as it stood on master
// before the extraction (comments stripped, otherwise byte-identical) — a frozen
// oracle, deliberately NOT imported from anywhere, so it cannot drift with the
// code it is checking.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { parseIntent, cleanLine } = require('../intent-scanner');
const registry = require('../intent-registry');
const { GATEABLE_INTENTS, PRIVILEGED_INTENTS, intentsAllowlistFromChecked } = require('../intent-catalog');

// --- the frozen legacy oracle -----------------------------------------------

function parseIntentLegacy(rawLine) {
  const cleaned = cleanLine(rawLine).trim();
  if (!cleaned) return null;

  const escMatch = cleaned.match(/^\\(\[agent:.*)/);
  if (escMatch) return { type: 'escape', text: escMatch[1] };

  const dmMatch = cleaned.match(/^\[agent:dm\s+(\S+?)(\s+urgent)?\]\s*(.*)/s);
  if (dmMatch) return { type: 'dm', target: dmMatch[1], urgent: !!dmMatch[2], body: dmMatch[3] };

  const resendMatch = cleaned.match(/^\[agent:resend\s+([a-z0-9]+)\]\s*$/i);
  if (resendMatch) return { type: 'resend', id: resendMatch[1].toLowerCase() };

  if (/^\[agent:who\]\s*$/.test(cleaned)) return { type: 'who' };

  if (/^\[agent:name\]\s*$/.test(cleaned)) return { type: 'name' };

  if (/^\[agent:end\]\s*$/.test(cleaned)) return { type: 'end' };

  const ctxMatch = cleaned.match(/^\[agent:context\s+(\S+)\]\s*(.*)/s);
  if (ctxMatch) return { type: 'context', sub: ctxMatch[1].toLowerCase(), body: ctxMatch[2] };

  const memMatch = cleaned.match(/^\[agent:memory\s+(\S+)\]\s*(.*)/s);
  if (memMatch) return { type: 'memory', sub: memMatch[1].toLowerCase(), body: memMatch[2] };

  const fileMatch = cleaned.match(/^\[agent:file\s+(\S+)\s+(.+?)\]\s*$/);
  if (fileMatch) return { type: 'file', sub: fileMatch[1].toLowerCase(), path: fileMatch[2].trim() };

  // Worth stating so nobody reads the differential as evidence the shipped regex
  // is CORRECT: this block is a byte copy of parseTerm, so the two can only
  // disagree about chain ORDER, never about the pattern. And the order claim is
  // weak here too — `^\[agent:term` and `^\[agent:exec` are disjoint anchored
  // prefixes, so the "order-sensitive pair" in the corpus below cannot actually
  // be broken by moving either row. The real coverage for term parsing is the
  // corpus itself and the raw-body tests further down.
  const termMatch = cleaned.match(/^\[agent:term\s+(\S+)\]\s*(.*)/s);
  if (termMatch) return { type: 'term', sub: termMatch[1].toLowerCase(), body: termMatch[2] };

  const execMatch = cleaned.match(/^\[agent:exec\s+(\S+)\]\s*(.*)/s);
  if (execMatch) return { type: 'exec', cmd: execMatch[1], body: execMatch[2] };

  const remindMatch = cleaned.match(/^\[agent:remind\s+([^\]]+)\]\s*(.*)/s);
  if (remindMatch) return { type: 'remind', spec: remindMatch[1].trim(), body: remindMatch[2] };

  const notifyMatch = cleaned.match(/^\[agent:notify-user\]\s*(.*)/s);
  if (notifyMatch) return { type: 'notify-user', body: notifyMatch[1] };

  const teamReviewMatch = cleaned.match(/^\[agent:team-review\]\s*(.*)/s);
  if (teamReviewMatch) return { type: 'team-review', body: teamReviewMatch[1] };

  const reviewDoneMatch = cleaned.match(/^\[agent:review-done\]\s*(.*)/s);
  if (reviewDoneMatch) return { type: 'review-done', body: reviewDoneMatch[1] };

  const rebootMatch = cleaned.match(/^\[agent:reboot\]\s*(.*)/s);
  if (rebootMatch) return { type: 'reboot', body: rebootMatch[1] };

  const taskMatch = cleaned.match(/^\[agent:task\s+(add|assign|start|done|reject|respec|cancel|accept|park|list)\b([^\]]*)\]\s*(.*)/s);
  if (taskMatch) {
    const sub = taskMatch[1];
    const argToks = taskMatch[2].trim().split(/\s+/).filter(Boolean);
    const body = taskMatch[3];
    // t174: `park` is a modifier on add, filtered out of the positionals so it
    // can never be read as the assignee. Same lockstep rule as t80's filter.
    if (sub === 'add') {
      const park = argToks.includes('park');
      // t673: `reviewer:<template>` joins `park` as a keyed modifier, filtered
      // out of the positionals. Updated here in lockstep with parseTask, per the
      // rule below — a shape change that lands in only one copy stops the
      // differential covering the verb at all.
      const rvTok = /^reviewer:(.+)$/;
      const reviewer = (argToks.find((t) => rvTok.test(t)) || '').replace(/^reviewer:/, '') || null;
      const rest = argToks.filter((t) => t !== 'park' && !rvTok.test(t));
      return { type: 'task', sub, who: rest[0] || null, id: null, park, reviewer, body };
    }
    if (sub === 'assign') return { type: 'task', sub, id: argToks[0] || null, who: argToks[1] || null, body: '' };
    // t80: list carries an optional state filter from the bracket. Updated here
    // in lockstep with parseTask — this copy exists to catch UNINTENDED drift
    // between the walk and the legacy chain, so a deliberate, reviewed shape
    // change belongs in both or the pin stops meaning anything.
    if (sub === 'list') return { type: 'task', sub, id: null, who: null, filter: argToks[0] || null, body: '' };
    // t308 added `start` to parseTask and did NOT update this copy. The gap
    // stayed invisible because the corpus is harvested from QUOTED string
    // literals and the only `task start` in a harvested file sat inside a
    // regex literal — so no corpus line ever reached the divergence. Fuzzing
    // the oracle against the walk (2000 generated lines) found this and only
    // this. Keep the lockstep rule above in force: a new sub-verb lands here
    // in the same commit, or the differential silently stops covering it.
    if (sub === 'start') {
      const rvTok = /^reviewer:(.+)$/;
      const reviewer = (argToks.find((t) => rvTok.test(t)) || '').replace(/^reviewer:/, '') || null;
      const rest = argToks.filter((t) => !rvTok.test(t));
      return { type: 'task', sub, id: rest[0] || null, who: null, reviewer, body: '' };
    }
    if (sub === 'park') return { type: 'task', sub, id: argToks[0] || null, who: null, body: '' };
    return { type: 'task', sub, id: argToks[0] || null, who: null, body };
  }

  const teamMatch = cleaned.match(/^\[agent:team\s+(role-add|role-set|role-rm|role-rename|watchdog)\b([^\]]*)\]\s*(.*)/s);
  if (teamMatch) {
    const sub = teamMatch[1];
    const argStr = teamMatch[2];
    const body = teamMatch[3];
    const promptM = argStr.match(/\bprompt:(\S+)/);
    const templateM = argStr.match(/\btemplate:(\S+)/);
    const positional = argStr.trim().split(/\s+/).filter((t) => t && !/^\w+:/.test(t));
    if (sub === 'role-add' || sub === 'role-set') {
      return { type: 'team', sub, name: positional[0] || null, prompt: promptM ? promptM[1] : null, template: templateM ? templateM[1] : null, body };
    }
    if (sub === 'role-rm') return { type: 'team', sub, name: positional[0] || null, body: '' };
    if (sub === 'role-rename') return { type: 'team', sub, name: positional[0] || null, to: positional[1] || null, body: '' };
    const ms = positional[0] != null ? Number(positional[0]) : null;
    return { type: 'team', sub, ms: Number.isFinite(ms) ? ms : null, body: '' };
  }

  const spawnMatch = cleaned.match(/^\[agent:spawn\s+(.+)\]\s*$/);
  if (spawnMatch) {
    const argstr = spawnMatch[1];
    const nameM = argstr.match(/\bname:(\S+)/);
    const cwdM = argstr.match(/\bcwd:(\S+)/);
    const tplM = argstr.match(/\btemplate:(\S+)/);
    const wtM = argstr.match(/\bworktree:(\S+)/);
    return {
      type: 'spawn',
      name: nameM ? nameM[1] : null,
      cwd: cwdM ? cwdM[1] : null,
      template: tplM ? tplM[1] : null,
      worktree: wtM ? wtM[1] : null,
    };
  }

  return null;
}

// --- the corpus --------------------------------------------------------------

// Scan for string literals in CODE positions only. A quote-pairing regex over
// raw bytes cannot do this: a quote in prose opens a literal that closes at the
// next quote anywhere downstream, so every literal after it pairs on shifted
// boundaries. A BACKTICK in a comment is the vector with reach: in THIS scanner
// single quotes abort at the newline, so `caller's job` cannot desync past its
// own line; under the old byte pairer it could, which is what dropped
// `[agent:context clear]`.
//
// The mis-pairing was silent in BOTH directions, and over-collection was the
// larger half. (t348 measured 106 real literals dropped and 1100 comment/code
// fragments swept in, against a one-off oracle — a historical finding, not
// something this file can check. What the tree checks is the consequence: the
// `[agent:context clear]` anchor and the `});` sentinel below.)
//
// Comments cannot be stripped in a separate pass first: a `//` inside a string
// literal is not a comment, so recognizing the two requires one shared pass.
// The `http://` line in the scanner's unit test is what pins that.
// Regex literals are skipped because a quote inside one is not a quote — the
// balanced backticks in `/^\[agent:\?\] ... `\[agent:frobnicate now\]`/` would
// otherwise be read as a template literal and donate its body to the corpus;
// an ODD backtick in a regex would desync to the next backtick anywhere
// downstream.
//
// KNOWN LIMIT: `${}` depth is counted so a nested template literal cannot end
// the outer one, but the count is brace-naive — a `}` inside a string inside an
// interpolation (`${ x === '}' ? a : b }`) miscounts. No such site exists in the
// harvested files today. It degrades to over-collecting one literal, not to
// cross-file desync, because a template body carrying `${` is dropped downstream.
function stringLiteralsInCode(src) {
  const out = [];
  // A `/` starts a regex only where an expression may begin. After an
  // identifier, number, `)` or `]` it is division, so those are excluded.
  const REGEX_MAY_FOLLOW = /[=(,:[!&|?{};+\-*%~^]/;
  let prevSig = '';
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === '/' && src[i + 1] === '/') {
      while (i < src.length && src[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      i = src.indexOf('*/', i + 2);
      if (i < 0) break;
      i += 2;
      continue;
    }
    if (c === '/' && (prevSig === '' || REGEX_MAY_FOLLOW.test(prevSig))) {
      let j = i + 1;
      let inClass = false;
      while (j < src.length) {
        const d = src[j];
        if (d === '\\') { j += 2; continue; }
        if (d === '\n') { j = -1; break; }
        if (d === '[') inClass = true;
        else if (d === ']') inClass = false;
        else if (d === '/' && !inClass) break;
        j++;
      }
      if (j > 0) { i = j + 1; prevSig = '/'; continue; }
    }
    if (c === '"' || c === "'" || c === '`') {
      let j = i + 1;
      let body = '';
      let depth = 0;
      while (j < src.length) {
        const d = src[j];
        if (d === '\\') { body += src.slice(j, j + 2); j += 2; continue; }
        if (c === '`' && d === '$' && src[j + 1] === '{') { depth++; body += '${'; j += 2; continue; }
        if (depth > 0 && d === '}') { depth--; body += d; j++; continue; }
        if (d === c && depth === 0) break;
        // An unterminated single/double quote is an apostrophe we mis-read;
        // abandon it rather than swallowing the rest of the file.
        if (d === '\n' && c !== '`') { j = -1; break; }
        body += d;
        j++;
      }
      // `src[j] === c` and not merely `j > 0`: the loop also exits by running
      // off the end, and a backtick has no newline guard to stop it, so one
      // unpartnered backtick would otherwise push the whole file tail as a
      // literal — mass over-collection, the failure this scanner exists to end.
      if (j > 0 && src[j] === c) { out.push(body); i = j + 1; prevSig = c; continue; }
    }
    if (!/\s/.test(c)) prevSig = c;
    i++;
  }
  return out;
}

// Harvested LIVE from the three files named below rather than copied: every
// non-interpolated string literal in them that mentions `[agent:` is a line
// someone once thought worth asserting on. It does NOT grow with the suite —
// a new intent test file contributes nothing until it is added here, which is
// how a sub-verb went uncovered for an entire release cycle. The sub-verb
// guards below, not this harvest, are what make coverage a mechanism.
function harvestedLines() {
  const out = new Set();
  for (const f of ['intent-scanner.test.js', 'session-manager.test.js', 'ipc-prompt.test.js']) {
    let src;
    try { src = fs.readFileSync(path.join(__dirname, f), 'utf8'); } catch { continue; }
    // Escapes are decoded through JSON where possible so a literal `\[agent:`
    // in the source becomes a real backslash in the corpus.
    for (const raw of stringLiteralsInCode(src)) {
      if (!raw.includes('[agent:')) continue;
      if (raw.includes('${')) continue;
      let decoded = raw;
      try { decoded = JSON.parse(`"${raw.replace(/"/g, '\\"')}"`); } catch { /* keep raw */ }
      for (const line of decoded.split('\n')) out.add(line);
    }
  }
  return [...out];
}

// Adversarial cases the harvest can't be trusted to contain: every verb in
// every shape, the order-sensitive pairs, and the near-misses.
const ADVERSARIAL = [
  '', '   ', 'plain prose', 'talking about [agent:who] mid-line',
  '\\[agent:who]', '\\[agent:dm bob] hi', '\\\\[agent:who]',
  '[agent:who]', '[agent:who] ', '[agent:who] extra', '[agent:WHO]',
  '[agent:name]', '[agent:name] extra',
  '[agent:end]', '[agent:end] ', '[agent:end] trailing',
  '[agent:dm bob]', '[agent:dm bob] hello', '[agent:dm bob urgent] hello',
  '[agent:dm bob  urgent]', '[agent:dm bob@peer urgent] x', '[agent:dm]',
  '[agent:dm a b c] body', '[agent:dm bob] line1\nline2',
  '[agent:resend abc123]', '[agent:resend ABC123]', '[agent:resend abc-123]',
  '[agent:resend abc123] trailing', '[agent:resend]',
  '[agent:context compact]', '[agent:context compact] pickup note',
  '[agent:context CLEAR]', '[agent:context reload]', '[agent:context]',
  '[agent:context two words]',
  '[agent:memory list]', '[agent:memory remember] text', '[agent:memory RECALL] q',
  '[agent:memory]',
  '[agent:file view /a/b.txt]', '[agent:file open /a b/c.txt]',
  '[agent:file VIEW x]', '[agent:file view]', '[agent:file view x] trailing',
  '[agent:exec cmd]', '[agent:exec cmd] {"a":1}', '[agent:exec]',
  '[agent:exec a b] x',
  // term is body-based because a shell command contains `]`, quotes and
  // arbitrary bytes. The bracket-content cases below are the ones that would
  // break a bracket-based parse, and the `term exec` / `exec` pair is the
  // order-sensitive one: `[agent:term exec ...]` must never be read as an exec.
  '[agent:term exec] ls -la', '[agent:term exec] git log --oneline | head -3',
  '[agent:term exec] echo "a]b" && echo \'c;d\'', '[agent:term exec]',
  '[agent:term EXEC] ls', '[agent:term]', '[agent:term exec ls]',
  '[agent:term status]', '[agent:term exec] multi\nline body',
  '[agent:remind every 30m] text', '[agent:remind in 45m]',
  '[agent:remind on compact] re-read', '[agent:remind cron 0 9 * * *] x',
  '[agent:remind list]', '[agent:remind]', '[agent:remind cancel abc]',
  '[agent:notify-user]', '[agent:notify-user] note', '[agent:notify-user extra]',
  '[agent:team-review]', '[agent:team-review] scope text',
  '[agent:review-done]', '[agent:review-done] verdict',
  '[agent:reboot]', '[agent:reboot] reason text', '[agent:reboot extra]',
  '[agent:task add]', '[agent:task add reviewer] spec', '[agent:task add] spec',
  '[agent:task assign t1 bob]', '[agent:task assign t1]', '[agent:task assign]',
  '[agent:task done t1] report', '[agent:task reject t1] why',
  '[agent:task cancel t1]', '[agent:task cancel t1] why', '[agent:task list]',
  '[agent:task accept t1]', '[agent:task accept t1] note', '[agent:task accept]',
  '[agent:task list] trailing', '[agent:task foo]', '[agent:task]',
  '[agent:task added t1]',
  '[agent:task park t1]', '[agent:task park t1] why', '[agent:task park]',
  '[agent:task start]', '[agent:task start t1]', '[agent:task start t1] trailing',
  '[agent:task started t1]',
  '[agent:task add park] spec', '[agent:task add park hand] spec',
  '[agent:task add hand park] spec', '[agent:task add parked] spec',
  '[agent:team role-add lead] brief', '[agent:team role-add lead prompt:p.md] brief',
  '[agent:team role-set lead template:t] brief', '[agent:team role-rm lead]',
  '[agent:team role-rename a b]', '[agent:team watchdog 5000]',
  '[agent:team watchdog abc]', '[agent:team watchdog]', '[agent:team foo]',
  '[agent:team]', '[agent:team-reviewer]',
  '[agent:spawn name:x cwd:/a]', '[agent:spawn name:x cwd:/a template:t]',
  '[agent:spawn name:x cwd:/a worktree:b]', '[agent:spawn worktree:feature/b name:x cwd:/a]',
  '[agent:spawn name:x cwd:/a worktree:]',
  '[agent:spawn]', '[agent:spawn junk]', '[agent:spawn name:x cwd:/a] trailing',
  '[agent:unknownverb]', '[agent:]', '[agent:', '[agent:dm',
  '• [agent:who]', '  [agent:who]', '─ [agent:dm bob] hi',
  '\x1b[32m[agent:who]\x1b[0m',
];

const CORPUS = [...new Set([...ADVERSARIAL, ...harvestedLines()])];

// ── t313: the "every verb in every shape" claim, enforced ───────────────────
//
// ADVERSARIAL's comment claims it covers every verb in every shape. Nothing
// checked that, and it was false: t308 added `start` to parseTask, the frozen
// oracle above was never updated in lockstep, and NO corpus line reached the
// divergence — so the differential stayed green over a sub-verb it did not
// parse at all, from t308 until a `task start` literal happened to land in a
// harvested file. A universal asserted in prose is the defect class; this
// converts it into a mechanism.
//
// The corpus does NOT grow with the suite: harvestedLines reads three
// hardcoded files, so the `task start` literals that have been in
// test/task-start.test.js since t308 were never harvested. Widening the
// harvest is the other possible fix and is deliberately NOT taken here — it
// would pull in every future intent-mentioning test file and make this
// differential fail for reasons unrelated to the walk. Naming the verbs is the
// narrower guarantee.
//
// The verb lists are DERIVED from intent-registry.js's own source rather than
// retyped, so a new sub-verb cannot be added to the grammar without either
// appearing in the corpus or turning this red. Reading source text is uglier
// than importing a constant, but the alternations are regex literals inside
// functions — exporting them purely for this test would reshape production to
// suit the suite. The empty-derivation trap is guarded below: if a regex ever
// stops matching, an empty list makes `every` vacuously true, which is
// precisely how a guard like this rots into a no-op.
//
// t338: parameterised over the FAMILY, because `task` was not the only verb
// with a closed sub-verb alternation — `team` has the identical shape and was
// unguarded.
//
// t343: matched on the PRESENCE of a `|` inside the group rather than on an
// alphabet of members. A `[a-z|-]` class silently fails to read a family whose
// verbs contain a digit or an underscore, or whose group nests — and a failed
// read here returns [], which the caller's floor is the only thing standing
// between and a vacuous pass. This must stay in lockstep with the closure
// scan below: a family that scan can DETECT but this cannot ENUMERATE is a
// guard that names the hole and then measures nothing inside it.
function subVerbsFromSource(family) {
  const src = fs.readFileSync(path.join(__dirname, '..', 'intent-registry.js'), 'utf8');
  const m = src.match(new RegExp(`agent:${family}\\\\s\\+\\(([^)]*\\|[^)]*)\\)`));
  return m ? m[1].split('|') : [];
}

// The families whose parse function pins a CLOSED list of sub-verbs in its
// bracket regex. Verbs like context/memory/file/term capture `(\S+)` instead:
// they have no list to drift out of sync with, so there is nothing for a
// coverage guard to enumerate.
const CLOSED_SUB_VERB_FAMILIES = ['task', 'team'];

// Per-family anti-vacuity floor. Each is the count the family HAD when it was
// pinned, so shrinking the grammar trips this rather than quietly shrinking
// what the loop below iterates. A single shared floor would have to be the
// smaller of the two and would stop measuring the larger family.
const MIN_SUBS = { task: 9, team: 5 };

function corpusCovers(family, sub) {
  return CORPUS.some((line) => {
    const i = parseIntent(line);
    return i && i.type === family && i.sub === sub;
  });
}

test('t313/t338: every sub-verb of a closed-alternation family appears in the corpus', () => {
  for (const family of CLOSED_SUB_VERB_FAMILIES) {
    const verbs = subVerbsFromSource(family);
    // Without this the assertion below iterates nothing and passes no matter
    // what the corpus contains — the exact shape of vacuity this guard stops.
    assert.ok(verbs.length >= MIN_SUBS[family], `ENTER: read the ${family} alternation from intent-registry.js (got ${JSON.stringify(verbs)})`);
    for (const v of verbs) {
      assert.ok(corpusCovers(family, v),
        `no corpus line parses to ${family}/${v} — the differential does not cover it`);
    }
  }
  // `start` was added to parseTask in t308 and went uncovered until t333 — its
  // absence from the derived list IS that defect record, which is why this one
  // verb is named while the rest are left to the floor above. If the verb is
  // ever legitimately renamed, update this pin.
  assert.ok(subVerbsFromSource('task').includes('start'), 'ENTER: task/start is in the derived list');
});

// The guard above only covers families someone remembered to list. This one
// makes forgetting loud: a THIRD closed alternation landing in
// intent-registry.js turns it red rather than shipping unguarded, which is the
// exact way `team` stayed uncovered while `task` was fixed. It reads that ONE
// file — grammar supplied from anywhere else is outside its reach.
//
// t343: the scan keys on a `|` being present inside the group, not on the
// alphabet its members are drawn from. The earlier `[a-z|-]` class made the
// guard itself shape-dependent: a family spelled `(v1|v2)` or `(a_b|c)` did
// not match, `found` stayed equal to the guarded list, and the deepStrictEqual
// passed while the family shipped unguarded. `[^)]*` cannot cross the closing
// paren, and every other bracket regex in the file closes its first `)` with
// no `|` inside it, so requiring the alternation adds no false positives.
test('t338/t343: no closed sub-verb family exists that the coverage guard does not list', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'intent-registry.js'), 'utf8');
  const found = [...src.matchAll(/agent:([a-z-]+)\\s\+\(([^)]*\|[^)]*)\)/g)].map((m) => m[1]);
  assert.ok(found.length >= 2, `ENTER: the scan found the alternations (got ${JSON.stringify(found)})`);
  assert.deepStrictEqual([...new Set(found)].sort(), [...CLOSED_SUB_VERB_FAMILIES].sort());
});

test('corpus is big enough to be evidence', () => {
  assert.ok(CORPUS.length >= 150, `corpus is only ${CORPUS.length} lines`);
  // The harvest must actually be finding things; a silent regex breakage would
  // otherwise reduce this test to the hand-written list.
  assert.ok(harvestedLines().length >= 40, 'harvest found suspiciously few lines');
});

// t348: the harvest used to pair quotes over raw bytes, so an apostrophe in a
// prose comment desynced every literal below it. The floor above did NOT catch
// that — the broken pairer cleared it at 1276 lines, because the mis-pairing
// over-collected comment prose and code fragments far faster than it dropped
// real literals. Only an exact-set assertion separates the two, which is why
// this is deepStrictEqual and not a containment check: `includes` passes on the
// broken pairer.
test('t348: the literal scanner reads code positions only, exactly', () => {
  const fixture = [
    "const a = '[agent:who]';",
    // The apostrophe alone does not prove the comment arm: the single-quote
    // scan aborts at a newline, so it cannot desync past this line on its own.
    // A BACKTICK in comment prose is the live vector — it legally spans lines,
    // so an unskipped comment donates `[agent:ghost]` to the corpus as if a
    // test had asserted on it. (t348 measured 16 such fragments against a
    // one-off oracle — historical, not checkable here; this fixture is.)
    "// column-1 enforcement is the caller's job — see `[agent:ghost]` below",
    "const b = '[agent:context clear]';",
    'const c = "[agent:dm bob] hi";',
    // Same vector, block form: the backtick must not survive to the next line.
    "/* block comment, odd ' quote, open `[agent:phantom]",
    '   still inside the block comment */',
    "const d = /^\\[agent:\\?\\] `\\[agent:frobnicate now\\]`/;",
    "const e = '[agent:task done t1] report';",
    // Pins the comment block's claim that comments cannot be stripped in a
    // separate pre-pass: this `//` is inside a literal, so a pre-pass would
    // truncate the line and lose the intent. No harvested file has such a
    // literal today, which is exactly why the claim needs its own witness.
    "const u = 'see http://x [agent:who]';",
  ].join('\n');
  assert.deepStrictEqual(stringLiteralsInCode(fixture), [
    '[agent:who]',
    '[agent:context clear]',
    '[agent:dm bob] hi',
    '[agent:task done t1] report',
    'see http://x [agent:who]',
  ]);
});

test('t348: an unpartnered backtick cannot swallow the file tail', () => {
  // The quote arms abort at a newline, but a backtick legally spans lines, so
  // only the terminator check stops a stray one from returning everything after
  // it as a single literal.
  assert.deepStrictEqual(stringLiteralsInCode("const a = '[agent:who]';\nconst s = `unclosed\nmore [agent:dm bob] text\n"), ['[agent:who]']);
});

test('t348: a nested template literal does not end the outer one', () => {
  assert.deepStrictEqual(stringLiteralsInCode('const a = `outer ${ `${inner}` } tail`;'), ['outer ${ `${inner}` } tail']);
});

// The end-to-end anchor for the whole ticket. `[agent:context clear]` sits below
// the `caller's` apostrophe in intent-scanner.test.js and ADVERSARIAL carries
// only the uppercase `[agent:context CLEAR]`, so this line can ONLY arrive via a
// working harvest. It is also the exact literal a reviewer once claimed was
// harvested when it was not — the claim this test makes permanently checkable.
test('t348: the harvest reaches literals below a prose apostrophe', () => {
  const harvested = harvestedLines();
  assert.ok(harvested.includes('[agent:context clear]'),
    'harvest lost the literals below the apostrophe in intent-scanner.test.js');
  // The other half of the defect: byte-pairing swept in code fragments. A bare
  // `});` is not a string literal in any of the harvested files, so its presence
  // means the scanner is pairing quotes again rather than reading literals.
  assert.ok(!harvested.some((l) => l.trim() === '});'),
    'harvest is collecting code fragments, not string literals');
});

test('registry walk === legacy regex chain, field for field, over the whole corpus', () => {
  for (const line of CORPUS) {
    const got = parseIntent(line);
    const want = parseIntentLegacy(line);
    assert.deepStrictEqual(got, want, `parse differs for ${JSON.stringify(line)}`);
    if (got && want) {
      // deepStrictEqual would accept a differing key ORDER; the intents are
      // serialized into shadow keys and log lines, so pin the shape too.
      assert.deepStrictEqual(Object.keys(got), Object.keys(want), `key order differs for ${JSON.stringify(line)}`);
    }
  }
});

test('every core verb in the catalog is reachable through the walk', () => {
  const seen = new Set();
  for (const line of CORPUS) {
    const i = parseIntent(line);
    if (i) seen.add(i.type);
  }
  for (const r of registry.CORE_ROWS) {
    assert.ok(seen.has(r.type), `corpus never produces a ${r.type} intent`);
  }
});

// --- row shape ---------------------------------------------------------------

test('core rows derive gateable/privileged/label from intent-catalog, never a copy', () => {
  for (const r of registry.CORE_ROWS) {
    const cat = GATEABLE_INTENTS.find((i) => i.type === r.type);
    assert.strictEqual(r.gateable, !!cat, `${r.type} gateable`);
    assert.strictEqual(r.label, cat ? cat.label : null, `${r.type} label`);
    assert.strictEqual(r.privileged, PRIVILEGED_INTENTS.has(r.type), `${r.type} privileged`);
    assert.strictEqual(r.source, 'core');
    assert.strictEqual(r.handler, null, 'core rows are dispatched by the switch, not a handler');
    // ipc-prompt's GRAMMAR_LINES owns prompt copy and its own ordering; a core
    // row carrying a line here would be a second copy of pinned prompt bytes.
    assert.strictEqual(r.promptLines, null, `${r.type} must not duplicate GRAMMAR_LINES`);
  }
});

test('name is parsed but not gateable; reboot is gateable and privileged', () => {
  assert.strictEqual(registry.rowFor('name').gateable, false);
  assert.strictEqual(registry.rowFor('reboot').gateable, true);
  assert.strictEqual(registry.rowFor('reboot').privileged, true);
});

test('end and escape are NOT rows — the scanner shell owns them', () => {
  assert.strictEqual(registry.rowFor('end'), null);
  assert.strictEqual(registry.rowFor('escape'), null);
  // ...but they still parse, from the shell.
  assert.deepStrictEqual(parseIntent('[agent:end]'), { type: 'end' });
  assert.strictEqual(parseIntent('\\[agent:who]').type, 'escape');
});

// --- bodyMode: a PREDICATE, never a type-level flag (MUST-FIX 7) --------------

test('bodyMode is decided per PARSED intent: task add captures, task assign does not', () => {
  assert.strictEqual(registry.bodyModeFor(parseIntent('[agent:task add bob] spec')), 'greedy');
  assert.strictEqual(registry.bodyModeFor(parseIntent('[agent:task done t1] report')), 'greedy');
  assert.strictEqual(registry.bodyModeFor(parseIntent('[agent:task reject t1] why')), 'greedy');
  assert.strictEqual(registry.bodyModeFor(parseIntent('[agent:task cancel t1]')), 'greedy');
  // The acceptance NOTE is the body, so a non-greedy mode would truncate it at
  // the first newline and silently store half a rationale.
  assert.strictEqual(registry.bodyModeFor(parseIntent('[agent:task accept t1] note')), 'greedy');
  assert.strictEqual(registry.bodyModeFor(parseIntent('[agent:task assign t1 bob]')), 'none');
  assert.strictEqual(registry.bodyModeFor(parseIntent('[agent:task list]')), 'none');
});

test('bodyMode per sub-verb for team / memory / context', () => {
  assert.strictEqual(registry.bodyModeFor(parseIntent('[agent:team role-add lead] brief')), 'greedy');
  assert.strictEqual(registry.bodyModeFor(parseIntent('[agent:team role-set lead] brief')), 'greedy');
  assert.strictEqual(registry.bodyModeFor(parseIntent('[agent:team role-rm lead]')), 'none');
  assert.strictEqual(registry.bodyModeFor(parseIntent('[agent:team role-rename a b]')), 'none');
  assert.strictEqual(registry.bodyModeFor(parseIntent('[agent:team watchdog 500]')), 'none');
  assert.strictEqual(registry.bodyModeFor(parseIntent('[agent:memory remember] x')), 'greedy');
  assert.strictEqual(registry.bodyModeFor(parseIntent('[agent:memory list]')), 'none');
  assert.strictEqual(registry.bodyModeFor(parseIntent('[agent:memory recall] q')), 'none');
  assert.strictEqual(registry.bodyModeFor(parseIntent('[agent:context compact]')), 'greedy');
  assert.strictEqual(registry.bodyModeFor(parseIntent('[agent:context reload]')), 'greedy');
  assert.strictEqual(registry.bodyModeFor(parseIntent('[agent:context clear]')), 'greedy');
});

// `term exec` is the one body-carrying verb whose body is LINE-SCOPED, because
// vetTermCommand rejects any command containing a newline. Greedy capture (how
// it shipped) could therefore only ever swallow the agent's following prose and
// convert a correctly-written command into a refusal.
test('bodyMode: term exec is line-scoped, not greedy like its body-carrying peers', () => {
  assert.strictEqual(registry.bodyModeFor(parseIntent('[agent:term exec] pwd')), 'none');
  assert.strictEqual(registry.bodyModeFor(parseIntent('[agent:term list]')), 'none');
  // The contrast that makes the row's shape deliberate rather than an oversight.
  assert.strictEqual(registry.bodyModeFor(parseIntent('[agent:memory remember] x')), 'greedy');
});

test('bodyMode reproduces the legacy allow-set exactly, for every corpus intent', () => {
  // The allow-set as it stood in _extractIntents before the collapse.
  const legacyGreedy = (i) => (
    i.type === 'dm'
    || i.type === 'exec'
    || i.type === 'remind'
    || i.type === 'notify-user'
    || i.type === 'team-review'
    || i.type === 'review-done'
    || (i.type === 'task' && (i.sub === 'add' || i.sub === 'done' || i.sub === 'reject' || i.sub === 'cancel'))
    || (i.type === 'team' && (i.sub === 'role-add' || i.sub === 'role-set'))
    || (i.type === 'memory' && i.sub === 'remember')
    || (i.type === 'context' && (i.sub === 'compact' || i.sub === 'reload'))
  );
  // The ONE deliberate widening since: `context clear` gained an optional
  // continuation body, so it captures where the legacy set did not. Listed
  // explicitly rather than folded into legacyGreedy above, so the legacy record
  // stays a record and a second silent widening still fails here.
  const deliberatelyWidened = (i) => i.type === 'context' && i.sub === 'clear';
  // Verbs that did not EXIST when the legacy chain was frozen. `term exec` was
  // the previous occupant: it shipped greedy, then narrowed to line-scoped, so
  // it now agrees with the legacy oracle's silence by capturing nothing.
  // Folding an entry into legacyGreedy would forge the record, and folding it
  // into deliberatelyWidened would call it a change to something that never
  // existed — this slot is the honest landing place.
  //
  // t305 `task accept`: post-legacy, and greedy because its body is the
  // acceptance note.
  //
  // t339 `task respec`: post-legacy, and greedy because its body IS the
  // replacement spec — the one body on the board whose truncation would be
  // silently dispatched as the work itself.
  const newSinceLegacy = (i) => i.type === 'task' && (i.sub === 'accept' || i.sub === 'respec');
  let sawTerm = 0;
  for (const line of CORPUS) {
    const i = parseIntent(line);
    if (!i || i.type === 'escape' || i.type === 'end') continue;
    if (i.type === 'term') sawTerm++;
    const mode = registry.bodyModeFor(i);
    // exec is the one type whose 'json' mode is a REFINEMENT of the legacy
    // greedy capture (it terminates at the complete JSON value); it was in the
    // allow-set then and still captures now.
    const capturesNow = mode === 'greedy' || mode === 'json';
    assert.strictEqual(capturesNow, legacyGreedy(i) || deliberatelyWidened(i) || newSinceLegacy(i), `body capture differs for ${JSON.stringify(line)}`);
  }
  // The loop skips lines that don't parse, and every assertion it makes about
  // term is that term does NOT capture — which is also true of a term row the
  // corpus stopped containing. Without this the narrowing above could be
  // reverted and the loop would still pass over an empty term set.
  assert.ok(sawTerm >= 4, `ENTER: the corpus still carries term rows (saw ${sawTerm})`);
  assert.strictEqual(registry.bodyModeFor(parseIntent('[agent:exec c] {}')), 'json');
});

// ── t341: the differential above iterates the CORPUS, so a bodyMode widening on
// a sub-verb no corpus line parses to is never REACHED — the loop passes over it
// in silence. Measured, not assumed: adding a `snapshot` arm to the context row
// leaves every test in this file green.
//
// The t313/t338 sub-verb guard cannot close this. It derives from the closed
// alternation in a family's PARSE regex, and the families whose bodyMode branches
// on `.sub` are a different set: `context` and `memory` capture `(\S+)`, so they
// have no alternation to read and their bodyMode sub-verbs are invisible to it.
// Hence a separate derivation — but the corpus, the coverage predicate and the
// anti-vacuity shape are the existing ones, not a parallel mechanism.
//
// Derived from each row's bodyMode SOURCE rather than retyped, so an arm cannot
// be added to a predicate without either appearing in the corpus or turning this
// red. Reading a function's text is shape-dependent — a predicate rewritten as a
// Set lookup names no literal — so a row that branches on `.sub` and yields
// nothing FAILS here instead of contributing an empty list. That is t343's lesson
// one level down: a failed read must not be indistinguishable from nothing to read.
//
// `mentions` counts every `.sub` in the source, and the test below requires it to
// equal the literals read out. A PARTIAL read is the same hole one level down: a
// widening spelled as a negation (`i.sub !== 'list'`) on a row that also carries
// `===` arms yields a non-empty list, so a length check alone stays green while
// the widened set goes unenumerated. Equality admits only the `===` shape.
function bodyModeSubsFromSource(row) {
  const src = String(row.bodyMode);
  if (!/\.sub\b/.test(src)) return null;
  return {
    subs: [...src.matchAll(/\.sub\s*===\s*['"]([^'"]+)['"]/g)].map((m) => m[1]),
    mentions: [...src.matchAll(/\.sub\b/g)].length,
  };
}

// The pair count the predicates named when this was pinned. An arm deleted from a
// predicate shrinks the loop below rather than failing it, so the count is floored.
const MIN_BODYMODE_SUBS = 11;

test('t341: every sub-verb a bodyMode predicate names is reachable in the corpus', () => {
  let pairs = 0;
  for (const row of registry.CORE_ROWS) {
    const read = bodyModeSubsFromSource(row);
    if (read === null) continue;
    const { subs, mentions } = read;
    assert.strictEqual(subs.length, mentions,
      `${row.type}: its bodyMode mentions .sub ${mentions}x but only ${subs.length} `
      + 'sub-verb literal(s) could be read out of it — the derivation is partially or wholly '
      + 'blind, which is a vacuous pass, not a row with nothing to enumerate. If the predicate '
      + 'was legitimately refactored (a negated arm, an includes(), a switch), update '
      + '`bodyModeSubsFromSource` to read the new predicate shape');
    for (const sub of subs) {
      pairs++;
      assert.ok(corpusCovers(row.type, sub),
        `no corpus line parses to ${row.type}/${sub} — the allow-set differential never reaches its bodyMode`);
    }
  }
  assert.ok(pairs >= MIN_BODYMODE_SUBS,
    `ENTER: read the bodyMode sub-verbs off CORE_ROWS (got ${pairs}, expected >= ${MIN_BODYMODE_SUBS})`);
});

test('bodyMode of an unknown or malformed intent is none', () => {
  assert.strictEqual(registry.bodyModeFor(null), 'none');
  assert.strictEqual(registry.bodyModeFor({}), 'none');
  assert.strictEqual(registry.bodyModeFor({ type: 'nope' }), 'none');
});

// --- plugin rows: rules P1-P5 -------------------------------------------------

// `shipped: true` because the surfacing tests below read the catalog with NO
// seat list, which t661 resolves on origin: registered as custom, every row
// here would be withheld and the ORDER properties this file pins could not be
// observed at all. Origin itself is pinned in test/plugin-scope.test.js.
function withPluginVerb(spec, fn) {
  const dispose = registry.registerIntent(spec, spec.source || 'fake-plugin', { shipped: true });
  try { return fn(dispose); } finally { registry._resetPluginRows(); }
}

test('P5 — reserved and malformed verbs are refused loudly', () => {
  for (const bad of ['dm', 'who', 'task', 'end', 'escape', 'unknown']) {
    assert.throws(() => registry.registerIntent({ verb: bad, parse: () => null }, 'p'),
      /reserved by core/, `${bad} must be reserved`);
  }
  for (const bad of ['', 'Has-Caps', 'has space', '-leading', 'x'.repeat(33), 'a/b']) {
    assert.throws(() => registry.registerIntent({ verb: bad, parse: () => null }, 'p'),
      /invalid intent verb/, `${JSON.stringify(bad)} must be rejected`);
  }
  assert.throws(() => registry.registerIntent({ verb: 'ok', parse: 'nope' }, 'p'), /parse function/);
  assert.throws(() => registry.registerIntent({ verb: 'ok', parse: () => null }, ''), /requires a source/);
  // MUST-FIX 7 at the boundary: a string bodyMode is the type-level flag the
  // design rejects, so it must not be quietly accepted.
  assert.throws(() => registry.registerIntent({ verb: 'ok', parse: () => null, bodyMode: 'greedy' }, 'p'),
    /must be a function/);
});

test('P5 — a second registration of the same verb collides', () => {
  withPluginVerb({ verb: 'branch', parse: () => null }, () => {
    assert.throws(() => registry.registerIntent({ verb: 'branch', parse: () => null }, 'other'),
      /already registered/);
  });
});

test('P1 — a plugin verb is FORCED privileged, whatever it claims', () => {
  withPluginVerb({ verb: 'branch', parse: () => null, privileged: false, gateable: false }, () => {
    const r = registry.rowFor('branch');
    assert.strictEqual(r.privileged, true);
    assert.strictEqual(r.gateable, true);
    assert.strictEqual(r.source, 'fake-plugin');
  });
});

test('P1 — an absent allowlist DISABLES a plugin verb (no retroactive grant)', () => {
  withPluginVerb({ verb: 'branch', parse: () => null }, () => {
    assert.strictEqual(registry.intentEnabledFor('branch', null), false);
    assert.strictEqual(registry.intentEnabledFor('branch', undefined), false);
    assert.strictEqual(registry.intentEnabledFor('branch', []), false);
    assert.strictEqual(registry.intentEnabledFor('branch', ['dm']), false);
    assert.strictEqual(registry.intentEnabledFor('branch', ['branch']), true);
    // core semantics are untouched
    assert.strictEqual(registry.intentEnabledFor('dm', null), true);
    assert.strictEqual(registry.intentEnabledFor('reboot', null), false);
    assert.strictEqual(registry.intentEnabledFor('name', []), true);
  });
});

test('a plugin verb parses only AFTER every core row', () => {
  // A greedy plugin parse that would match anything still cannot shadow a core
  // verb, because core rows walk first.
  withPluginVerb({ verb: 'branch', parse: (l) => ({ type: 'branch', line: l }) }, () => {
    assert.strictEqual(parseIntent('[agent:who]').type, 'who');
    assert.strictEqual(parseIntent('[agent:dm bob] hi').type, 'dm');
    assert.strictEqual(parseIntent('[agent:end]').type, 'end');
    assert.strictEqual(parseIntent('\\[agent:who]').type, 'escape');
    // ...but it does get everything the core chain declined.
    assert.strictEqual(parseIntent('[agent:branch]').type, 'branch');
    assert.strictEqual(parseIntent('anything at all').type, 'branch');
  });
});

test('a plugin parse cannot claim another verb, and a throwing parse is null', () => {
  withPluginVerb({ verb: 'branch', parse: () => ({ type: 'dm', target: 'bob', body: 'x' }) }, () => {
    const i = parseIntent('[agent:branch]');
    assert.strictEqual(i.type, 'branch', 'the registry overwrites the claimed type');
    assert.strictEqual(i.target, 'bob', 'other fields survive');
  });
  withPluginVerb({ verb: 'boom', parse: () => { throw new Error('nope'); } }, () => {
    assert.strictEqual(parseIntent('[agent:boom]'), null);
    assert.strictEqual(parseIntent('[agent:who]').type, 'who', 'core still works');
  });
  withPluginVerb({ verb: 'weird', parse: () => 'not an object' }, () => {
    assert.strictEqual(parseIntent('[agent:weird]'), null);
  });
});

test('a plugin bodyMode is clamped to the three legal modes and cannot throw out', () => {
  withPluginVerb({ verb: 'b1', parse: (l) => (l === '[agent:b1]' ? {} : null), bodyMode: () => 'greedy' }, () => {
    assert.strictEqual(registry.bodyModeFor(parseIntent('[agent:b1]')), 'greedy');
  });
  withPluginVerb({ verb: 'b2', parse: (l) => (l === '[agent:b2]' ? {} : null), bodyMode: () => 'nonsense' }, () => {
    assert.strictEqual(registry.bodyModeFor(parseIntent('[agent:b2]')), 'none');
  });
  withPluginVerb({ verb: 'b3', parse: (l) => (l === '[agent:b3]' ? {} : null), bodyMode: () => { throw new Error('x'); } }, () => {
    assert.strictEqual(registry.bodyModeFor(parseIntent('[agent:b3]')), 'none');
  });
  withPluginVerb({ verb: 'b4', parse: (l) => (l === '[agent:b4]' ? {} : null) }, () => {
    assert.strictEqual(registry.bodyModeFor(parseIntent('[agent:b4]')), 'none', 'default');
  });
});

test('dispose is idempotent and removes the verb from the walk', () => {
  const dispose = registry.registerIntent({ verb: 'branch', parse: (l) => (l === '[agent:branch]' ? {} : null) }, 'p');
  assert.strictEqual(parseIntent('[agent:branch]').type, 'branch');
  dispose();
  assert.strictEqual(parseIntent('[agent:branch]'), null);
  dispose();
  assert.strictEqual(registry.rowFor('branch'), null);
});

test('unregisterSource drops every row a plugin owns and leaves others alone', () => {
  registry.registerIntent({ verb: 'one', parse: () => null }, 'p1');
  registry.registerIntent({ verb: 'two', parse: () => null }, 'p1');
  registry.registerIntent({ verb: 'three', parse: () => null }, 'p2');
  registry.unregisterSource('p1');
  assert.strictEqual(registry.rowFor('one'), null);
  assert.strictEqual(registry.rowFor('two'), null);
  assert.ok(registry.rowFor('three'));
  registry._resetPluginRows();
});

// --- R-INT-4 catalog projection + P2 allowlist --------------------------------

test('catalogRows with no plugin is GATEABLE_INTENTS, in ITS order, unchanged', () => {
  const rows = registry.catalogRows();
  assert.strictEqual(rows.length, GATEABLE_INTENTS.length);
  rows.forEach((r, k) => {
    assert.strictEqual(r.type, GATEABLE_INTENTS[k].type);
    assert.strictEqual(r.label, GATEABLE_INTENTS[k].label);
    assert.strictEqual(r.privileged, PRIVILEGED_INTENTS.has(r.type));
    assert.strictEqual(r.source, 'core');
  });
});

test('catalogRows appends plugin rows as a TAIL — existing checklist order is untouched', () => {
  withPluginVerb({ verb: 'branch', parse: () => null, label: 'Report git branch (branch)' }, () => {
    const rows = registry.catalogRows();
    assert.strictEqual(rows.length, GATEABLE_INTENTS.length + 1);
    assert.deepStrictEqual(rows.slice(0, -1).map((r) => r.type), GATEABLE_INTENTS.map((i) => i.type));
    const last = rows[rows.length - 1];
    assert.deepStrictEqual(last, { type: 'branch', label: 'Report git branch (branch)', privileged: true, source: 'fake-plugin' });
  });
});

test('a plugin row gets a default label naming its owner', () => {
  withPluginVerb({ verb: 'branch', parse: () => null }, () => {
    assert.match(registry.rowFor('branch').label, /branch.*fake-plugin/);
  });
});

test('P2 — allowlistFromChecked matches intent-catalog exactly when no plugin verb is checked', () => {
  const cases = [
    [],
    ['dm'],
    ['dm', 'who'],
    GATEABLE_INTENTS.filter((i) => !PRIVILEGED_INTENTS.has(i.type)).map((i) => i.type),
    GATEABLE_INTENTS.map((i) => i.type),
  ];
  for (const c of cases) {
    assert.deepStrictEqual(registry.allowlistFromChecked(c), intentsAllowlistFromChecked(c), JSON.stringify(c));
  }
  withPluginVerb({ verb: 'branch', parse: () => null }, () => {
    for (const c of cases) {
      assert.deepStrictEqual(registry.allowlistFromChecked(c), intentsAllowlistFromChecked(c),
        `registering a plugin verb must not change the core answer for ${JSON.stringify(c)}`);
    }
  });
});

test('P2 — a checked plugin verb forces an explicit array, never the null collapse', () => {
  withPluginVerb({ verb: 'branch', parse: () => null }, () => {
    const allCore = GATEABLE_INTENTS.filter((i) => !PRIVILEGED_INTENTS.has(i.type)).map((i) => i.type);
    // Every core box checked collapses to null on its own...
    assert.strictEqual(intentsAllowlistFromChecked(allCore), null);
    // ...but adding the plugin grant must NOT, or the grant silently vanishes
    // (absence reads as "privileged off").
    const got = registry.allowlistFromChecked([...allCore, 'branch']);
    assert.ok(Array.isArray(got));
    assert.ok(got.includes('branch'));
    assert.deepStrictEqual(got.slice(0, -1), allCore, 'core half stays in catalog order');
    assert.strictEqual(registry.intentEnabledFor('branch', got), true);
    // A subset + the plugin verb keeps both halves.
    const sub = registry.allowlistFromChecked(['dm', 'branch']);
    assert.deepStrictEqual(sub, ['dm', 'branch']);
    // Unknown types are dropped, same as the core function does.
    assert.deepStrictEqual(registry.allowlistFromChecked(['dm', 'nope', 'branch']), ['dm', 'branch']);
  });
});

// --- P3 grammar lines ---------------------------------------------------------

test('P3 — pluginGrammarLines is empty with no plugins, so buildIpcPrompt sees no third arg', () => {
  assert.deepStrictEqual(registry.pluginGrammarLines(null), []);
  assert.deepStrictEqual(registry.pluginGrammarLines(['dm']), []);
});

test('P3 — a plugin line renders only for a seat that was GRANTED the verb', () => {
  withPluginVerb({ verb: 'branch', parse: () => null, promptLines: '  [agent:branch]   Report the branch.' }, () => {
    assert.deepStrictEqual(registry.pluginGrammarLines(null), [], 'absent list = not granted');
    assert.deepStrictEqual(registry.pluginGrammarLines(['dm']), []);
    assert.deepStrictEqual(registry.pluginGrammarLines(['branch']), ['  [agent:branch]   Report the branch.']);
  });
  withPluginVerb({ verb: 'quiet', parse: () => null }, () => {
    assert.deepStrictEqual(registry.pluginGrammarLines(['quiet']), [], 'no promptLines = no line (the resend precedent)');
  });
});

// --- P4 near-miss list --------------------------------------------------------

test('P4 — every name in the bounce list is a real registry verb', () => {
  for (const n of registry.CORE_VALID_INTENT_NAMES) {
    assert.ok(registry.rowFor(n), `bounce list names "${n}", which is not a registry verb`);
  }
});

test('P4 — validIntentNames appends plugin verbs before the trailing end', () => {
  const bare = registry.validIntentNames();
  assert.deepStrictEqual(bare, [...registry.CORE_VALID_INTENT_NAMES, 'end']);
  withPluginVerb({ verb: 'branch', parse: () => null }, () => {
    const withPlugin = registry.validIntentNames();
    assert.deepStrictEqual(withPlugin, [...registry.CORE_VALID_INTENT_NAMES, 'branch', 'end']);
  });
});

test('P4 — the bounce list omits `team`, a PRE-EXISTING gap this refactor does not change', () => {
  // Documented, not silently fixed: Phase 1 is a zero-behavior-change refactor,
  // and this string is user-visible copy. Flagged for a follow-up.
  assert.ok(registry.rowFor('team'), 'team is a real verb');
  assert.ok(!registry.CORE_VALID_INTENT_NAMES.includes('team'), 'still omitted, as it shipped');
});

test('P5 — a collision identifies the holder, so the refusal is actionable (t20)', () => {
  // The message alone is not enough: the LOADER has to tell a structural refusal
  // apart from a plugin that crashed, or it strikes the wrong plugin and
  // quarantines it (t20). `code` is what it branches on; `heldBy` is what the
  // settings row shows the user.
  withPluginVerb({ verb: 'branch', parse: () => null, source: 'git-branches' }, () => {
    let err = null;
    try { registry.registerIntent({ verb: 'branch', parse: () => null }, 'other'); } catch (e) { err = e; }
    assert.ok(err, 'still throws');
    assert.strictEqual(err.code, 'EVERBTAKEN');
    assert.strictEqual(err.verb, 'branch');
    assert.strictEqual(err.heldBy, 'git-branches', 'the HOLDER, not the caller');
    assert.match(err.message, /already registered by plugin "git-branches"/);
  });
});

// --- t222: the raw (un-ANSI-stripped) body ------------------------------------
// The scanner strips ANSI before any row parses. For every other verb that is a
// convenience; for `term` the body is EXECUTED, so a strip silently rewrites the
// command and then runs the rewrite — the exact outcome "rejected, not stripped"
// exists to prevent. parseWithRegistry therefore carries the uncleaned line as an
// optional second argument, which only parseTerm reads.

test('t222 — parseTerm takes its BODY from the raw line, escapes intact', () => {
  // Built from a code point: a raw ESC in this source is invisible and would not
  // survive reformatting, turning the assertion into one about ordinary text.
  const ESC = String.fromCharCode(0x1b);
  const raw = `[agent:term exec] echo a${ESC}[Kb`;
  const cleaned = raw.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');
  assert.strictEqual(cleaned, '[agent:term exec] echo ab',
    'ENTER: the strip really does rewrite this command into a different one');

  const out = registry.parseWithRegistry(cleaned, raw);
  assert.strictEqual(out.type, 'term');
  assert.strictEqual(out.body, `echo a${ESC}[Kb`,
    'the vetter must see the escape — it is what makes this a refusal instead of a silent rewrite');
});

test('t222 — the raw line is only trusted when it parses to the same verb and sub', () => {
  const ESC = String.fromCharCode(0x1b);
  // An escape inside the BRACKETS is what made the line parse at all: the raw
  // form does not match, so the cleaned body is the only honest answer and the
  // intent must not be lost.
  const raw = `[agent:term${ESC}[0m exec] ls`;
  const cleaned = raw.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');
  assert.strictEqual(registry.parseWithRegistry(cleaned, raw).body, 'ls');

  // A raw line naming a DIFFERENT sub cannot redirect the verb either.
  const out = registry.parseWithRegistry('[agent:term exec] ls', '[agent:term status] ls');
  assert.strictEqual(out.sub, 'exec', 'the cleaned line decides the sub');
  assert.strictEqual(out.body, 'ls');
});

test('t222 — the second argument is optional, and no other verb reads it', () => {
  // A one-argument call is still the contract (test/plugin-scope.test.js makes
  // one), and a row that started reading `raw` would change behaviour for every
  // caller that does not pass it.
  assert.deepStrictEqual(registry.parseWithRegistry('[agent:term exec] ls'),
    { type: 'term', sub: 'exec', body: 'ls' });
  // Same line, a raw form that differs everywhere: every non-term verb ignores it.
  assert.deepStrictEqual(registry.parseWithRegistry('[agent:dm bob] hi', '[agent:dm zed] DIFFERENT'),
    { type: 'dm', target: 'bob', urgent: false, body: 'hi' });
  assert.deepStrictEqual(registry.parseWithRegistry('[agent:exec c] {}', '[agent:exec other] {"x":1}'),
    { type: 'exec', cmd: 'c', body: '{}' });
});
