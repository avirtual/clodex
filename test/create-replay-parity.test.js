const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

function callArgs(src, open) {
  const args = [];
  let depth = 0;
  let cur = '';
  let i = open;
  while (i < src.length) {
    const c = src[i];
    const d = src[i + 1];
    if (c === '/' && d === '/') { while (i < src.length && src[i] !== '\n') i++; continue; }
    if (c === '/' && d === '*') { i += 2; while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i++; i += 2; continue; }
    if (c === '"' || c === "'" || c === '`') {
      const q = c;
      cur += c; i++;
      while (i < src.length && src[i] !== q) {
        if (src[i] === '\\') { cur += src[i]; i++; }
        cur += src[i]; i++;
      }
      cur += q; i++; continue;
    }
    if ('([{'.includes(c)) { depth++; if (depth === 1) { i++; continue; } }
    if (')]}'.includes(c)) {
      depth--;
      if (depth === 0) { if (cur.trim()) args.push(cur.trim()); return args; }
    }
    if (c === ',' && depth === 1) { args.push(cur.trim()); cur = ''; i++; continue; }
    cur += c; i++;
  }
  return args;
}

function commentRanges(src) {
  const ranges = [];
  let prev = '';
  const OPERAND_EXPECTED = /[(,=:[!&|?{};+\-*%~^<>]/;
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    const d = src[i + 1];
    if (c === '/' && d === '/') {
      const s = i;
      while (i < src.length && src[i] !== '\n') i++;
      ranges.push([s, i]);
      continue;
    }
    if (c === '/' && d === '*') {
      const s = i;
      i += 2;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i++;
      i = Math.min(i + 2, src.length);
      ranges.push([s, i]);
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      const q = c;
      i++;
      while (i < src.length && src[i] !== q) { if (src[i] === '\\') i++; i++; }
      i++;
      prev = q;
      continue;
    }
    if (c === '/' && (prev === '' || OPERAND_EXPECTED.test(prev))) {
      i++;
      let inClass = false;
      while (i < src.length) {
        const ch = src[i];
        if (ch === '\\') { i += 2; continue; }
        if (ch === '\n') break;
        if (ch === '[') inClass = true;
        else if (ch === ']') inClass = false;
        else if (ch === '/' && !inClass) break;
        i++;
      }
      i++;
      prev = '/';
      continue;
    }
    if (!/\s/.test(c)) prev = c;
    i++;
  }
  return ranges;
}

const normalise = (t) => t.replace(/\s+/g, ' ').replace(/\b(entry|rec|beforeKill)\b/g, 'E');

function restoreSites() {
  const out = [];
  for (const file of fs.readdirSync(ROOT).filter((f) => f.endsWith('.js')).sort()) {
    const src = fs.readFileSync(path.join(ROOT, file), 'utf8');
    const comments = commentRanges(src);
    const re = /(\w+)\.create\s*\(/g;
    let m;
    while ((m = re.exec(src))) {
      if (m[1] === 'Object') continue;
      if (comments.some(([s, e]) => m.index >= s && m.index < e)) continue;
      const args = callArgs(src, m.index + m[0].length - 1);
      if (args.length <= 2) continue;
      if (args.length >= 20 && args[19].trim() === 'true') continue;
      out.push({ file, line: src.slice(0, m.index).split('\n').length, args: args.map(normalise) });
    }
  }
  return out;
}

const FIRST = 10;
const LAST = 26;

const TAIL = [
  'E.agents || []',
  'E.denyBuiltins || []',
  'E.disabledTools || []',
  'E.disabledSkills || []',
  'E.injectSkills || []',
  'E.systemPromptFile || null',
  'E.appendPromptFiles || []',
  'Array.isArray(E.execCommands) ? E.execCommands : []',
  'Array.isArray(E.intents) ? E.intents : null',
  "(E.env && typeof E.env === 'object') ? E.env : null",
  'false',
  'E.noWire === true',
  'Array.isArray(E.plugins) ? E.plugins : null',
  'Array.isArray(E.shellDeny) ? E.shellDeny : null',
  "typeof E.fixFor === 'string' ? E.fixFor : null",
  "E.io || 'pty'",
  "typeof E.effort === 'string' ? E.effort : null",
];

const PATCH_REASON = 'applySessionArgs replays the Edit-dialog patch over the record, so this field is the patched value, not the persisted one';

const SITES = [
  { file: 'engine.js', label: 'restartSession', differs: {} },
  { file: 'engine.js', label: 'applySessionArgs', differs: {
    10: ['nextAgents', PATCH_REASON],
    11: ['nextDeny', PATCH_REASON],
    12: ['nextTools', PATCH_REASON],
    13: ['nextSkills', PATCH_REASON],
    14: ['nextInject', PATCH_REASON],
    15: ['nextSysFile', PATCH_REASON],
    16: ['nextAppend', PATCH_REASON],
    17: ['nextExec', PATCH_REASON],
    18: ['restartIntents', PATCH_REASON],
    19: ['(nextEnv && Object.keys(nextEnv).length) ? nextEnv : null', PATCH_REASON],
    22: ['nextPlugins', PATCH_REASON],
    25: ['nextIo', PATCH_REASON],
    26: ['nextEffort', PATCH_REASON],
  } },
  { file: 'ipc-handlers.js', label: 'session:retrySpawn', differs: {} },
  { file: 'remote-wiring.js', label: 'importCreate (far half of Move to a peer)', differs: {
    17: ['[]', 'exec grants never cross the wire'],
    18: ['withoutPrivilegedIntentsFor(Array.isArray(E.intents) ? E.intents : null)', 'privileged intents are stripped from a seat arriving from another box'],
    19: ['envKeys.length ? env : null', 'the env is rebuilt by importEnv for the far box, not replayed from the record'],
  } },
  { file: 'session-manager.js', label: 'rename', differs: {} },
  { file: 'session-manager.js', label: 'move', differs: {} },
  { file: 'session-manager.js', label: 'moveToPeer failure arm', differs: {} },
  { file: 'session-manager.js', label: '[agent:context reload]', differs: {} },
  { file: 'session-manager.js', label: '[agent:scratch end] respawn', differs: {} },
  { file: 'session-restore.js', label: 'restoreSessionsForWorkspace', differs: {} },
];

test('create replay parity: every restore site is a row', () => {
  const found = restoreSites();
  assert.strictEqual(SITES.length, 10, 'the table itself is the literal count');
  assert.strictEqual(found.length, 10,
    `the number of restore create() sites changed (found ${found.length}, table has 10) — read the new site and add its row:\n`
    + found.map((s) => `  ${s.file}:${s.line} arity=${s.args.length}`).join('\n'));
  found.forEach((s, i) => {
    assert.strictEqual(s.file, SITES[i].file,
      `restore sites drifted at #${i}: found ${s.file}:${s.line}, table expects ${SITES[i].file} (${SITES[i].label})`);
  });
});

test('create replay parity: every restore site replays the same tail, positions 10-26', () => {
  const found = restoreSites();
  assert.strictEqual(found.length, SITES.length, 'count checked above');
  found.forEach((s, i) => {
    const row = SITES[i];
    const where = `${s.file}:${s.line} (${row.label})`;
    assert.strictEqual(s.args.length, LAST,
      `${where} passes ${s.args.length} arguments; every restore site replays all ${LAST} — `
      + `position ${s.args.length + 1} (${TAIL[s.args.length + 1 - FIRST] || '?'}) is missing`);
    for (let pos = FIRST; pos <= LAST; pos++) {
      const want = row.differs[pos] ? row.differs[pos][0] : TAIL[pos - FIRST];
      assert.strictEqual(s.args[pos - 1], want,
        `${where} position ${pos}: expected \`${want}\`, found \`${s.args[pos - 1]}\``);
    }
  });
});

test('create replay parity: no exception names a position the site does not differ on', () => {
  for (const row of SITES) {
    for (const [pos, [lit, why]] of Object.entries(row.differs)) {
      assert.notStrictEqual(lit, TAIL[pos - FIRST], `${row.label} position ${pos} is listed as differing but matches the tail`);
      assert.ok(why.length > 10, `${row.label} position ${pos} needs a reason`);
    }
  }
});
