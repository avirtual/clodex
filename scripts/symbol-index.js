'use strict';

const fs = require('fs');
const path = require('path');
const acorn = require('acorn');

const MAX_DEPTH = 2;

const FN_TYPES = new Set(['FunctionExpression', 'ArrowFunctionExpression']);

function isRegion(node) {
  if (node.type === 'BlockStatement') return false;
  if (node.type === 'VariableDeclaration' || node.type === 'ClassExpression') return true;
  if (FN_TYPES.has(node.type) && !node.id) return true;
  return /Statement$/.test(node.type);
}

function parse(src) {
  const base = { ecmaVersion: 'latest', locations: true, allowHashBang: true, allowReturnOutsideFunction: true };
  let firstErr;
  for (const sourceType of ['script', 'module']) {
    const comments = [];
    try {
      const ast = acorn.parse(src, { ...base, sourceType, onComment: comments });
      return { ast, comments, sourceType };
    } catch (e) {
      if (!firstErr) firstErr = e;
      if (sourceType === 'module') {
        return { error: `script: ${firstErr.message}; module: ${e.message}` };
      }
    }
  }
  return null;
}

function keyName(key, computed, src) {
  if (!key) return null;
  if (!computed) {
    if (key.type === 'Identifier') return key.name;
    if (key.type === 'PrivateIdentifier') return `#${key.name}`;
    if (key.type === 'Literal') return String(key.value);
  }
  return `[${src.slice(key.start, key.end)}]`;
}

function memberPath(node) {
  if (!node) return null;
  if (node.type === 'Identifier') return node.name;
  if (node.type === 'ThisExpression') return 'this';
  if (node.type === 'MemberExpression' && !node.computed) {
    const obj = memberPath(node.object);
    return obj ? `${obj}.${node.property.name}` : null;
  }
  return null;
}

function stringArg(node) {
  if (!node) return null;
  if (node.type === 'Literal' && typeof node.value === 'string') return node.value;
  if (node.type === 'TemplateLiteral' && node.expressions.length === 0) return node.quasis[0].value.cooked;
  return null;
}

const HANDLER_CALLEES = new Map([
  ['handle', 'handle'], ['on', 'on'],
  ['ipcMain.handle', 'handle'], ['ipcMain.on', 'on'],
  ['registerIntent', 'intent'],
]);

function extractFile(src) {
  const parsed = parse(src);
  if (parsed.error) return { error: parsed.error };
  const { ast, comments } = parsed;
  const symbols = [];
  const regions = [];
  const requires = [];
  const exportKeys = new Set();
  const exportLocals = new Set();
  const exportObjects = new Set();

  function rec(name, kind, node, ctx, extra = {}) {
    if (ctx.depth > MAX_DEPTH) return -1;
    const start = node.loc.start.line;
    const end = node.loc.end.line;
    symbols.push({
      name, kind, depth: ctx.depth, parent: ctx.parent || null,
      start, end, lines: end - start + 1, bytes: node.end - node.start,
      exported: false, _owner: ctx.owner, ...extra,
    });
    return symbols.length - 1;
  }

  function visitFunction(fn, ctx) {
    for (const p of fn.params) visit(p, ctx);
    visit(fn.body, ctx);
  }

  function inner(ctx, name, owner) {
    return { depth: ctx.depth + 1, parent: name == null ? ctx.parent : name, owner: owner == null ? ctx.owner : owner };
  }

  function handleClass(cls, ctx, name, spanNode) {
    const idx = name ? rec(name, 'class', spanNode || cls, ctx) : -1;
    if (cls.superClass) visit(cls.superClass, ctx);
    const clsName = name || ctx.parent;
    const owner = idx >= 0 ? idx : ctx.owner;
    const memberCtx = { depth: ctx.depth + 1, parent: clsName, owner };
    for (const m of cls.body.body) {
      if (m.type === 'MethodDefinition' || (m.type === 'PropertyDefinition' && m.value && FN_TYPES.has(m.value.type))) {
        const mName = keyName(m.key, m.computed, src);
        const kind = m.kind === 'get' ? 'getter' : m.kind === 'set' ? 'setter' : 'method';
        const mi = rec(mName, kind, m, memberCtx, m.static ? { static: true } : {});
        if (m.computed) visit(m.key, memberCtx);
        visitFunction(m.value, inner(memberCtx, mName, mi >= 0 ? mi : null));
      } else if (m.type === 'StaticBlock') {
        for (const s of m.body) visit(s, inner(memberCtx, null, null));
      } else {
        if (m.computed) visit(m.key, memberCtx);
        if (m.value) visit(m.value, inner(memberCtx, null, null));
      }
    }
  }

  function handleObject(obj, ctx, ownerName, markExported) {
    const parentName = ctx.depth > 0 && ctx.parent ? ctx.parent : ownerName;
    const pctx = { depth: ctx.depth, parent: parentName, owner: ctx.owner };
    for (const p of obj.properties) {
      if (p.type === 'Property' && p.value && FN_TYPES.has(p.value.type)) {
        const pName = keyName(p.key, p.computed, src);
        const kind = p.kind === 'get' ? 'getter' : p.kind === 'set' ? 'setter' : 'object-method';
        const pi = rec(pName, kind, p, pctx);
        if (pi >= 0 && markExported) symbols[pi].exported = true;
        if (p.computed) visit(p.key, ctx);
        visitFunction(p.value, inner(ctx, pName, pi >= 0 ? pi : null));
      } else if (p.type === 'Property') {
        if (p.computed) visit(p.key, ctx);
        visit(p.value, ctx);
      } else {
        visit(p, ctx);
      }
    }
  }

  function noteExports(left, right) {
    const lp = memberPath(left);
    if (lp === 'module.exports') {
      if (right.type === 'ObjectExpression') {
        for (const p of right.properties) {
          if (p.type !== 'Property') continue;
          const k = keyName(p.key, p.computed, src);
          exportKeys.add(k);
          if (p.value && p.value.type === 'Identifier') exportLocals.add(p.value.name);
        }
        exportObjects.add(right);
      } else if (right.type === 'Identifier') {
        exportKeys.add(right.name); exportLocals.add(right.name);
      } else if ((FN_TYPES.has(right.type) || right.type === 'ClassExpression') && right.id) {
        exportKeys.add(right.id.name); exportLocals.add(right.id.name);
      } else {
        exportKeys.add('module.exports');
      }
      return;
    }
    const m = lp && /^(?:module\.exports|exports)\.([A-Za-z_$][\w$]*)$/.exec(lp);
    if (m) {
      exportKeys.add(m[1]);
      exportLocals.add(m[1]);
      if (right.type === 'Identifier') exportLocals.add(right.name);
    }
  }

  function visit(node, ctx) {
    if (!node || typeof node.type !== 'string') return;
    if (ctx.depth > MAX_DEPTH && node.type !== 'CallExpression') {
      return visitGeneric(node, ctx);
    }
    if (ctx.depth <= MAX_DEPTH && isRegion(node)) regions.push([node.loc.start.line, node.loc.end.line]);
    switch (node.type) {
      case 'FunctionDeclaration': {
        const name = node.id ? node.id.name : null;
        const i = name ? rec(name, 'function', node, ctx, node.async ? { async: true } : {}) : -1;
        return visitFunction(node, inner(ctx, name, i >= 0 ? i : null));
      }
      case 'FunctionExpression':
      case 'ArrowFunctionExpression': {
        if (node.id) {
          const i = rec(node.id.name, 'function-expression', node, ctx);
          return visitFunction(node, inner(ctx, node.id.name, i >= 0 ? i : null));
        }
        return visitFunction(node, inner(ctx, null, null));
      }
      case 'ClassDeclaration':
      case 'ClassExpression':
        return handleClass(node, ctx, node.id ? node.id.name : null);
      case 'VariableDeclaration': {
        for (const d of node.declarations) {
          const name = d.id.type === 'Identifier' ? d.id.name : null;
          const init = d.init;
          if (name && init && FN_TYPES.has(init.type)) {
            const i = rec(name, 'var-function', node, ctx, { declKind: node.kind });
            visitFunction(init, inner(ctx, name, i >= 0 ? i : null));
          } else if (name && init && init.type === 'ClassExpression') {
            handleClass(init, ctx, name, node);
          } else if (name && init && init.type === 'ObjectExpression') {
            handleObject(init, ctx, name, false);
          } else {
            visit(d.id, ctx);
            visit(init, ctx);
          }
        }
        return;
      }
      case 'ReturnStatement':
        if (node.argument && node.argument.type === 'ObjectExpression') {
          return handleObject(node.argument, ctx, ctx.parent, false);
        }
        return visit(node.argument, ctx);
      case 'AssignmentExpression': {
        noteExports(node.left, node.right);
        const lp = memberPath(node.left);
        const right = node.right;
        if (right.type === 'ObjectExpression') {
          visit(node.left, ctx);
          return handleObject(right, ctx, lp || null, lp === 'module.exports');
        }
        if (lp && lp.includes('.') && FN_TYPES.has(right.type)) {
          const short = lp.replace(/^(?:module\.exports|exports)\./, '');
          const exportedAssign = short !== lp;
          if (exportedAssign || lp.startsWith('window.') || lp.startsWith('this.')) {
            const i = rec(exportedAssign ? short : lp, 'assigned-function', node, ctx);
            if (i >= 0 && exportedAssign) symbols[i].exported = true;
            return visitFunction(right, inner(ctx, exportedAssign ? short : lp, i >= 0 ? i : null));
          }
        }
        visit(node.left, ctx);
        return visit(right, ctx);
      }
      case 'CallExpression': {
        const callee = memberPath(node.callee);
        if (callee === 'require' && node.arguments.length >= 1) {
          const s = stringArg(node.arguments[0]);
          if (s != null) requires.push(s);
        }
        if (callee === 'Object.assign' && memberPath(node.arguments[0]) === 'module.exports' && node.arguments[1] && node.arguments[1].type === 'ObjectExpression') {
          for (const p of node.arguments[1].properties) {
            if (p.type === 'Property') exportKeys.add(keyName(p.key, p.computed, src));
          }
        }
        const hk = callee && HANDLER_CALLEES.get(callee);
        const channel = hk && stringArg(node.arguments[0]);
        if (hk && channel != null && ctx.depth <= MAX_DEPTH) {
          const name = `${hk}:${channel}`;
          const i = rec(name, 'handler', node, ctx, { channel });
          visit(node.callee, ctx);
          const hctx = { depth: ctx.depth, parent: name, owner: i };
          for (const a of node.arguments) visit(a, hctx);
          return;
        }
        return visitGeneric(node, ctx);
      }
      default:
        return visitGeneric(node, ctx);
    }
  }

  function visitGeneric(node, ctx) {
    if (ctx.depth > MAX_DEPTH) {
      if (node.type === 'CallExpression' && memberPath(node.callee) === 'require' && node.arguments.length) {
        const s = stringArg(node.arguments[0]);
        if (s != null) requires.push(s);
      }
      if (node.type === 'AssignmentExpression') noteExports(node.left, node.right);
    }
    for (const key of Object.keys(node)) {
      if (key === 'loc' || key === 'type' || key === 'start' || key === 'end') continue;
      const v = node[key];
      if (Array.isArray(v)) {
        for (const c of v) if (c && typeof c.type === 'string') childVisit(c, ctx);
      } else if (v && typeof v.type === 'string') {
        childVisit(v, ctx);
      }
    }
  }

  function childVisit(c, ctx) {
    if (ctx.depth > MAX_DEPTH) {
      if (FN_TYPES.has(c.type) || c.type === 'FunctionDeclaration' || c.type === 'ClassDeclaration' || c.type === 'ClassExpression') {
        return visitGeneric(c, { ...ctx, depth: ctx.depth + 1 });
      }
      return visitGeneric(c, ctx);
    }
    return visit(c, ctx);
  }

  const rootCtx = { depth: 0, parent: null, owner: null };
  for (const stmt of ast.body) visit(stmt, rootCtx);

  const blanked = src.split('');
  for (const c of comments) {
    if (c.start === 0 && src.startsWith('#!')) continue;
    for (let k = c.start; k < c.end; k++) if (blanked[k] !== '\n') blanked[k] = ' ';
  }
  const origLines = src.split('\n');
  const blankLines = blanked.join('').split('\n');
  let commentLines = 0;
  for (let i = 0; i < origLines.length; i++) {
    if (origLines[i].trim() !== '' && blankLines[i].trim() === '') commentLines++;
  }

  for (const s of symbols) {
    if (s.depth === 0 && (exportLocals.has(s.name) || exportKeys.has(s.name))) s.exported = true;
  }

  const spanKey = new Set(symbols.map((x) => `${x.start}:${x.end}`));
  const seen = new Set();
  const keptRegions = [];
  for (const [a, b] of regions) {
    const k = `${a}:${b}`;
    if (a === b || seen.has(k) || spanKey.has(k)) continue;
    seen.add(k);
    if (symbols.some((x) => x.start >= a && x.end <= b)) keptRegions.push([a, b]);
  }
  keptRegions.sort((x, y) => x[0] - y[0] || y[1] - x[1]);

  const order = symbols.map((s, i) => i);
  order.sort((a, b) => symbols[a].start - symbols[b].start || symbols[b].end - symbols[a].end || a - b);
  const remap = new Map(order.map((oldI, newI) => [oldI, newI]));
  const sorted = order.map((oldI) => {
    const { _owner, ...s } = symbols[oldI];
    return { ...s, owner: _owner == null ? null : remap.get(_owner) };
  });

  return {
    symbols: sorted, regions: keptRegions, requires, exports: [...exportKeys].filter(Boolean).sort(), commentLines,
    sourceType: parsed.sourceType,
  };
}

function indexFile(absPath) {
  return extractFile(fs.readFileSync(absPath, 'utf8'));
}

const TABLE_HEADER = ['symbol', 'purpose', 'state', 'calls', 'pins'];
const REGION_RE = /^## (.+?) — `?([^`\s]+)`? (?:…|\.\.\.) `?([^`\s]+)`?\s*$/;
const EXEMPT_RE = /^- `?([^`\s]+)`? — (\S.*)$/;
const BULLET_SECTIONS = { Invariants: 'invariants', Hazards: 'hazards' };

function splitCells(line) {
  const t = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  return t.split('|').map((c) => c.trim());
}

function stripTicks(s) {
  return s.replace(/^`+|`+$/g, '').trim();
}

function parseMap(text) {
  const lines = text.split('\n');
  const out = { module: null, regions: [], exempt: [], errors: [] };
  const err = (i, detail) => out.errors.push(`line ${i + 1}: ${detail}`);
  const h1 = /^# (\S.*)$/.exec(lines[0] || '');
  if (h1) out.module = h1[1].trim().replace(/^`|`$/g, '');
  else err(0, 'line 1 must be "# <module path>"');
  let region = null;
  let inExempt = false;
  let bullets = null;
  let table = null;
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (/^## /.test(line)) {
      bullets = null;
      table = null;
      region = null;
      if (line.trim() === '## EXEMPT') { inExempt = true; continue; }
      if (inExempt) { err(i, 'no region may follow ## EXEMPT'); continue; }
      const m = REGION_RE.exec(line);
      if (!m) { err(i, `region heading must be "## <name> — <firstSymbol> … <lastSymbol>": ${line}`); continue; }
      region = { name: m[1].trim(), first: m[2], last: m[3], rows: [], invariants: [], hazards: [], tables: 0 };
      out.regions.push(region);
      continue;
    }
    if (/^### /.test(line)) {
      table = null;
      const key = BULLET_SECTIONS[line.slice(4).trim()];
      if (!key || !region) { err(i, `unexpected heading: ${line}`); bullets = null; continue; }
      bullets = region[key];
      continue;
    }
    if (inExempt) {
      if (line.trim() === '') continue;
      const m = EXEMPT_RE.exec(line);
      if (m) out.exempt.push({ symbol: m[1], reason: m[2].trim() });
      else err(i, `EXEMPT entry must be "- <symbol> — <reason>": ${line}`);
      continue;
    }
    if (/^\s*\|/.test(line)) {
      if (!region) { err(i, 'table outside a region'); continue; }
      const cells = splitCells(line);
      if (!table) {
        if (region.tables++) err(i, `region "${region.name}" carries a second table; each region carries one`);
        if (cells.length !== TABLE_HEADER.length || cells.some((c, k) => c !== TABLE_HEADER[k])) {
          err(i, `table header must be "| ${TABLE_HEADER.join(' | ')} |": ${line}`);
          table = { bad: true };
        } else {
          table = { header: true, sep: false };
        }
        continue;
      }
      if (table.bad) continue;
      if (!table.sep) {
        table.sep = true;
        if (cells.every((c) => /^:?-+:?$/.test(c))) continue;
        err(i, 'table header must be followed by a |---| separator');
      }
      if (cells.length !== TABLE_HEADER.length) { err(i, `row needs ${TABLE_HEADER.length} cells: ${line}`); continue; }
      const [symbol, purpose, state, calls, pinCell] = cells;
      const pinText = stripTicks(pinCell);
      if (!stripTicks(symbol)) { err(i, 'row has an empty symbol cell'); continue; }
      if (!pinText) { err(i, `pins cell is empty for ${stripTicks(symbol)} (write "unpinned")`); continue; }
      const pins = pinText === 'unpinned' ? [] : pinText.split(/[\s,]+/).map(stripTicks).filter(Boolean);
      region.rows.push({ symbol: stripTicks(symbol), purpose, state, calls, pins });
      continue;
    }
    table = null;
    if (bullets && /^- /.test(line)) bullets.push(line.slice(2).trim());
  }
  return out;
}

function findSymbols(symbols, ref) {
  const exact = symbols.filter((s) => s.name === ref);
  if (exact.length) return exact;
  const dot = ref.lastIndexOf('.');
  if (dot <= 0) return [];
  const parent = ref.slice(0, dot);
  const name = ref.slice(dot + 1);
  return symbols.filter((s) => s.name === name && s.parent === parent);
}

function mentions(text, word) {
  if (!/^[\w$]+$/.test(word)) return text.includes(word);
  const esc = word.replace(/\$/g, '\\$');
  return new RegExp(`(?<![\\w$])${esc}(?![\\w$])`).test(text);
}

function checkMap({ map, extracted, testDir, minLines = 40, root = null }) {
  const failures = [];
  for (const e of map.errors) failures.push({ kind: 'format', detail: e });
  if (root && map.module && !fs.existsSync(path.join(root, map.module))) {
    failures.push({ kind: 'format', detail: `module ${map.module} does not exist` });
  }
  if (!extracted || extracted.error) {
    failures.push({ kind: 'format', detail: `module could not be extracted: ${extracted ? extracted.error : 'none given'}` });
    return { failures };
  }
  const symbols = extracted.symbols;
  const forward = (ref, where) => {
    const hit = findSymbols(symbols, ref);
    if (!hit.length) failures.push({ kind: 'forward', symbol: ref, detail: `${where} names ${ref}, which the extractor does not record` });
    return hit;
  };
  const listed = [];
  let prev = null;
  for (const region of map.regions) {
    const first = forward(region.first, `region "${region.name}" first anchor`);
    const last = forward(region.last, `region "${region.name}" last anchor`);
    if (first.length && last.length) {
      const start = Math.min(...first.map((s) => s.start));
      const end = Math.max(...last.map((s) => s.end));
      if (end < start) failures.push({ kind: 'order', symbol: region.last, detail: `region "${region.name}" ends at ${region.last} before its first anchor ${region.first}` });
      if (prev && start < prev.start) {
        failures.push({ kind: 'order', symbol: region.first, detail: `region "${region.name}" starts before the region listed above it, "${prev.name}"` });
      }
      prev = { name: region.name, start };
    }
    for (const row of region.rows) {
      const hit = forward(row.symbol, `region "${region.name}" row`);
      listed.push(row.symbol);
      if (!hit.length) continue;
      for (const pin of row.pins) {
        const rel = pin.replace(/^test\//, '');
        const file = path.join(testDir, rel);
        const stat = fs.statSync(file, { throwIfNoEntry: false });
        if (!stat) {
          failures.push({ kind: 'pin', symbol: row.symbol, detail: `pin ${pin} for ${row.symbol} does not exist under test/` });
          continue;
        }
        if (!stat.isFile()) {
          failures.push({ kind: 'pin', symbol: row.symbol, detail: `pin ${pin} for ${row.symbol} is not a file` });
          continue;
        }
        const text = fs.readFileSync(file, 'utf8');
        const words = hit.map((s) => (s.kind === 'handler' ? s.channel : s.name));
        if (!words.some((w) => mentions(text, w))) {
          failures.push({ kind: 'pin', symbol: row.symbol, detail: `pin ${pin} for ${row.symbol} never mentions ${words[0]}` });
        }
      }
    }
    for (const key of ['invariants', 'hazards']) {
      for (const bullet of region[key]) {
        const names = [...bullet.matchAll(/`([^`]+)`/g)].map((m) => m[1].replace(/\(\)$/, ''));
        if (!names.some((n) => findSymbols(symbols, n).length)) {
          failures.push({ kind: 'forward', symbol: names[0], detail: `region "${region.name}" ${key} bullet names no recorded symbol: ${bullet}` });
        }
      }
    }
  }
  for (const ex of map.exempt) {
    forward(ex.symbol, 'EXEMPT');
    listed.push(ex.symbol);
  }
  const covered = new Set();
  for (const ref of listed) for (const s of findSymbols(symbols, ref)) covered.add(s);
  for (const s of symbols) {
    if (s.lines < minLines || covered.has(s)) continue;
    const label = s.parent ? `${s.parent}.${s.name}` : s.name;
    failures.push({ kind: 'reverse', symbol: s.name, detail: `${label} (${s.kind}, ${s.lines} lines) is in no region table and not in EXEMPT` });
  }
  return { failures };
}

function formatTable(symbols) {
  return symbols.map((s) => [s.name, s.kind, s.depth, s.parent || '-', `${s.start}-${s.end}`, s.lines].join(' · ')).join('\n');
}

if (require.main === module) {
  const target = process.argv[2];
  if (!target) {
    process.stderr.write('usage: node scripts/symbol-index.js <file.js>\n');
    process.exit(2);
  }
  const res = indexFile(path.resolve(target));
  if (res.error) {
    process.stderr.write(`${target}: ${res.error}\n`);
    process.exit(1);
  }
  process.stdout.write(`${formatTable(res.symbols)}\n`);
}

module.exports = { extractFile, indexFile, parseMap, checkMap, formatTable, MAX_DEPTH };
