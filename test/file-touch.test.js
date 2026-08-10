// Run: node --test
// Touched-files feed: the wire-side SSE collector (streamed input_json_delta
// reassembly, hot-path gating, give-up cap), its `calls` channel (the activity
// feed's tool name + argument snippet) and the pure jsonl extraction + ring
// semantics (dedupe-by-path, newest-first, cap, subagent badge).
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { FileToolCollector, ARG_CAP, clampArg } = require('../wire/sse');
const { extractFileTouches, noteFileTouches, TOUCH_RING_CAP } = require('../file-touch');

// --- wire/sse.js FileToolCollector -----------------------------------------

const ev = (type, obj) => [type, JSON.stringify({ type, ...obj })];

function feedToolUse(c, index, name, jsonChunks) {
  c.onEvent(...ev('content_block_start', { index, content_block: { type: 'tool_use', name, input: {} } }));
  for (const chunk of jsonChunks) {
    c.onEvent(...ev('content_block_delta', { index, delta: { type: 'input_json_delta', partial_json: chunk } }));
  }
  c.onEvent(...ev('content_block_stop', { index }));
}

test('collector: reassembles file_path split across deltas', () => {
  const c = new FileToolCollector();
  feedToolUse(c, 0, 'Edit', ['{"file_pa', 'th": "/tmp/a', '.js", "old_string": "x"']);
  assert.deepStrictEqual(c.files, [{ tool: 'Edit', path: '/tmp/a.js' }]);
});

test('collector: path key not first (real Edit streams replace_all ahead)', () => {
  const c = new FileToolCollector();
  feedToolUse(c, 0, 'Edit', ['{"replace_all": false, ', '"file_path": "/w/b.py"', ', "old_string": "y"']);
  assert.deepStrictEqual(c.files, [{ tool: 'Edit', path: '/w/b.py' }]);
});

test('collector: notebook_path, escaped characters unescaped', () => {
  const c = new FileToolCollector();
  feedToolUse(c, 2, 'NotebookEdit', ['{"notebook_path": "/tmp/sp ace\\\\n.ipynb"}']);
  assert.strictEqual(c.files[0].path, '/tmp/sp ace\\n.ipynb');
});

test('collector: non-file tools and text blocks ignored', () => {
  const c = new FileToolCollector();
  feedToolUse(c, 0, 'Bash', ['{"command": "rm -rf /tmp/x"}']);
  c.onEvent(...ev('content_block_start', { index: 1, content_block: { type: 'text' } }));
  c.onEvent(...ev('content_block_delta', { index: 1, delta: { type: 'text_delta', text: 'hi' } }));
  assert.deepStrictEqual(c.files, []);
});

test('collector: two file tools in one stream, order kept', () => {
  const c = new FileToolCollector();
  feedToolUse(c, 0, 'Write', ['{"file_path": "/a", "content": "1"}']);
  feedToolUse(c, 1, 'Edit', ['{"file_path": "/b", "old_string": "1"}']);
  assert.deepStrictEqual(c.files.map((f) => f.path), ['/a', '/b']);
});

test('collector: stops accumulating after the path is found', () => {
  const c = new FileToolCollector();
  c.onEvent(...ev('content_block_start', { index: 0, content_block: { type: 'tool_use', name: 'Write', input: {} } }));
  c.onEvent(...ev('content_block_delta', { index: 0, delta: { type: 'input_json_delta', partial_json: '{"file_path": "/done"' } }));
  // path already extracted — a later huge delta must not grow anything
  const big = 'x'.repeat(200000);
  c.onEvent(...ev('content_block_delta', { index: 0, delta: { type: 'input_json_delta', partial_json: big } }));
  c.onEvent(...ev('content_block_stop', { index: 0 }));
  assert.deepStrictEqual(c.files, [{ tool: 'Write', path: '/done' }]);
});

test('collector: gives up past the cap when no path key ever arrives', () => {
  const c = new FileToolCollector();
  const chunks = [];
  for (let i = 0; i < 80; i++) chunks.push('"pad": "' + 'z'.repeat(1000) + '", ');
  feedToolUse(c, 0, 'Edit', ['{'].concat(chunks));
  assert.deepStrictEqual(c.files, []);
});

test('collector: garbage data and unrelated events are inert', () => {
  const c = new FileToolCollector();
  c.onEvent('content_block_delta', 'not json');
  c.onEvent('message_start', JSON.stringify({ type: 'message_start', message: {} }));
  c.onEvent(null, JSON.stringify({ type: 'content_block_stop', index: 9 }));
  assert.deepStrictEqual(c.files, []);
  assert.deepStrictEqual(c.reads, []);
});

// --- Read channel (plugin turn-text feed `reads`) ----------------------------

test('collector: a Read is captured into reads with offset/limit, never files', () => {
  const c = new FileToolCollector();
  feedToolUse(c, 0, 'Read', ['{"file_path": "/tmp/big.js", "offset": 100, "limit": 50}']);
  assert.deepStrictEqual(c.reads, [{ tool: 'Read', path: '/tmp/big.js', offset: 100, limit: 50 }]);
  assert.deepStrictEqual(c.files, []); // a Read is not a mutation
});

test('collector: a Read without offset/limit omits those keys', () => {
  const c = new FileToolCollector();
  feedToolUse(c, 0, 'Read', ['{"file_path": "/a/b.py"}']);
  assert.deepStrictEqual(c.reads, [{ tool: 'Read', path: '/a/b.py' }]);
});

test('collector: Read input split across deltas parses at stop', () => {
  const c = new FileToolCollector();
  feedToolUse(c, 0, 'Read', ['{"file_pa', 'th": "/split', '/x.js", "limit"', ': 20}']);
  assert.deepStrictEqual(c.reads, [{ tool: 'Read', path: '/split/x.js', limit: 20 }]);
});

test('collector: Reads and mutations stay in strictly separate channels', () => {
  const c = new FileToolCollector();
  feedToolUse(c, 0, 'Read', ['{"file_path": "/r1"}']);
  feedToolUse(c, 1, 'Edit', ['{"file_path": "/e1", "old_string": "x"}']);
  feedToolUse(c, 2, 'Write', ['{"file_path": "/w1", "content": "y"}']);
  feedToolUse(c, 3, 'Read', ['{"file_path": "/r2", "offset": 5}']);
  // No cross-contamination: files = mutations only, reads = Reads only.
  assert.deepStrictEqual(c.files, [{ tool: 'Edit', path: '/e1' }, { tool: 'Write', path: '/w1' }]);
  assert.deepStrictEqual(c.reads, [{ tool: 'Read', path: '/r1' }, { tool: 'Read', path: '/r2', offset: 5 }]);
});

test('collector: a malformed Read input still yields the path via regex fallback', () => {
  const c = new FileToolCollector();
  // trailing garbage → JSON.parse fails; the path regex still matches, and
  // offset/limit are simply absent (best-effort, no partial number guessing).
  feedToolUse(c, 0, 'Read', ['{"file_path": "/frag.js", "offset": 10 NOPE']);
  assert.deepStrictEqual(c.reads, [{ tool: 'Read', path: '/frag.js' }]);
});

test('collector: an oversized Read input is dropped (memory bound)', () => {
  const c = new FileToolCollector();
  const chunks = [];
  for (let i = 0; i < 80; i++) chunks.push('"pad": "' + 'z'.repeat(1000) + '", ');
  feedToolUse(c, 0, 'Read', ['{'].concat(chunks).concat(['"file_path": "/late"}']));
  assert.deepStrictEqual(c.reads, []); // exceeded the cap before stop — dropped
});

// --- calls channel (feed row text) ------------------------------------------

test('collector: every tool_use gets a calls record, in stream order', () => {
  const c = new FileToolCollector();
  feedToolUse(c, 0, 'Bash', ['{"command": "npm test"}']);
  feedToolUse(c, 1, 'Read', ['{"file_path": "/a/b.js"}']);
  feedToolUse(c, 2, 'Edit', ['{"file_path": "/a/c.js", "old_string": "x"}']);
  feedToolUse(c, 3, 'Grep', ['{"pattern": "TODO", "path": "/src"}']);
  feedToolUse(c, 4, 'Glob', ['{"pattern": "**/*.ts"}']);
  feedToolUse(c, 5, 'Task', ['{"description": "audit the ring", "prompt": "long..."}']);
  assert.deepStrictEqual(c.calls, [
    { name: 'Bash', arg: 'npm test' },
    { name: 'Read', arg: '/a/b.js' },      // reuses the reads extraction
    { name: 'Edit', arg: '/a/c.js' },      // reuses the files extraction
    { name: 'Grep', arg: 'TODO' },
    { name: 'Glob', arg: '**/*.ts' },
    { name: 'Task', arg: 'audit the ring' },
  ]);
});

// A name with no snippet is still a row the feed must show — dropping it would
// under-report the turn's work rather than merely showing it thinly.
test('collector: an untracked tool still lands as a name-only record', () => {
  const c = new FileToolCollector();
  feedToolUse(c, 0, 'WebFetch', ['{"url": "https://example.com"}']);
  assert.deepStrictEqual(c.calls, [{ name: 'WebFetch', arg: null }]);
  assert.deepStrictEqual(c.files, []);
  assert.deepStrictEqual(c.reads, []);
});

// Clamping alone would NOT do this: ARG_CAP can fall well past several line
// breaks, so a heredoc would paste its whole body into one feed row.
test('collector: a multi-line Bash command yields a single-line snippet', () => {
  const c = new FileToolCollector();
  const command = 'cat <<EOF > /tmp/x\nline two\nline three\nEOF';
  feedToolUse(c, 0, 'Bash', [JSON.stringify({ command })]);
  assert.deepStrictEqual(c.calls, [{ name: 'Bash', arg: 'cat <<EOF > /tmp/x' }]);
  assert.ok(!c.calls[0].arg.includes('\n'), 'ENTER: the snippet carries no newline');
});

test('collector: a carriage return also ends the snippet', () => {
  const c = new FileToolCollector();
  feedToolUse(c, 0, 'Bash', [JSON.stringify({ command: 'first\r\nsecond' })]);
  assert.strictEqual(c.calls[0].arg, 'first');
});

test('collector: a long single-line command is clamped to ARG_CAP', () => {
  const c = new FileToolCollector();
  const command = 'echo ' + 'a'.repeat(500);
  feedToolUse(c, 0, 'Bash', [JSON.stringify({ command })]);
  assert.strictEqual(c.calls[0].arg.length, ARG_CAP);
  assert.strictEqual(c.calls[0].arg, command.slice(0, ARG_CAP));
});

test('collector: a snippet split across deltas reassembles', () => {
  const c = new FileToolCollector();
  feedToolUse(c, 0, 'Bash', ['{"comm', 'and": "git ', 'status --sh', 'ort"}']);
  assert.strictEqual(c.calls[0].arg, 'git status --short');
});

// A `\uXXXX` or `\"` straddling a delta boundary must not be committed as the
// half the buffer happens to hold — the decode would then be of a broken escape.
test('collector: an escape split across deltas is not committed half-read', () => {
  const c = new FileToolCollector();
  feedToolUse(c, 0, 'Grep', ['{"pattern": "a\\u00', 'e9b"}']);
  assert.strictEqual(c.calls[0].arg, 'aéb');
});

test('collector: an escaped quote inside the snippet does not end it early', () => {
  const c = new FileToolCollector();
  feedToolUse(c, 0, 'Bash', [JSON.stringify({ command: 'echo "hi there"' })]);
  assert.strictEqual(c.calls[0].arg, 'echo "hi there"');
});

// The snippet must not force the block to buffer past the point the path
// machinery would have stopped at — the give-up cap is the memory bound.
test('collector: a tool whose arg key never arrives lands name-only', () => {
  const c = new FileToolCollector();
  const chunks = [];
  for (let i = 0; i < 80; i++) chunks.push('"pad": "' + 'z'.repeat(1000) + '", ');
  feedToolUse(c, 0, 'Bash', ['{'].concat(chunks));
  assert.deepStrictEqual(c.calls, [{ name: 'Bash', arg: null }]);
});

test('collector: an arg key arriving late but under the cap is still captured', () => {
  const c = new FileToolCollector();
  feedToolUse(c, 0, 'Task', ['{"subagent_type": "explore", ', '"prompt": "go", ', '"description": "sweep"}']);
  assert.strictEqual(c.calls[0].arg, 'sweep');
});

// The block is dropped from tracking once the snippet is settled; a later delta
// on the same index must neither grow memory nor overwrite the snippet.
test('collector: a settled snippet ignores the rest of the input', () => {
  const c = new FileToolCollector();
  c.onEvent(...ev('content_block_start', { index: 0, content_block: { type: 'tool_use', name: 'Bash', input: {} } }));
  c.onEvent(...ev('content_block_delta', { index: 0, delta: { type: 'input_json_delta', partial_json: '{"command": "ls"' } }));
  c.onEvent(...ev('content_block_delta', { index: 0, delta: { type: 'input_json_delta', partial_json: ', "x": "' + 'q'.repeat(200000) + '"}' } }));
  c.onEvent(...ev('content_block_stop', { index: 0 }));
  assert.deepStrictEqual(c.calls, [{ name: 'Bash', arg: 'ls' }]);
});

// Records are paired to their block BY REFERENCE, not by index into a second
// list: a dropped or give-up block in the middle would otherwise shift every
// later snippet onto the wrong tool — silently, since both lists stay plausible.
test('collector: a dropped block does not shift later snippets onto other tools', () => {
  const c = new FileToolCollector();
  feedToolUse(c, 0, 'Bash', ['{"command": "first"}']);
  const chunks = [];
  for (let i = 0; i < 80; i++) chunks.push('"pad": "' + 'z'.repeat(1000) + '", ');
  feedToolUse(c, 1, 'Edit', ['{'].concat(chunks));   // gives up, no path
  feedToolUse(c, 2, 'Bash', ['{"command": "third"}']);
  assert.deepStrictEqual(c.calls, [
    { name: 'Bash', arg: 'first' },
    { name: 'Edit', arg: null },
    { name: 'Bash', arg: 'third' },
  ]);
});

test('collector: interleaved blocks fill their own records', () => {
  const c = new FileToolCollector();
  const start = (i, name) => c.onEvent(...ev('content_block_start', { index: i, content_block: { type: 'tool_use', name, input: {} } }));
  const d = (i, s) => c.onEvent(...ev('content_block_delta', { index: i, delta: { type: 'input_json_delta', partial_json: s } }));
  start(0, 'Bash'); start(1, 'Grep');
  d(1, '{"pattern": "abc"}');
  d(0, '{"command": "def"}');
  c.onEvent(...ev('content_block_stop', { index: 0 }));
  c.onEvent(...ev('content_block_stop', { index: 1 }));
  assert.deepStrictEqual(c.calls, [{ name: 'Bash', arg: 'def' }, { name: 'Grep', arg: 'abc' }]);
});

// --- clampArg retention -----------------------------------------------------

// The flatten is the whole point of clampArg, and it is INVISIBLE to every
// ordinary assertion: a SlicedString and a flat string have identical length,
// content, equality — and identical v8.serialize bytes, so a serialized-size
// assertion cannot tell them apart either. Only heap retention differs. Measured
// here rather than asserted structurally: a reversion to a bare `.slice()`
// pins the whole parent input per snippet, so retention scales with the number
// of snippets kept; the flatten's does not.
test('clampArg: a clamped snippet does not retain its parent', () => {
  const v8 = require('node:v8');
  const vm = require('node:vm');
  v8.setFlagsFromString('--expose-gc');
  const gc = vm.runInNewContext('gc');
  const PARENT = 1_000_000;

  // Retained bytes for `n` snippets, each cut from its OWN million-char parent.
  // The parents are unreachable after the loop, so anything still held is held
  // BY the snippets.
  const retainedFor = (n, cut, wantLen) => {
    gc(); gc();
    const before = process.memoryUsage().heapUsed;
    const kept = [];
    for (let i = 0; i < n; i++) {
      kept.push(cut(String(i).padStart(8, '0') + 'x'.repeat(PARENT)));
    }
    gc(); gc();
    const after = process.memoryUsage().heapUsed;
    assert.strictEqual(kept.length, n, 'ENTER: the snippets are alive across the measurement');
    assert.strictEqual(kept[0].length, wantLen, 'ENTER: the cut produced the length under test');
    return after - before;
  };

  const flat10 = retainedFor(10, clampArg, ARG_CAP);
  const flat80 = retainedFor(80, clampArg, ARG_CAP);
  // Slicing is the reversion this guards against — measured, so the numbers
  // below are a real contrast and not a threshold picked to pass.
  const sliced80 = retainedFor(80, (s) => s.slice(0, ARG_CAP), ARG_CAP);

  assert.ok(sliced80 > 40 * PARENT,
    `ENTER: the sliced control DID pin its parents (retained ${sliced80} for 80)`);
  assert.ok(flat80 < 8 * PARENT,
    `flattened snippets retain far less than their parents (retained ${flat80} for 80)`);
  // The shape, not the absolute number: 8x the snippets must not mean ~8x the
  // bytes. Slicing gives 8x here; the flatten's growth is noise-level.
  assert.ok(flat80 < flat10 + 8 * PARENT,
    `flattened retention does not scale with snippet count (n=10 ${flat10}, n=80 ${flat80})`);

  // The UNDER-cap branch, and the reason the flatten cannot be gated on
  // `length > ARG_CAP`: a short string pins its parent exactly as hard as a long
  // one. `_tryArg`'s decode fallback reaches here for real — a malformed escape
  // inside the first 120 chars leaves `seg`, a cons of 64KB buffer fragments,
  // whose decoded length is under the cap. Without this the gated version passes
  // everything above.
  const SHORT = 40;
  const shortFlat = retainedFor(80, (s) => clampArg(s.slice(0, SHORT)), SHORT);
  const shortSliced = retainedFor(80, (s) => s.slice(0, SHORT), SHORT);
  assert.ok(shortSliced > 40 * PARENT,
    `ENTER: the under-cap sliced control DID pin its parents (retained ${shortSliced} for 80)`);
  assert.ok(shortFlat < 8 * PARENT,
    `an UNDER-cap snippet is flattened too (retained ${shortFlat} for 80)`);
});

// --- file-touch.js ----------------------------------------------------------

const asst = (blocks, extra = {}) => ({ type: 'assistant', message: { content: blocks }, ...extra });

test('extractFileTouches: pulls file tools from a Claude assistant entry', () => {
  const got = extractFileTouches(asst([
    { type: 'text', text: 'editing' },
    { type: 'tool_use', name: 'Edit', input: { file_path: '/a', old_string: 'x', new_string: 'y' } },
    { type: 'tool_use', name: 'Bash', input: { command: 'ls' } },
    { type: 'tool_use', name: 'NotebookEdit', input: { notebook_path: '/n.ipynb' } },
  ]));
  assert.deepStrictEqual(got, [
    { tool: 'Edit', path: '/a', sub: false },
    { tool: 'NotebookEdit', path: '/n.ipynb', sub: false },
  ]);
});

test('extractFileTouches: sidechain entries flagged sub', () => {
  const got = extractFileTouches(asst(
    [{ type: 'tool_use', name: 'Write', input: { file_path: '/s' } }],
    { isSidechain: true },
  ));
  assert.strictEqual(got[0].sub, true);
});

test('extractFileTouches: non-assistant / malformed → []', () => {
  assert.deepStrictEqual(extractFileTouches({ type: 'user' }), []);
  assert.deepStrictEqual(extractFileTouches(null), []);
  assert.deepStrictEqual(extractFileTouches(asst('not-an-array')), []);
  assert.deepStrictEqual(extractFileTouches(asst([{ type: 'tool_use', name: 'Edit', input: {} }])), []);
});

test('noteFileTouches: dedupe by path, newest first, count accumulates', () => {
  const ring = [];
  noteFileTouches(ring, [{ tool: 'Write', path: '/a' }], { ts: 1, resolve: path.resolve });
  noteFileTouches(ring, [{ tool: 'Edit', path: '/b' }], { ts: 2, resolve: path.resolve });
  noteFileTouches(ring, [{ tool: 'Edit', path: '/a' }], { ts: 3, resolve: path.resolve });
  assert.strictEqual(ring.length, 2);
  assert.deepStrictEqual(ring[0], { path: '/a', tool: 'Edit', ts: 3, count: 2, sub: false });
  assert.strictEqual(ring[1].path, '/b');
});

test('noteFileTouches: relative paths resolve against cwd; sub badge sticks', () => {
  const ring = [];
  noteFileTouches(ring, [{ tool: 'Edit', path: 'src/x.js' }], { cwd: '/proj', ts: 1, sub: true, resolve: path.resolve });
  noteFileTouches(ring, [{ tool: 'Edit', path: '/proj/src/x.js' }], { cwd: '/proj', ts: 2, resolve: path.resolve });
  assert.strictEqual(ring.length, 1);
  assert.strictEqual(ring[0].path, '/proj/src/x.js');
  assert.strictEqual(ring[0].sub, true); // once via subagent, badge stays
});

test('noteFileTouches: ring capped', () => {
  const ring = [];
  for (let i = 0; i < TOUCH_RING_CAP + 10; i++) {
    noteFileTouches(ring, [{ tool: 'Write', path: `/f${i}` }], { ts: i, resolve: path.resolve });
  }
  assert.strictEqual(ring.length, TOUCH_RING_CAP);
  assert.strictEqual(ring[0].path, `/f${TOUCH_RING_CAP + 9}`); // newest kept
});

// --- [agent:file view|open] vetting -------------------------------------------
// The first intent whose effect reaches the operator's screen — every clause
// is a guard and each must independently refuse. fs is injected as a tiny
// fake: `world` maps realpath results to stat facts.
const { vetFileIntent } = require('../file-touch');

function fakeFs(world) {
  return {
    resolve: path.resolve,
    extname: path.extname,
    realpath: (p) => {
      const w = world[p];
      if (!w) throw new Error('ENOENT');
      return w.real || p;
    },
    stat: (p) => {
      const w = Object.values(world).find((e) => (e.real || null) === p) || world[p];
      if (!w) throw new Error('ENOENT');
      return { isFile: () => w.file !== false, mode: w.mode ?? 0o644 };
    },
  };
}

test('vetFileIntent: relative path resolves against cwd and opens', () => {
  const fs2 = fakeFs({ '/proj/report.md': {} });
  const r = vetFileIntent({ sub: 'open', rawPath: 'report.md', cwd: '/proj', ...fs2 });
  assert.deepStrictEqual(r, { ok: true, path: '/proj/report.md' });
});

test('vetFileIntent: unknown sub, missing path, missing file all refuse', () => {
  const fs2 = fakeFs({ '/proj/a.md': {} });
  assert.strictEqual(vetFileIntent({ sub: 'edit', rawPath: 'a.md', cwd: '/proj', ...fs2 }).ok, false);
  assert.strictEqual(vetFileIntent({ sub: 'open', rawPath: '   ', cwd: '/proj', ...fs2 }).ok, false);
  assert.strictEqual(vetFileIntent({ sub: 'open', rawPath: 'gone.md', cwd: '/proj', ...fs2 }).ok, false);
});

test('vetFileIntent: symlink is followed BEFORE the checks (no bait-and-switch)', () => {
  // innocent.md is a symlink to a script with the exec bit: the vet must judge
  // the TARGET, not the name the agent handed us.
  const fs2 = fakeFs({ '/proj/innocent.md': { real: '/proj/run.sh', mode: 0o755 } });
  const r = vetFileIntent({ sub: 'open', rawPath: 'innocent.md', cwd: '/proj', ...fs2 });
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /executable/);
});

test('vetFileIntent: directories and non-files refuse', () => {
  const fs2 = fakeFs({ '/proj/dir': { file: false } });
  assert.strictEqual(vetFileIntent({ sub: 'view', rawPath: 'dir', cwd: '/proj', ...fs2 }).ok, false);
});

test('vetFileIntent: open refuses launchable extensions and exec bits; view allows them', () => {
  const fs2 = fakeFs({
    '/proj/run.command': {},
    '/proj/tool.jar': {},
    '/proj/script.py': { mode: 0o755 },
  });
  assert.strictEqual(vetFileIntent({ sub: 'open', rawPath: 'run.command', cwd: '/proj', ...fs2 }).ok, false);
  assert.strictEqual(vetFileIntent({ sub: 'open', rawPath: 'tool.jar', cwd: '/proj', ...fs2 }).ok, false);
  assert.strictEqual(vetFileIntent({ sub: 'open', rawPath: 'script.py', cwd: '/proj', ...fs2 }).ok, false);
  // view only renders bytes in our modal — never launches, so all three pass
  for (const p of ['run.command', 'tool.jar', 'script.py']) {
    assert.strictEqual(vetFileIntent({ sub: 'view', rawPath: p, cwd: '/proj', ...fs2 }).ok, true, p);
  }
});

test('vetFileIntent: extension casing does not dodge the denylist', () => {
  const fs2 = fakeFs({ '/proj/X.COMMAND': {} });
  assert.strictEqual(vetFileIntent({ sub: 'open', rawPath: 'X.COMMAND', cwd: '/proj', ...fs2 }).ok, false);
});

test('vetFileIntent: absolute paths outside cwd are allowed (cwd only anchors relatives)', () => {
  const fs2 = fakeFs({ '/elsewhere/notes.md': {} });
  const r = vetFileIntent({ sub: 'open', rawPath: '/elsewhere/notes.md', cwd: '/proj', ...fs2 });
  assert.deepStrictEqual(r, { ok: true, path: '/elsewhere/notes.md' });
});
