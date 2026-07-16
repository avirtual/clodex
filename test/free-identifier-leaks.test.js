// Regression guard for the M3/M4 class of bug: an extracted module referencing
// a main.js module-scope identifier that was never injected through its deps
// object / factory params. Those are free identifiers — a ReferenceError at
// runtime — and they only explode when the code path runs. Three real escapes
// motivated this: the five cli-hooks fns missing from SessionManager's deps
// (broke session restore), POLL_INTERVAL/TURN_COMPLETE_TIMEOUT left behind by
// the JsonlWatcher move (broke every non-wire agent spawn), and five
// identifiers missing from createProxyPoller (killed the status bar silently —
// the tick's .catch(() => {}) ate the ReferenceError). All shipped green
// through the unit suite because their paths need a PTY / live proxy.
//
// Heuristic static scan, not a parser: collect main.js's module-scope names,
// collect the module's own definitions (functions, classes, consts, deps
// destructures, function/factory params), strip comments/strings/object keys,
// and flag any identifier the module uses that only main.js defines.
// Imperfect stripping means a small per-module whitelist; every entry must be
// justified inline.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

// Every module extracted from main.js. New extraction phases MUST add their
// modules here (M5: ipc-handlers, remote-wiring, peer-wiring, app-menus).
const SCANNED_MODULES = [
  'dev-reload.js',
  'session-manager.js',
  'app-menus.js',
  'ipc-handlers.js',
  'remote-wiring.js',
  'peer-wiring.js',
  'jsonl-watcher.js',
  'wirescope-proxy.js',
  'wirescope-supervisor.js',
  'cli-hooks.js',
  'agent-transport.js',
  'update-checker.js',
  'ipc-prompt.js',
  'stores.js',
  'catalogs.js',
  'statusline.js',
  'intent-scanner.js',
  'intent-catalog.js',
  'exec-schema.js',
  'remind-schedule.js',
  'remind-scheduler.js',
  'argv-merge.js',
  'transcript.js',
  'fs-util.js',
  'claude-env.js',
  'relay-protocol.js',
  'session-restore.js',
  'session-discovery.js',
  'git-worktree.js',
  'git-scm.js',
  'fs-explorer.js',
  'session-meta.js',
  'engine.js',
  'headless-main.js',
  'sandbox.js',
];

// The same guard for renderer.js extractions — these modules were carved out of
// renderer/renderer.js, so they leak against ITS module scope, not main.js's.
// findLeaks is parameterized by scope file; this list is scanned against
// renderer/renderer.js. Populated retroactively with every R1/R2 island (the M5
// review proved this bug class ships green — renderer had no guard at all until
// R3) plus every new R3 popover module.
const RENDERER_SCOPE = 'renderer/renderer.js';
const RENDERER_SCANNED_MODULES = [
  'renderer/lib/constants.js',
  'renderer/lib/format.js',
  'renderer/lib/render-html.js',
  'renderer/lib/checklists.js',
  'renderer/lib/args-model.js',
  'renderer/lib/session-actions.js',
  'renderer/ipc-log.js',
  'renderer/inbox-drawer.js',
  'renderer/pot-drawer.js',
  'renderer/term-search.js',
  'renderer/banners.js',
  'renderer/themes.js',
  'renderer/library-drawers.js',
  'renderer/subagent-popover.js',
  'renderer/session-hovercard.js',
  'renderer/tooltip.js',
  'renderer/popovers/report-panel.js',
  'renderer/popovers/cost-popover.js',
  'renderer/popovers/bust-popover.js',
  'renderer/popovers/files-popover.js',
  'renderer/popovers/checklist-popovers.js',
  'renderer/popovers/context-popover.js',
  'renderer/popovers/session-menus.js',
  'renderer/peers-ui.js',
];

// Justified survivors of imperfect stripping. Format: module -> Set of names.
const WHITELIST = {};

function moduleScopeNames(src) {
  const names = new Set();
  for (const m of src.matchAll(/^(?:async )?function (\w+)/gm)) names.add(m[1]);
  // Declaration lists, possibly multi-line: `let a, b,\n  c;` and `const x = …`.
  // The single-`\w+` form this replaced missed continuation lines — that is how
  // the seven stores declared as `let persistence, templates,\n …, uiSettings;`
  // stayed invisible and let ipc-handlers.js leak them all.
  for (const m of src.matchAll(/^(?:const|let) ([\w\s,]+?)(?:;|=)/gm)) {
    for (const n of m[1].split(',')) {
      const t = n.trim();
      if (/^\w+$/.test(t)) names.add(t);
    }
  }
  // Destructures, possibly multi-line — `const { a, b } =`, `let { a } =`, and
  // the whenReady reassignment `({ persistence, … } = initStores(...))`.
  for (const m of src.matchAll(/^(?:const|let)? ?\(?\{([\s\S]*?)\}\s*=/gm)) {
    for (const p of m[1].split(',')) {
      const t = p.split(':')[0].trim();
      if (/^\w+$/.test(t)) names.add(t);
    }
  }
  return names;
}

function stripComments(src) {
  return src.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
}

function ownDefinitions(rawSrc) {
  // Comments first — a paren inside a comment embedded in a multi-line
  // factory param list breaks the param matcher otherwise.
  const src = stripComments(rawSrc);
  const defs = new Set();
  for (const m of src.matchAll(/^\s*(?:async )?function (\w+)/gm)) defs.add(m[1]);
  for (const m of src.matchAll(/\bclass (\w+)/g)) defs.add(m[1]);
  for (const m of src.matchAll(/^\s*(?:const|let) (\w+)/gm)) defs.add(m[1]);
  // Destructured requires/assignments: const { a, b: c } = anything
  for (const m of src.matchAll(/(?:const|let) \{([\s\S]*?)\}\s*=/g)) {
    for (const p of m[1].split(',')) {
      const n = p.split(/[:/]/)[0].trim();
      if (/^\w+$/.test(n)) defs.add(n);
    }
  }
  // Function/method parameters, including destructured factory deps objects —
  // matches `function f(a, { b, c } = {})` across lines, method shorthand, and
  // arrows with parenthesized params. Over-collection here only weakens
  // detection for same-named locals; it cannot create false alarms — BUT a
  // control-flow head like `if (name === activeSession) {` also matches
  // `word ( … ) {`, and absorbing its condition into own-defs silently HID a
  // real missing injection (files-popover.js needed activeSession; the scan
  // stayed green). So the leading token is captured and control keywords are
  // excluded — a `\w+(` head that is if/for/while/switch/catch/return/do/…/an
  // operator keyword is a statement, not a call/definition, and its parens hold
  // an expression, never a parameter list. `function(` (anonymous) still counts.
  const CONTROL_KW = new Set([
    'if', 'for', 'while', 'switch', 'catch', 'return', 'do', 'else',
    'typeof', 'await', 'new', 'in', 'of', 'instanceof', 'void', 'delete', 'yield',
  ]);
  for (const m of src.matchAll(/(?:\bfunction\s*\w*|(\w+))\s*\(([^()]*)\)\s*(?:\{|=>)/gs)) {
    if (m[1] && CONTROL_KW.has(m[1])) continue;
    for (const p of m[2].split(',')) {
      const cleaned = p.replace(/[{}[\]]/g, ' ');
      for (const word of cleaned.split(/[\s=:,]+/)) {
        if (/^[a-zA-Z_$][\w$]*$/.test(word)) defs.add(word);
      }
    }
  }
  return defs;
}

// Single left-to-right pass replacing strings, comments, and regex literals
// with blanks — but template literals are lexed structurally, not blanked
// wholesale. A `${…}` interpolation recurses back into code mode with brace-
// depth tracking, so (a) nested backticks inside an interpolation (e.g.
// `shellEsc(`…`)`) no longer flip the lexer state and silently drop the rest of
// the file from the scan, and (b) the interpolation EXPRESSION itself is kept as
// code — a `${diagSummary(...)}` reference is a real use and must be seen.
// Regex ordering can't do this correctly — `'http://x'` defeats comments-first
// (the // inside the string is eaten, unbalancing every quote after it),
// apostrophes in comments defeat strings-first. A regex literal is assumed when
// `/` follows a token that cannot end an expression (so `a / b` division
// survives).
function stripCommentsStringsAndKeys(src) {
  let out = '';
  let i = 0;
  let lastSig = ''; // last significant (non-space) char emitted
  const isRegexPos = () => lastSig === '' || '=(,:;!&|?{}[+-*%<>~^'.includes(lastSig);
  // Consume code until the matching close of the current `${…}` (end === '}')
  // or end of source (end === null). Braces balance so object/block braces
  // inside an interpolation don't terminate it early.
  function code(end) {
    let depth = 0;
    while (i < src.length) {
      const c = src[i], n = src[i + 1];
      if (end === '}' && c === '}' && depth === 0) return;
      if (c === '{') depth++;
      else if (c === '}') depth--;
      if (c === "'" || c === '"') { str(c); continue; }
      if (c === '`') { tpl(); continue; }
      if (c === '/' && n === '/') { while (i < src.length && src[i] !== '\n') i++; continue; }
      if (c === '/' && n === '*') { i += 2; while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i++; i += 2; continue; }
      if (c === '/' && isRegexPos()) { rex(); continue; }
      out += c; if (!/\s/.test(c)) lastSig = c; i++;
    }
  }
  function str(q) { i++; while (i < src.length && src[i] !== q) i += src[i] === '\\' ? 2 : 1; i++; out += q + q; lastSig = q; }
  function tpl() {
    i++;
    while (i < src.length && src[i] !== '`') {
      if (src[i] === '\\') { i += 2; continue; }
      if (src[i] === '$' && src[i + 1] === '{') { i += 2; out += '('; lastSig = '('; code('}'); i++; out += ')'; lastSig = ')'; continue; }
      i++;
    }
    i++; out += '``'; lastSig = '`';
  }
  function rex() {
    i++;
    let inClass = false;
    while (i < src.length && (inClass || src[i] !== '/')) {
      if (src[i] === '\\') i += 2;
      else { if (src[i] === '[') inClass = true; else if (src[i] === ']') inClass = false; i++; }
    }
    i++;
    while (i < src.length && /[gimsuy]/.test(src[i])) i++;
    out += '""'; lastSig = '"';
  }
  code(null);
  return out
    // Property accesses (`intent.path`, `pty.spawn`) never resolve against
    // module scope — drop the `.name` part, keep the receiver.
    .replace(/\.\s*[a-zA-Z_$][\w$]*/g, '.')
    // Object-literal keys (`Notification: [...]` in the hooks config) are
    // identifier tokens but not variable references — drop `key:` after an
    // opening brace or comma. Ternary `?:` colons don't match (no {, before).
    .replace(/([{,]\s*)\w+\s*:/g, '$1');
}

function findLeaks(moduleFile, scopeFile = 'main.js') {
  const scopeSrc = fs.readFileSync(path.join(ROOT, scopeFile), 'utf8');
  const modSrc = fs.readFileSync(path.join(ROOT, moduleFile), 'utf8');
  const scopeNames = moduleScopeNames(scopeSrc);
  const defs = ownDefinitions(modSrc);
  const wl = WHITELIST[moduleFile] || new Set();
  const used = new Set(stripCommentsStringsAndKeys(modSrc).match(/\b[a-zA-Z_$][\w$]*\b/g) || []);
  return [...used].filter((n) => scopeNames.has(n) && !defs.has(n) && !wl.has(n)).sort();
}

for (const mod of SCANNED_MODULES) {
  test(`${mod} references no main.js-only identifiers`, () => {
    const leaks = findLeaks(mod);
    assert.deepStrictEqual(
      leaks, [],
      `free identifiers leaked from main.js scope (add to deps + destructure): ${leaks.join(', ')}`,
    );
  });
}

for (const mod of RENDERER_SCANNED_MODULES) {
  test(`${mod} references no renderer.js-only identifiers`, () => {
    const leaks = findLeaks(mod, RENDERER_SCOPE);
    assert.deepStrictEqual(
      leaks, [],
      `free identifiers leaked from renderer.js scope (add to init params + destructure): ${leaks.join(', ')}`,
    );
  });
}

// ---------------------------------------------------------------------------
// Reverse gate: dangling references. The forward scan above catches a MODULE
// using a name only the scope file defines. It is blind to the opposite escape
// — the SCOPE file (renderer.js / main.js) referencing a name that an
// extraction MOVED into a module and never left a binding for. That is exactly
// how R3 shipped two live ReferenceErrors: `openFilePeek` + the `filesPopover`
// handle moved into files-popover.js, but two callers stayed in renderer.js's
// peer region (a fileView mirror + a telemetry frame). A directional scan can't
// see it; this one does. For each scope file, collect every referenced
// identifier that is NOT defined anywhere in that file, NOT a language/host
// global, and NOT a property/string/object-key (the lexer already strips
// those) — the residue must be empty.

// Union of every binding target text into a set (splitting on the delimiters
// that separate identifiers in a param list / destructure pattern).
function addIds(text, defs) {
  for (const w of text.replace(/[{}[\]()]/g, ' ').split(/[\s,:=]+/)) {
    if (/^[a-zA-Z_$][\w$]*$/.test(w)) defs.add(w);
  }
}

// Balanced-paren parameter walk over comment/string-stripped code. ownDefinitions'
// `\(([^()]*)\)` matcher cannot cross a nested paren, so the pervasive
// callback shape `foo((a, b) => …)` hid every one of those params (attn, geom,
// resultIndex, …) and would have false-alarmed the reverse gate. This reads the
// real parameter group for both `=> ` arrows (parenthesized and bare) and every
// `function (…)`. Default-value refs are over-collected into defs — the SAFE
// direction (can only mask a would-be dangler, never manufacture one).
function collectParams(code) {
  const defs = new Set();
  for (let i = 0; i + 1 < code.length; i++) {
    if (code[i] === '=' && code[i + 1] === '>') {
      let j = i - 1;
      while (j >= 0 && /\s/.test(code[j])) j--;
      if (code[j] === ')') {
        let depth = 0, k = j;
        for (; k >= 0; k--) { if (code[k] === ')') depth++; else if (code[k] === '(') { depth--; if (depth === 0) break; } }
        addIds(code.slice(k + 1, j), defs);
      } else {
        let s = j;
        while (s >= 0 && /[\w$]/.test(code[s])) s--;
        const id = code.slice(s + 1, j + 1);
        if (/^[a-zA-Z_$][\w$]*$/.test(id)) defs.add(id);
      }
    }
  }
  for (const m of code.matchAll(/\bfunction\s*\*?\s*[a-zA-Z_$]?[\w$]*\s*\(/g)) {
    const open = m.index + m[0].length - 1;
    let depth = 0;
    for (let k = open; k < code.length; k++) {
      if (code[k] === '(') depth++;
      else if (code[k] === ')') { depth--; if (depth === 0) { addIds(code.slice(open + 1, k), defs); break; } }
    }
  }
  return defs;
}

// Brace-depth-aware declaration scanner: for each const/let/var, read the whole
// declarator list and record every binding target — single names, comma lists
// WITH initializers (`const be = x, le = y`), renamed object destructures
// (`{ id: peerId }`), and array destructures (`const [, , s, agentLib] = …`).
// ownDefinitions only grabs the first single name of each; the others slip
// through and false-alarm. Splitting only at brace/bracket/paren depth 0 keeps
// commas inside a pattern from ending a declarator early.
function collectDeclarations(code) {
  const defs = new Set();
  const re = /\b(?:const|let|var)\b/g;
  let m;
  while ((m = re.exec(code))) {
    let depth = 0, target = '', reading = true;
    for (let i = m.index + m[0].length; i < code.length; i++) {
      const c = code[i];
      if (depth === 0 && reading && c === '=' && code[i + 1] !== '=') { addIds(target, defs); reading = false; target = ''; continue; }
      if (depth === 0 && c === ',') { if (reading) addIds(target, defs); reading = true; target = ''; continue; }
      if (depth === 0 && c === ';') { if (reading) addIds(target, defs); break; }
      if ('([{'.includes(c)) depth++;
      else if (')]}'.includes(c)) { if (depth === 0) { if (reading) addIds(target, defs); break; } depth--; }
      if (reading) target += c;
    }
  }
  return defs;
}

// Every name BOUND anywhere in a scope file: top-level (moduleScopeNames) and
// nested (ownDefinitions) declarations, plus the binding forms neither of those
// fully covers — nested-paren params, full declarator lists, named function
// EXPRESSIONS (IIFEs), and catch bindings. Over-collection here only weakens the
// gate (a real dangler could hide); it never invents one — the same safe bias
// the whole heuristic rides on.
function definedNames(rawSrc) {
  const src = stripComments(rawSrc);
  const defs = new Set([...moduleScopeNames(rawSrc), ...ownDefinitions(rawSrc)]);
  for (const p of collectParams(src)) defs.add(p);
  for (const d of collectDeclarations(src)) defs.add(d);
  for (const mm of src.matchAll(/\bfunction\s*\*?\s*([a-zA-Z_$][\w$]*)\s*\(/g)) defs.add(mm[1]);
  for (const mm of src.matchAll(/\bcatch\s*\(\s*([^)]*)\)/g)) addIds(mm[1], defs);
  return defs;
}

// The language + host surface a scope file legitimately references without
// defining. NOT per-file padding — it is the fixed ECMAScript/DOM/Node universe,
// every entry a well-known reserved word or global, none ambiguous. Split by
// origin so an addition has an obvious home and reviewers can spot a smuggled
// non-global. A reference that is genuinely none of these is a real dangler.
const RESERVED = [
  // Keywords the tokenizer emits as bare identifiers — mechanical, not globals.
  'this', 'super', 'true', 'false', 'null', 'void', 'typeof', 'instanceof',
  'in', 'of', 'new', 'delete', 'return', 'if', 'else', 'for', 'while', 'do',
  'switch', 'case', 'break', 'continue', 'function', 'class', 'const', 'let',
  'var', 'try', 'catch', 'finally', 'throw', 'await', 'async', 'yield',
  'default', 'extends', 'get', 'set', 'static', 'from', 'as', 'import',
  'export', 'with', 'debugger',
];
const BUILTINS = [
  // ECMAScript built-in values/constructors.
  'Object', 'Array', 'String', 'Number', 'Boolean', 'Symbol', 'BigInt', 'Math',
  'JSON', 'Date', 'RegExp', 'Map', 'Set', 'WeakMap', 'WeakSet', 'Promise',
  'Proxy', 'Reflect', 'Error', 'TypeError', 'RangeError', 'Function', 'Infinity',
  'NaN', 'undefined', 'globalThis', 'parseInt', 'parseFloat', 'isNaN',
  'isFinite', 'encodeURIComponent', 'decodeURIComponent', 'encodeURI',
  'decodeURI', 'structuredClone', 'btoa', 'atob',
];
const HOST = [
  // Browser/DOM (renderer.js) + Node/module (main.js) ambient globals.
  'window', 'document', 'console', 'navigator', 'location', 'history',
  'localStorage', 'sessionStorage', 'requestAnimationFrame',
  'cancelAnimationFrame', 'setTimeout', 'clearTimeout', 'setInterval',
  'clearInterval', 'queueMicrotask', 'fetch', 'alert', 'confirm', 'prompt',
  'getComputedStyle', 'matchMedia', 'crypto', 'CSS', 'Node', 'Element',
  'HTMLElement', 'Event', 'CustomEvent', 'MouseEvent', 'KeyboardEvent',
  'ResizeObserver', 'MutationObserver', 'IntersectionObserver', 'FileReader',
  'Blob', 'URL', 'URLSearchParams', 'Image', 'Audio', 'FormData',
  'Notification', 'WebSocket', 'XMLHttpRequest', 'DOMParser', 'AbortController',
  'require', 'module', 'exports', 'process', 'Buffer', '__dirname', '__filename',
  'global', 'setImmediate', 'TextEncoder', 'TextDecoder',
];
const AMBIENT = new Set([...RESERVED, ...BUILTINS, ...HOST]);

function danglingRefs(scopeFile) {
  const src = fs.readFileSync(path.join(ROOT, scopeFile), 'utf8');
  const defs = definedNames(src);
  const used = new Set(stripCommentsStringsAndKeys(src).match(/\b[a-zA-Z_$][\w$]*\b/g) || []);
  return [...used].filter((n) => !defs.has(n) && !AMBIENT.has(n)).sort();
}

for (const scope of ['renderer/renderer.js', 'main.js']) {
  test(`${scope} references no names that moved out of its scope`, () => {
    const dangling = danglingRefs(scope);
    assert.deepStrictEqual(
      dangling, [],
      `dangling references in ${scope} (a name it uses is defined nowhere in-scope — an extraction moved it into a module without leaving a destructured binding): ${dangling.join(', ')}`,
    );
  });
}

// Scanner self-tests — lock in the two defects whose fix caught the M5 escape.
// Each reproduces the exact shape that let a real leak hide: without the fix the
// asserted token is absent and the module scan silently passes over the leak.
const tokensOf = (s) =>
  new Set(stripCommentsStringsAndKeys(s).match(/\b[a-zA-Z_$][\w$]*\b/g) || []);

test('stripper keeps interpolation expressions as code', () => {
  // `${diagSummary(d)}` is a real reference — blanking template interiors is how
  // diagSummary leaked from session-manager.js unseen for a whole phase.
  const toks = tokensOf('const s = `cwd=${cwd} ${diagSummary(d)}`;');
  assert.ok(toks.has('diagSummary'), 'reference inside ${…} was dropped');
  assert.ok(toks.has('cwd'), 'reference inside ${…} was dropped');
});

test('stripper survives a nested backtick inside an interpolation', () => {
  // The shellEsc shape from ipc-handlers.js — a template within a ${…} within a
  // template. Whole-literal blanking flipped the lexer on the inner backtick and
  // dropped the rest of the file (that is how the `workspaces` use hid).
  const toks = tokensOf('const a = `x${shellEsc(`y`)}z`; afterMarker;');
  assert.ok(toks.has('shellEsc'), 'token inside a nested template was dropped');
  assert.ok(toks.has('afterMarker'), 'code after a nested template was dropped');
});

test('moduleScopeNames collects a multi-line declaration list', () => {
  // `let persistence, templates,\n  …, uiSettings;` — the seven-store shape.
  const names = moduleScopeNames('let persistence, templates,\n  agentLibrary, uiSettings;');
  for (const n of ['persistence', 'templates', 'agentLibrary', 'uiSettings']) {
    assert.ok(names.has(n), `multi-line let list missed ${n}`);
  }
});

test('moduleScopeNames collects a multi-line destructure', () => {
  // The whenReady store reassignment shape `({ a, b,\n c } = initStores(x))`.
  const names = moduleScopeNames('({ persistence, templates,\n  skillLibrary, uiSettings } = initStores(x));');
  for (const n of ['persistence', 'templates', 'skillLibrary', 'uiSettings']) {
    assert.ok(names.has(n), `multi-line destructure missed ${n}`);
  }
});

test('ownDefinitions does not absorb a control-flow condition as a parameter', () => {
  // `if (name === activeSession) {` matches the `word ( … ) {` param shape, so the
  // pre-hardening matcher pulled activeSession into own-defs and silently HID the
  // missing injection (files-popover.js's R3 escape). A control keyword before
  // `(` is a statement, not a definition — its condition holds no parameters.
  const defs = ownDefinitions('function f(a) {\n  if (a === leakedName) {\n    return;\n  }\n}');
  assert.ok(defs.has('a'), 'real parameter a was dropped');
  assert.ok(!defs.has('leakedName'), 'if-condition token was absorbed as a param');
  // The other control heads share the shape — none may absorb their condition.
  for (const kw of ['for', 'while', 'switch', 'catch', 'return']) {
    const d = ownDefinitions(`${kw} (x === sneaky) {}`);
    assert.ok(!d.has('sneaky'), `${kw}-condition token was absorbed as a param`);
  }
});

// Reverse-gate self-tests — lock the binding forms whose omission would
// false-alarm the dangling-ref scan, and prove a real dangler still surfaces.
// Each false-positive class here is one that a naive collector misses, letting
// a legitimate local read as an undefined reference.
test('definedNames captures the binding forms a naive collector misses', () => {
  // A nested-paren callback param — the shape that hid attn/geom/resultIndex.
  assert.ok(definedNames('api.on((id, geom) => { use(geom); });').has('geom'),
    'nested-paren callback param not collected');
  // A renamed object destructure — binding is the value side, not the key.
  assert.ok(definedNames('const { id: peerId } = entry.peer;').has('peerId'),
    'renamed destructure binding not collected');
  // An array destructure with holes.
  assert.ok(definedNames('const [, , settings, agentLib] = await all;').has('agentLib'),
    'array destructure binding not collected');
  // A comma declarator list WITH initializers — only the first name is caught
  // by the line-anchored collectors.
  const multi = definedNames('let first = null, last = null, turns = 0;');
  assert.ok(multi.has('last') && multi.has('turns'), 'later declarators in a list not collected');
  // A named function EXPRESSION inside an IIFE.
  assert.ok(definedNames('(async function initWorkspace() { loop(); })();').has('initWorkspace'),
    'named function expression not collected');
});

test('danglingRefs flags a reference whose binding was moved into a module', () => {
  // The R3 escape reproduced in miniature: a caller left behind after its
  // definition moved out, with no destructured binding to replace it. The two
  // production scope files must currently be clean (guarded by the loop above);
  // this locks that the scan actually FIRES on the escape, not just passes when
  // the file happens to be clean.
  const src = [
    "const { openFilesPopover } = initFilesPopover({ deps });",
    "window.api.onThing((key) => { openFilePeek(key); });",
  ].join('\n');
  const defs = definedNames(src);
  const used = new Set(stripCommentsStringsAndKeys(src).match(/\b[a-zA-Z_$][\w$]*\b/g) || []);
  const dangling = [...used].filter((n) => !defs.has(n) && !AMBIENT.has(n)).sort();
  assert.ok(dangling.includes('openFilePeek'),
    'the moved-out reference was not flagged as dangling');
  assert.ok(!dangling.includes('openFilesPopover'),
    'a properly destructured binding was wrongly flagged');
});
