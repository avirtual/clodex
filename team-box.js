'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { atomicWriteFileSync } = require('./fs-util');
const { normalizeBootstrap, bootstrapScripts, bootstrapSha, BOOTSTRAP_SECRET_RE, BOOTSTRAP_SCRIPT_MAX, GHCR_REPO } = require('./sandbox');

const BOX_DEFINITION_MAX = BOOTSTRAP_SCRIPT_MAX;
const BOX_DEFINITION_MAX_LINES = 400;
const BOX_HISTORY_KEEP = 20;
const BOX_SUBDIR = 'box';
const BOX_FILE = 'Dockerfile';
const BOX_META = 'box.json';
const BASE_ARG_RE = /^ARG\s+CLODEX_BASE(?:=\S*)?$/i;
const HEREDOC_RE = /<<(-?)(["']?)([A-Za-z_][A-Za-z0-9_]*)\2/g;

function normalizeDefinition(text) {
  const lf = String(text == null ? '' : text).replace(/\r\n/g, '\n');
  return `${lf.replace(/\n+$/, '')}\n`;
}

function boxFingerprint(text) {
  return crypto.createHash('sha256').update(normalizeDefinition(text), 'utf8').digest('hex');
}

function logicalLines(text) {
  const raw = text.split('\n');
  const out = [];
  let i = 0;
  while (i < raw.length) {
    if (/^\s*(#|$)/.test(raw[i])) { i += 1; continue; }
    const start = i + 1;
    let line = raw[i].replace(/\s+$/, '');
    i += 1;
    while (line.endsWith('\\') && i < raw.length) {
      line = line.slice(0, -1);
      const next = raw[i];
      i += 1;
      if (/^\s*#/.test(next)) { line += '\\'; continue; }
      line += ` ${next.replace(/\s+$/, '')}`;
    }
    line = line.trim();
    const body = [];
    const docs = [...line.matchAll(HEREDOC_RE)].map((m) => ({ strip: m[1] === '-', word: m[3] }));
    for (const doc of docs) {
      while (i < raw.length) {
        const bodyLine = raw[i];
        i += 1;
        if ((doc.strip ? bodyLine.replace(/^\t+/, '') : bodyLine) === doc.word) break;
        body.push({ text: bodyLine, line: i });
      }
    }
    out.push({ line: start, text: line, body });
  }
  return out;
}

function looksSecret(text) {
  return BOOTSTRAP_SECRET_RE.test(text.replace(/^\s*(ENV|ARG)\s+/i, '')) || text.includes('-----BEGIN ');
}

function validateBoxDefinition(input) {
  if (typeof input !== 'string') return { ok: false, error: 'the definition must be text' };
  if (!input.trim()) return { ok: false, error: 'the definition is empty' };
  const bytes = Buffer.byteLength(input, 'utf8');
  if (bytes > BOX_DEFINITION_MAX) return { ok: false, error: `the definition is ${bytes} bytes; the cap is ${BOX_DEFINITION_MAX}` };
  if (input.includes('\0')) return { ok: false, error: 'the definition contains a NUL byte' };
  if (Buffer.from(input, 'utf8').toString('utf8') !== input) return { ok: false, error: 'the definition is not valid UTF-8' };
  const text = normalizeDefinition(input);
  const rawLines = text.slice(0, -1).split('\n');
  if (rawLines.length > BOX_DEFINITION_MAX_LINES) return { ok: false, error: `the definition has ${rawLines.length} lines; the cap is ${BOX_DEFINITION_MAX_LINES}` };
  for (let i = 0; i < rawLines.length; i++) {
    if (/^\s*#\s*(syntax|escape)\s*=/i.test(rawLines[i])) return { ok: false, error: `line ${i + 1}: parser directives (# syntax=, # escape=) are refused` };
  }
  const lines = logicalLines(text);
  if (!lines.some((l) => /^FROM\s/i.test(l.text))) return { ok: false, error: 'the definition has no FROM' };
  for (const l of lines) {
    const word = (l.text.match(/^(\S+)/) || ['', ''])[1].toUpperCase();
    if ((word === 'COPY' || word === 'ADD') && !/(^|\s)--from=\S/i.test(l.text)) {
      return { ok: false, error: `line ${l.line}: ${word} without --from= is refused; the definition has no build context` };
    }
    if (/--mount=\S*type=(secret|ssh)\b/i.test(l.text)) return { ok: false, error: `line ${l.line}: secret and ssh mounts are refused` };
    if (looksSecret(l.text)) return { ok: false, error: `line ${l.line} looks like a secret: keep secrets out of the definition` };
    for (const b of l.body) {
      if (looksSecret(b.text)) return { ok: false, error: `line ${b.line} looks like a secret: keep secrets out of the definition` };
    }
  }
  return { ok: true, text, definitionHash: boxFingerprint(text) };
}

function definitionFromBootstrap(raw) {
  const b = normalizeBootstrap(raw);
  if (!b.packages.length && !b.setup) return null;
  const out = ['ARG CLODEX_BASE', 'FROM ${CLODEX_BASE}', 'USER root'];
  if (b.packages.length) {
    out.push('RUN apt-get update -qq \\');
    out.push(` && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends ${b.packages.join(' ')} \\`);
    out.push(' && rm -rf /var/lib/apt/lists/*');
  }
  if (b.setup) {
    const setupLines = b.setup.replace(/\r\n/g, '\n').replace(/\n+$/, '').split('\n');
    let word = 'CLODEX_SETUP';
    for (let n = 2; setupLines.includes(word); n += 1) word = `CLODEX_SETUP_${n}`;
    out.push(`RUN <<'${word}'`, 'set -e', ...setupLines, word);
  }
  out.push('USER clodex');
  return `${out.join('\n')}\n`;
}

function bootstrapAncestor(raw) {
  return bootstrapSha(bootstrapScripts(raw)['setup.sh']);
}

function boxPaths(teamDir) {
  const dir = path.join(teamDir, BOX_SUBDIR);
  return { dir, file: path.join(dir, BOX_FILE), meta: path.join(dir, BOX_META) };
}

function readText(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch (e) {
    if (e && e.code === 'ENOENT') return null;
    throw e;
  }
}

function readBox(teamDir) {
  const p = boxPaths(teamDir);
  const definition = readText(p.file);
  const metaText = readText(p.meta);
  let meta = null;
  if (metaText != null) {
    try { meta = JSON.parse(metaText); } catch { meta = null; }
  }
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) meta = null;
  return { file: p.file, metaFile: p.meta, definition, meta };
}

function priorEntry(meta, text) {
  return { rev: meta && Number.isInteger(meta.rev) ? meta.rev : 0, definitionHash: boxFingerprint(text), at: (meta && meta.at) || null, text };
}

function cappedHistory(meta, extra) {
  const prior = meta && Array.isArray(meta.history) ? meta.history : [];
  return [...prior, ...extra].slice(-BOX_HISTORY_KEEP);
}

function writeBox(teamDir, input, { seat = null, writer = 'intent', fromBootstrap, now = () => new Date().toISOString() } = {}) {
  const checked = validateBoxDefinition(input);
  if (!checked.ok) return checked;
  const cur = readBox(teamDir);
  const meta = cur.meta;
  if (cur.definition != null && normalizeDefinition(cur.definition) === checked.text) {
    return { ok: true, changed: false, file: cur.file, rev: meta && Number.isInteger(meta.rev) ? meta.rev : 1, definitionHash: checked.definitionHash, meta };
  }
  const baseRev = meta && Number.isInteger(meta.rev) ? meta.rev : 0;
  const generated = fromBootstrap !== undefined;
  const next = {
    v: 1,
    rev: baseRev + 1,
    definitionHash: checked.definitionHash,
    at: now(),
    writer,
    seat,
    fromBootstrap: generated ? fromBootstrap : (meta && meta.fromBootstrap) || null,
    generatedHash: generated ? checked.definitionHash : (meta && meta.generatedHash) || null,
    history: cappedHistory(meta, cur.definition != null ? [priorEntry(meta, cur.definition)] : []),
  };
  atomicWriteFileSync(cur.file, checked.text);
  atomicWriteFileSync(cur.metaFile, `${JSON.stringify(next, null, 2)}\n`);
  return { ok: true, changed: true, file: cur.file, rev: next.rev, definitionHash: next.definitionHash, meta: next };
}

function clearBox(teamDir, { seat = null, now = () => new Date().toISOString() } = {}) {
  const cur = readBox(teamDir);
  if (cur.definition == null) return { ok: true, removed: false, file: cur.file, rev: cur.meta && Number.isInteger(cur.meta.rev) ? cur.meta.rev : 0 };
  const meta = cur.meta;
  const next = {
    v: 1,
    rev: meta && Number.isInteger(meta.rev) ? meta.rev : 0,
    definitionHash: null,
    at: now(),
    writer: 'intent',
    seat,
    fromBootstrap: null,
    generatedHash: null,
    history: cappedHistory(meta, [priorEntry(meta, cur.definition)]),
  };
  atomicWriteFileSync(cur.metaFile, `${JSON.stringify(next, null, 2)}\n`);
  fs.unlinkSync(cur.file);
  return { ok: true, removed: true, file: cur.file, rev: next.rev };
}

function ancestryLine(meta, definition) {
  if (!meta || !meta.fromBootstrap) return 'not generated from bootstrap';
  const edited = meta.generatedHash !== boxFingerprint(definition);
  return `generated from bootstrap ${meta.fromBootstrap}; edited since: ${edited ? 'yes' : 'no'}`;
}

function buildLine(file, definition, version) {
  const declaresBase = logicalLines(normalizeDefinition(definition)).some((l) => BASE_ARG_RE.test(l.text));
  return `docker build ${declaresBase ? `--build-arg CLODEX_BASE=${GHCR_REPO}:${version} ` : ''}- < ${file}`;
}

function showBox(teamDir, { version = require('./package.json').version } = {}) {
  const cur = readBox(teamDir);
  const kept = cur.meta && Array.isArray(cur.meta.history) ? cur.meta.history.length : 0;
  if (cur.definition == null) {
    const rev = cur.meta && Number.isInteger(cur.meta.rev) ? cur.meta.rev : 0;
    return `no box definition${rev ? ` (cleared at rev ${rev}; ${kept} prior kept in ${cur.metaFile})` : ''} — [agent:team box set] <Dockerfile> or [agent:team box init] makes one`;
  }
  const rev = cur.meta && Number.isInteger(cur.meta.rev) ? cur.meta.rev : 1;
  return [
    `box definition rev ${rev} · definition hash ${boxFingerprint(cur.definition)}`,
    ancestryLine(cur.meta, cur.definition),
    `checked for form; not built — build it by hand: ${buildLine(cur.file, cur.definition, version)}`,
    `${kept} prior definition${kept === 1 ? '' : 's'} kept in ${cur.metaFile}`,
    `--- ${cur.file}`,
    cur.definition.replace(/\n$/, ''),
  ].join('\n');
}

module.exports = {
  validateBoxDefinition, boxFingerprint, normalizeDefinition, definitionFromBootstrap, bootstrapAncestor,
  readBox, writeBox, clearBox, showBox, ancestryLine,
  BOX_DEFINITION_MAX, BOX_DEFINITION_MAX_LINES, BOX_HISTORY_KEEP, BOX_SUBDIR,
};
