'use strict';

const { scanIntentLines } = require('./intent-segments');
const { looksLikeIntent, parseIntent } = require('./intent-scanner');
const { pluginRowFor } = require('./intent-registry');
const { headOf, replyGlyphFor } = require('./intent-glyphs');
const { pointerMatch, receiptOf } = require('./intent-spill');
const { FILED_POINTER_RE } = require('./spill-grammar');
const { DEFAULT_MAX_BYTES } = require('./exec-schema');
const { sniffReader } = require('./transcript-readers');
const { TURN_KINDS, isInternalRow } = require('./transcript-internal');

const RECORD_CAP = 400;
const PROMPT_CAP = 4096;
const PROSE_CAP = 65536;
const IMAGE_CAP = 1024 * 1024;
const IMAGE_MARK_RE = /\[Image #(\d+)\]/g;
const NOTE_CAP = 300;
const ONLY_MAX = 80;
const INPUT_KEYS = ['command', 'file_path', 'path', 'pattern', 'url', 'query', 'description', 'prompt'];
const INBOUND_RE = /^\[agent:from ([^\]\s]+)\][ \t]*/;
const LEAD_MARKS_RE = /^(?:\[Image #\d+\]|\[Pasted text #\d+ \+\d+ lines\])+/;
const TAIL_IMAGE_LABEL_RE = /(?:\nImage:[ \t]*)+$/;
const TEAMMATE_RE = /^Another Claude session sent a message:\s*<teammate-message ([^\n]*)>\n?([\s\S]*?)<\/teammate-message>/;
const RUNTIME_RE = /^\[agent:([a-z-]+)\][ \t]*/;
const CLIENT_TAG_RE = /^\(via ([a-z][a-z0-9-]{0,15})\)[ \t]*/;
const ATTACHED_RE = /Message \((\d+) bytes\) attached: @(\S+)/;
const EXIT_RE = /^Exit code (\d+)/;
const DENIED_RE = /^(?:The user doesn't want to proceed with this tool use|Permission to use \S+ has been denied)/;
const INTERRUPT_RE = /^\[Request interrupted by user[^\]]*\]/;
const PASTE_RE = /<pasted_content id="([A-Za-z0-9]+)">\n?([\s\S]*?)<\/pasted_content(?: id="\1")?>/g;
const PASTE_OPEN = '<pasted_content id="';
const TICKET_RE = /^\[ticket (t\d+)(?: ([^\]]+))?\]/;
const TICKET_REPLY_RE = /^ticket (t\d+)\b/;
const TODO_TOOLS = new Set(['TodoWrite', 'TaskCreate', 'TaskUpdate']);

function ticketOf(text, form = 'inbound') {
  const s = String(text == null ? '' : text);
  if (form === 'reply') {
    const m = TICKET_REPLY_RE.exec(s);
    return m ? { id: m[1], tag: null } : null;
  }
  const m = TICKET_RE.exec(s);
  return m ? { id: m[1], tag: m[2] == null ? null : m[2] } : null;
}

function firstLine(s, max = 160) {
  const line = String(s == null ? '' : s).split('\n').find((l) => l.trim()) || '';
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

function toolInputLine(input) {
  if (!input || typeof input !== 'object') return firstLine(input);
  for (const k of INPUT_KEYS) if (typeof input[k] === 'string' && input[k].trim()) return firstLine(input[k]);
  return firstLine(JSON.stringify(input));
}

const CD_RE = /^cd[ \t]+(?:"([^"]+)"|'([^']+)'|([^\s;&]+))[ \t]*(?:;|&&)\s*/;

function trimSlash(p) {
  return p.length > 1 ? p.replace(/\/+$/, '') : p;
}

function isSeatPath(p, cwd) {
  if (typeof cwd !== 'string' || !cwd) return false;
  const want = trimSlash(p);
  const here = trimSlash(cwd);
  if (want === here) return true;
  const cut = here.lastIndexOf('/');
  const prefix = `${here.slice(0, cut + 1)}${here.slice(cut + 1)}-t`;
  return want.startsWith(prefix) && !want.slice(prefix.length).includes('/');
}

function bashShown(command, cwd) {
  if (typeof command !== 'string') return null;
  const m = CD_RE.exec(command.trimStart());
  if (!m || !isSeatPath(m[1] || m[2] || m[3], cwd)) return null;
  const rest = command.trimStart().slice(m[0].length);
  return rest.trim() ? firstLine(rest) : null;
}

function toolRecord(base, b, cwd) {
  const tool = { ...base, id: b.id, kind: 'tool', name: b.name || 'tool', arg: toolInputLine(b.input), state: 'pending', sum: null };
  if (tool.name !== 'Bash' || !b.input || typeof b.input !== 'object') return tool;
  const shown = bashShown(b.input.command, cwd);
  if (shown != null && shown !== tool.arg) tool.argShown = shown;
  if (typeof b.input.description === 'string' && b.input.description.trim()) tool.desc = firstLine(b.input.description);
  return tool;
}

function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter((b) => b && b.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('\n');
}

function imagesOf(content, text) {
  if (!Array.isArray(content)) return [];
  const marks = [...new Set([...text.matchAll(IMAGE_MARK_RE)].map((m) => Number(m[1])))];
  const blocks = content.filter((b) => b && b.type === 'image' && b.source && typeof b.source.data === 'string');
  let top = 0;
  return blocks.map((b, k) => {
    const n = k < marks.length ? marks[k] : top + 1;
    top = Math.max(top, n);
    const mediaType = b.source.media_type;
    const data = b.source.data;
    const bytes = Math.floor((data.length * 3) / 4) - (data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0);
    if (bytes <= IMAGE_CAP) return { n, mediaType, data };
    return { n, mediaType, bytes };
  });
}

function clientTagOf(text) {
  const m = CLIENT_TAG_RE.exec(text);
  return m ? { client: m[1], text: text.slice(m[0].length) } : { client: null, text };
}

function tagBody(text, tag) {
  const open = `<${tag}>`;
  const start = text.indexOf(open);
  if (start < 0) return null;
  const end = text.indexOf(`</${tag}>`, start + open.length);
  return (end < 0 ? text.slice(start + open.length) : text.slice(start + open.length, end)).trim();
}

function capped(fields, key, text, cap) {
  if (text.length <= cap) return { ...fields, [key]: text };
  return { ...fields, [key]: text.slice(0, cap), truncated: true };
}

function lineCount(text) {
  const t = String(text || '').replace(/\n+$/, '');
  return t ? t.split('\n').length : 0;
}

function pastesOf(text) {
  const pastes = [];
  const out = text.replace(PASTE_RE, (_, id, body) => {
    const t = body.replace(/\n+$/, '');
    const n = pastes.length + 1;
    pastes.push({ n, lines: lineCount(t), ...capped({}, 'text', t, PROSE_CAP) });
    return `\u0000${n}\u0000`;
  });
  if (!pastes.length) return { text, pastes };
  const marked = out.replace(/\n*\u0000(\d+)\u0000\n*/g, (m, n, off, s) => {
    const p = pastes[n - 1];
    const before = off > 0 ? '\n' : '';
    const after = off + m.length < s.length ? '\n' : '';
    return `${before}[Pasted text #${n} +${p.lines} lines]${after}`;
  });
  return { text: marked.trim(), pastes };
}

function tsOf(rec) {
  const t = Date.parse(rec.timestamp);
  return Number.isFinite(t) ? t : null;
}

function patchCounts(patch) {
  let add = 0;
  let del = 0;
  for (const hunk of Array.isArray(patch) ? patch : []) {
    for (const l of Array.isArray(hunk && hunk.lines) ? hunk.lines : []) {
      if (typeof l !== 'string') continue;
      if (l[0] === '+') add += 1;
      else if (l[0] === '-') del += 1;
    }
  }
  return { add, del };
}

function outputSum(text) {
  const lines = lineCount(text);
  const only = lines === 1 ? String(text).trim() : '';
  return { lines, only: only && only.length <= ONLY_MAX ? only : null };
}

function bashSum(tur, content, isError) {
  const obj = tur && typeof tur === 'object' ? tur : {};
  let exit = 0;
  let body = [obj.stdout, obj.stderr].filter((s) => typeof s === 'string' && s).join('\n');
  if (isError) {
    const head = firstLine(content);
    const m = EXIT_RE.exec(head);
    exit = m ? Number(m[1]) : null;
    body = String(content).split('\n').slice(1).join('\n');
  }
  const { lines, only } = outputSum(body);
  return {
    exit,
    lines,
    interrupted: !!obj.interrupted,
    background: !!obj.backgroundTaskId,
    persisted: typeof obj.persistedOutputSize === 'number' ? obj.persistedOutputSize : null,
    only,
  };
}

function todoSum(input) {
  const list = input && Array.isArray(input.todos) ? input.todos : [];
  return { done: list.filter((t) => t && t.status === 'completed').length, total: list.length };
}

function okSum(name, input, tur, content) {
  const t = tur && typeof tur === 'object' ? tur : {};
  const file = t.filePath || (input && input.file_path) || null;
  switch (name) {
    case 'Bash': return bashSum(tur, content, false);
    case 'Edit':
    case 'MultiEdit': return { file, ...patchCounts(t.structuredPatch) };
    case 'Write': {
      const created = t.type === 'create';
      const counts = created ? { add: lineCount(t.content), del: 0 } : patchCounts(t.structuredPatch);
      return { file, created, ...counts };
    }
    case 'Read': {
      const f = t.file && typeof t.file === 'object' ? t.file : {};
      const from = typeof f.startLine === 'number' ? f.startLine : null;
      const n = typeof f.numLines === 'number' ? f.numLines : null;
      return { file: f.filePath || file, from, to: from != null && n != null ? from + Math.max(0, n - 1) : null, total: f.totalLines ?? null };
    }
    case 'Grep': return { files: t.numFiles ?? null, lines: t.numLines ?? null };
    case 'Glob': return { files: t.numFiles ?? null, truncated: !!t.truncated };
    case 'WebFetch': return { code: t.code ?? null, bytes: t.bytes ?? null };
    case 'WebSearch': return { results: t.searchCount ?? null };
    case 'Agent':
    case 'Task': return { description: t.description || (input && input.description) || null, model: t.resolvedModel || t.model || null, status: t.status || null };
    default:
      if (TODO_TOOLS.has(name)) return todoSum(input);
      return { lines: lineCount(content) };
  }
}

function settle(rec, input, block, tur) {
  const content = textOf(block.content);
  const isError = block.is_error === true;
  const toolError = content.startsWith('<tool_use_error>');
  if (isError || toolError) {
    rec.state = DENIED_RE.test(content) ? 'denied' : 'error';
    if (rec.name === 'Bash' && EXIT_RE.test(content)) rec.sum = bashSum(tur, content, true);
    else rec.sum = { message: firstLine(content.replace(/<\/?tool_use_error>/g, '')) };
    return;
  }
  rec.state = tur && typeof tur === 'object' && tur.interrupted ? 'interrupted' : 'ok';
  rec.sum = okSum(rec.name, input, tur, content);
}

function teammateText(body) {
  try {
    const parsed = JSON.parse(body);
    if (parsed && typeof parsed.result === 'string') return parsed.result;
  } catch {}
  return body;
}

function injectedPaste(text) {
  const blocks = [...text.matchAll(PASTE_RE)];
  if (blocks.length !== 1 || blocks[0][0].length !== text.length) return null;
  const body = blocks[0][2].replace(/^\n+|\n+$/g, '');
  return INBOUND_RE.test(body) || RUNTIME_RE.test(body) ? body : null;
}

function userRecords(rec, base, tools, spawned) {
  const content = rec.message.content;
  if (Array.isArray(content)) {
    for (const b of content) {
      if (!b || b.type !== 'tool_result') continue;
      const tool = tools.get(b.tool_use_id);
      if (!tool) continue;
      settle(tool.rec, tool.input, b, rec.toolUseResult);
      if (isSpawn(tool.rec.name) && typeof rec.toolUseResult?.name === 'string') spawned.add(rec.toolUseResult.name);
    }
  }
  if (rec.isMeta || rec.isCompactSummary) return [];
  let text = textOf(content).trim();
  if (!text) return [];
  if (rec.origin && rec.origin.kind === 'task-notification') {
    const summary = tagBody(text, 'summary');
    return [{ ...base, kind: 'notification', text: firstLine(summary || text.replace(/<[^>]*>/g, '\n'), NOTE_CAP) }];
  }
  const mate = TEAMMATE_RE.exec(text);
  if (mate) {
    const from = (/teammate_id="([^"]+)"/.exec(mate[1]) || [null, 'subagent'])[1];
    const fields = { ...base, kind: 'inbound', from, via: 'subagent' };
    if (!spawned.has(from)) fields.unverified = true;
    return [capped(fields, 'text', teammateText(mate[2].trim()), PROMPT_CAP)];
  }
  if (INTERRUPT_RE.test(text)) return [{ ...base, kind: 'notice', level: 'warning', text: INTERRUPT_RE.exec(text)[0].slice(1, -1) }];
  if (text.startsWith('<') && !text.startsWith(PASTE_OPEN)) return [];
  const unwrapped = injectedPaste(text);
  if (unwrapped != null) text = unwrapped;
  const lead = LEAD_MARKS_RE.exec(text);
  const leadFrom = lead ? INBOUND_RE.exec(text.slice(lead[0].length)) : null;
  const viaLead = Boolean(leadFrom && leadFrom[1] === 'user');
  const from = viaLead ? leadFrom : INBOUND_RE.exec(text);
  if (from) {
    const after = text.slice((viaLead ? lead[0].length : 0) + from[0].length);
    const user = from[1] === 'user';
    const tagged = user ? clientTagOf(after) : { client: null, text: after };
    const client = tagged.client;
    const rest = user ? ((viaLead ? lead[0] : '') + tagged.text).replace(TAIL_IMAGE_LABEL_RE, '') : tagged.text;
    const att = ATTACHED_RE.exec(rest);
    const ticket = ticketOf(rest);
    const pasted = user ? pastesOf(rest) : { text: rest, pastes: [] };
    const images = user ? imagesOf(content, rest) : [];
    const card = capped({ ...base, kind: 'inbound', from: from[1], ...(client ? { client } : {}), ...(ticket ? { ticket } : {}) }, 'text', pasted.text, PROMPT_CAP);
    const extra = { ...(pasted.pastes.length ? { pastes: pasted.pastes } : {}), ...(images.length ? { images } : {}) };
    return [att ? { ...card, ...extra, attached: { path: att[2], bytes: Number(att[1]) } } : { ...card, ...extra }];
  }
  const runtime = RUNTIME_RE.exec(text);
  if (runtime) {
    const verb = runtime[1];
    const { glyph, label } = replyGlyphFor(verb, pluginRowFor(verb));
    const said = text.slice(runtime[0].length);
    const ticket = verb === 'task' ? ticketOf(said, 'reply') : null;
    return [capped({ ...base, kind: 'reply', verb, glyph, label, ...(ticket ? { ticket } : {}) }, 'text', said, PROMPT_CAP)];
  }
  const fields = { ...base, kind: 'prompt' };
  const pasted = pastesOf(text);
  const out = capped(fields, 'text', pasted.text, PROMPT_CAP);
  const source = rec.promptSource === 'queued' ? 'queued' : 'typed';
  const prompt = pasted.pastes.length ? { ...out, source, pastes: pasted.pastes } : { ...out, source };
  const images = imagesOf(content, text);
  return [images.length ? { ...prompt, images } : prompt];
}

const SIZE_RE = /^(\d+(?:\.\d)?) (B|KB)/;

function spillOf(text) {
  const m = FILED_POINTER_RE.exec(String(text || ''));
  if (!m) return { path: null, bytes: null, title: null };
  const size = SIZE_RE.exec(m[2]);
  const bytes = size ? Math.round(Number(size[1]) * (size[2] === 'KB' ? 1024 : 1)) : null;
  return { path: m[3], bytes, title: m[1] || null };
}

function intentSegment(intent, closed) {
  const { type, sub, body, bodyOpen, spill: _spill, ...fields } = intent;
  const head = headOf(intent, pluginRowFor(type));
  const filed = pointerMatch(typeof body === 'string' ? body.trim() : body);
  return {
    kind: 'intent',
    verb: type,
    sub: sub == null ? null : sub,
    fields,
    body: filed || typeof body !== 'string' || !body.trim() ? null : body,
    state: filed ? 'filed' : 'fire',
    spill: filed ? spillOf(body.trim()) : null,
    open: !closed,
    head,
  };
}

function receiptSegment(rc) {
  const intent = parseIntent(`[agent:${rc.head}]`) || { type: rc.type, sub: rc.sub };
  return {
    kind: 'intent',
    verb: intent.type,
    sub: intent.sub == null ? null : intent.sub,
    fields: {},
    body: null,
    state: 'filed',
    spill: { path: rc.path, bytes: null, title: null },
    open: false,
    head: headOf(intent, pluginRowFor(intent.type)),
  };
}

function proseSegments(lines) {
  const out = [];
  let run = [];
  const flush = () => {
    const text = run.join('\n').replace(/^\n+|\s+$/g, '');
    if (text.trim()) out.push({ kind: 'prose', text });
    run = [];
  };
  for (const line of lines) {
    const rc = receiptOf(line);
    if (rc) { flush(); out.push(receiptSegment(rc)); continue; }
    if (FILED_POINTER_RE.test(line)) { flush(); out.push({ kind: 'prose', text: line.trim(), spill: spillOf(line) }); continue; }
    run.push(line);
  }
  flush();
  return out;
}

function segmentsOf(text) {
  const lines = String(text == null ? '' : text).split('\n');
  if (!lines.some((l) => looksLikeIntent(l) || FILED_POINTER_RE.test(l) || receiptOf(l))) return null;
  const segs = [];
  for (const seg of scanIntentLines(lines, { execBodyCap: DEFAULT_MAX_BYTES })) {
    if (seg.kind === 'prose') segs.push(...proseSegments(lines.slice(seg.from, seg.to)));
    else if (seg.kind === 'near-miss') segs.push({ kind: 'inert', text: lines[seg.at].trim() });
    else if (seg.kind === 'intent') segs.push(intentSegment(seg.intent, seg.closed));
  }
  return segs.some((s) => s.kind !== 'prose' || s.spill) ? segs : null;
}

function capSegments(segs) {
  let budget = PROSE_CAP;
  let truncated = false;
  const out = segs.map((seg) => {
    const key = seg.kind === 'intent' ? 'body' : 'text';
    const v = seg[key];
    if (typeof v !== 'string') return seg;
    const cut = v.length > budget;
    const kept = cut ? v.slice(0, Math.max(0, budget)) : v;
    budget = Math.max(0, budget - kept.length);
    if (cut) truncated = true;
    return cut ? { ...seg, [key]: kept } : seg;
  });
  return { segments: out, truncated };
}

function assistantRecords(rec, base, tools, spawned) {
  const content = rec.message.content;
  if (!Array.isArray(content)) return [];
  const texts = content.filter((b) => b && b.type === 'text').length;
  const out = [];
  content.forEach((b, i) => {
    if (!b) return;
    if (b.type === 'text' && typeof b.text === 'string' && b.text.trim()) {
      const id = texts > 1 ? `${base.id}:${i}` : base.id;
      const text = b.text.trim();
      let r = capped({ ...base, id, kind: 'assistant' }, 'text', text, PROSE_CAP);
      const segs = rec.isApiErrorMessage ? null : segmentsOf(text);
      if (segs) {
        const { segments, truncated } = capSegments(segs);
        r = { ...r, segments };
        if (truncated) r.truncated = true;
      }
      out.push(rec.isApiErrorMessage ? { ...r, apiError: true } : r);
    } else if (b.type === 'tool_use' && b.id) {
      const tool = toolRecord(base, b, rec.cwd);
      tools.set(b.id, { rec: tool, input: b.input });
      if (isSpawn(b.name) && b.input && typeof b.input.name === 'string') spawned.add(b.input.name);
      out.push(tool);
    }
  });
  return out;
}

function systemRecords(rec, base) {
  if (rec.subtype === 'local_command') {
    const content = typeof rec.content === 'string' ? rec.content : '';
    const name = tagBody(content, 'command-name');
    if (name) return [{ ...base, kind: 'command', name, args: tagBody(content, 'command-args') || '' }];
    const text = tagBody(content, 'local-command-stdout');
    return text ? [{ ...base, kind: 'command-output', text }] : [];
  }
  if (rec.subtype === 'compact_boundary') {
    const m = rec.compactMetadata || {};
    return [{ ...base, kind: 'boundary', what: 'compact', trigger: m.trigger || null, preTokens: m.preTokens ?? null, postTokens: m.postTokens ?? null }];
  }
  if (rec.subtype === 'turn_duration') {
    return [{ ...base, kind: 'turn-end', durationMs: rec.durationMs ?? null, messageCount: rec.messageCount ?? null }];
  }
  if (rec.subtype === 'informational' && typeof rec.content === 'string' && rec.content.trim()) {
    const level = rec.level === 'warning' || rec.level === 'error' ? rec.level : 'info';
    return [{ ...base, kind: 'notice', level, text: rec.content.trim() }];
  }
  return [];
}

function midTurnRecords(rec, base, tools, spawned) {
  const a = rec.attachment;
  if (!a || a.type !== 'queued_command' || !a.origin || a.origin.kind !== 'human') return [];
  const user = { type: 'user', uuid: rec.uuid, timestamp: rec.timestamp, message: { role: 'user', content: a.prompt } };
  return userRecords(user, base, tools, spawned).map((r) => (r.kind === 'prompt' ? { ...r, source: 'mid-turn', state: 'delivered' } : { ...r, source: 'mid-turn' }));
}

function isSpawn(name) {
  return name === 'Agent' || name === 'Task';
}

function recordsOfLine(rec, base, tools, spawned) {
  if (rec.type === 'system') return systemRecords(rec, base);
  if (rec.type === 'attachment') return midTurnRecords(rec, base, tools, spawned);
  if (!rec.message) return [];
  if (rec.type === 'user') return userRecords(rec, base, tools, spawned);
  if (rec.type === 'assistant') return assistantRecords(rec, base, tools, spawned);
  return [];
}

function cutOnTurn(all, max) {
  if (all.length <= max) return all;
  let start = all.length - max;
  const headTurn = all[start - 1].turn;
  let s = start;
  while (s < all.length && all[s].turn === headTurn) s += 1;
  if (s < all.length) return all.slice(s);
  const head = all.find((r) => r.turn === headTurn && TURN_KINDS.has(r.kind));
  return head ? [head, ...all.slice(start + 1)] : all.slice(start);
}

function echoedCommand(rec) {
  if (rec.type !== 'user' || !rec.message) return null;
  const name = tagBody(textOf(rec.message.content).trim(), 'command-name');
  if (!name) return null;
  return name.startsWith('/') ? name : `/${name}`;
}

function isTypedEcho(prompt, name) {
  return prompt.text === name || prompt.text.startsWith(`${name} `);
}

function stampOf(rec) {
  if (typeof rec.timestamp === 'string') return rec.timestamp;
  return Number.isFinite(rec.recorded_at) ? new Date(Math.floor(rec.recorded_at / 1000)).toISOString() : null;
}

function claudeShaped(rec) {
  const reader = sniffReader(rec);
  if (reader.id === 'claude') return [rec];
  const c = reader.classify(rec);
  const payload = rec.payload || {};
  const id = rec.id || rec.uuid || payload.id;
  const timestamp = stampOf(rec);
  const spoken = reader.id !== 'codex' || rec.type === 'response_item';
  const out = [];
  if (c.command) out.push({ type: 'system', subtype: 'local_command', uuid: id, timestamp, content: `<command-name>${c.command}</command-name>` });
  if (spoken && c.prompt) out.push({ type: 'user', uuid: id, timestamp, message: { role: 'user', content: c.prompt } });
  if (spoken && c.isReply && c.text) out.push({ type: 'assistant', uuid: c.rid || id, timestamp, message: { role: 'assistant', content: [{ type: 'text', text: c.text }] } });
  if (c.turnEnd) {
    const ms = (payload.event || {}).turn_duration_ms;
    out.push({ type: 'system', subtype: 'turn_duration', uuid: id, timestamp, durationMs: Number.isFinite(ms) ? ms : null });
  }
  return out;
}

function queueStep(queued, rec, n) {
  if (rec.operation === 'enqueue') return typeof rec.content === 'string' ? [...queued, { ts: tsOf(rec), text: rec.content, n }] : queued;
  if (rec.operation === 'dequeue') return queued.slice(1);
  if (rec.operation === 'popAll') return [];
  if (rec.operation !== 'remove') return queued;
  const at = queued.findIndex((q) => q.text === rec.content);
  return queued.filter((_, i) => i !== (at < 0 ? 0 : at));
}

function recordsOf(text, max = RECORD_CAP) {
  const tools = new Map();
  const spawned = new Set();
  const all = [];
  let turn = 0;
  let typedPrompt = null;
  let unread = [];
  let queued = [];
  let enqueues = 0;
  let pushed = 0;
  const lines = [];
  for (const line of String(text).split('\n')) {
    if (!line.trim()) continue;
    let obj;
    try { obj = JSON.parse(line); } catch { continue; }
    if (!obj || typeof obj !== 'object') continue;
    for (const one of sniffReader(obj).expand(obj)) {
      if (one && typeof one === 'object') lines.push(...claudeShaped(one));
    }
  }
  for (const rec of lines) {
    if (rec.isSidechain) continue;
    if (rec.type === 'queue-operation') {
      queued = queueStep(queued, rec, enqueues);
      if (rec.operation === 'enqueue') enqueues += 1;
      continue;
    }
    const echoed = echoedCommand(rec);
    if (echoed && typedPrompt && rec.promptId && typedPrompt.promptId === rec.promptId && isTypedEcho(typedPrompt.record, echoed)) {
      all.splice(typedPrompt.at, 1);
      for (let i = typedPrompt.at; i < all.length; i += 1) all[i].turn -= 1;
      turn -= 1;
      typedPrompt = null;
    }
    const base = { id: rec.uuid || `line:${pushed}`, kind: '', ts: tsOf(rec), turn };
    const produced = recordsOfLine(rec, base, tools, spawned);
    for (const r of produced) {
      if (r.kind === 'prompt' && r.source !== 'mid-turn') typedPrompt = { at: all.length, promptId: rec.promptId || null, record: r };
      const midTurn = r.source === 'mid-turn';
      if (TURN_KINDS.has(r.kind) && !midTurn) { turn += 1; if (r.kind !== 'boundary') { unread = []; queued = []; } }
      r.turn = turn;
      if ((r.kind === 'assistant' && !r.apiError) || r.kind === 'tool') {
        for (const u of unread) u.state = 'read';
        unread = [];
      }
      if (midTurn && r.kind === 'prompt') unread.push(r);
      all.push(r);
      pushed += 1;
    }
  }
  queued.forEach((q) => {
    const user = { type: 'user', message: { role: 'user', content: q.text } };
    for (const r of userRecords(user, { id: `queued:${q.ts}:${q.n}`, kind: '', ts: q.ts, turn }, tools, spawned)) {
      if (r.kind === 'prompt') all.push({ ...r, source: 'mid-turn', state: 'queued' });
    }
  });
  return { records: cutOnTurn(all, max) };
}

module.exports = { RECORD_CAP, PROMPT_CAP, PROSE_CAP, IMAGE_CAP, imagesOf, clientTagOf, recordsOf, segmentsOf, toolInputLine, isInternalRow, ticketOf };
