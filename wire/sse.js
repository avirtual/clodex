'use strict';

// SSE event framing + per-provider text-delta extraction + usage capture.
// Seeded from clodex2 lib/sse.js (port of agent-workbench proxy.py's
// _parse_sse_event, _anthropic_text_delta, _openai_text_delta,
// _UsageCollector).

// Events are separated by a blank line: \n\n or \r\n\r\n. Boundaries are
// ASCII, so slicing at them never splits a multibyte character.
class SSEFramer {
  constructor(onEvent) {
    this.onEvent = onEvent;
    this._buf = Buffer.alloc(0);
  }

  feed(chunk) {
    if (!chunk || !chunk.length) return;
    this._buf = this._buf.length ? Buffer.concat([this._buf, chunk]) : chunk;
    for (;;) {
      const iLf = this._buf.indexOf('\n\n');
      const iCrlf = this._buf.indexOf('\r\n\r\n');
      let boundary, blen;
      if (iCrlf !== -1 && (iLf === -1 || iCrlf < iLf)) { boundary = iCrlf; blen = 4; }
      else if (iLf !== -1) { boundary = iLf; blen = 2; }
      else break;
      const raw = this._buf.slice(0, boundary).toString('utf8');
      this._buf = this._buf.slice(boundary + blen);
      this._emit(raw);
    }
  }

  _emit(raw) {
    let event = null;
    const data = [];
    for (const line of raw.split('\n')) {
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
    }
    this.onEvent(event, data.length ? data.join('\n') : null);
  }
}

function anthropicTextDelta(event, data) {
  if (!data) return null;
  let obj;
  try { obj = JSON.parse(data); } catch { return null; }
  if (obj.type !== 'content_block_delta') return null;
  const d = obj.delta || {};
  // thinking_delta / input_json_delta intentionally ignored — turn text is
  // visible assistant text only.
  return d.type === 'text_delta' ? (d.text || '') : null;
}

function openaiTextDelta(event, data) {
  if (!data || data.trim() === '[DONE]') return null;
  let obj;
  try { obj = JSON.parse(data); } catch { return null; }
  // Responses API
  if (obj.type === 'response.output_text.delta') return obj.delta || '';
  // Chat Completions
  const choices = obj.choices;
  if (Array.isArray(choices) && choices.length) {
    const delta = choices[0].delta || {};
    if (typeof delta.content === 'string') return delta.content;
  }
  return null;
}

// Accumulates usage + response meta from an Anthropic stream. The merged
// `record` (message_delta usage assigned over message_start's) is the
// back-compat telemetry view; billing consumes `meta` instead, which keeps
// usage_start and usage_final SEPARATE because the Python contract's
// fallbacks are asymmetric (output_tokens from final ONLY, service_tier
// from start ONLY — proxylab/billing.py _billing / _parse_response_meta).
// usage_final is the LAST message_delta's usage object verbatim, replaced
// not merged, per the cumulative-usage_final billing contract.
const _INTERESTING = new Set([
  'message_start', 'message_delta', 'content_block_start', 'error', 'rate_limit_error',
]);

class UsageCollector {
  constructor() {
    this.messageId = null;
    this.usage = {};
    this._has = false;
    this.resolvedModel = null;
    this.role = null;
    this.usageStart = null;
    this.usageFinal = null;
    this.stopReason = null;
    this.stopSequence = null;
    this.stopDetails = null;
    this.contentBlockTypes = [];
    this.toolUses = [];
    this.error = null;
  }

  onEvent(event, data) {
    if (!data) return;
    // Gate by SSE event name when present (skips the hot content_block_delta
    // path); an unnamed event falls through to the type check, matching the
    // Python parser which never reads event names.
    if (event != null && !_INTERESTING.has(event)) return;
    let obj;
    try { obj = JSON.parse(data); } catch { return; }
    const t = obj.type;
    if (t === 'message_start') {
      const msg = obj.message || {};
      this.messageId = msg.id || null;
      this.resolvedModel = msg.model !== undefined ? msg.model : null;
      this.role = msg.role !== undefined ? msg.role : null;
      this.usageStart = msg.usage !== undefined ? msg.usage : null;
      const u = msg.usage || {};
      Object.assign(this.usage, u);
      if (Object.keys(u).length) this._has = true;
    } else if (t === 'content_block_start') {
      const cb = obj.content_block || {};
      this.contentBlockTypes.push(cb.type !== undefined ? cb.type : null);
      if (cb.type === 'tool_use') this.toolUses.push(cb.name);
    } else if (t === 'message_delta') {
      if (obj.usage != null) this.usageFinal = obj.usage; // last delta wins, verbatim
      const d = obj.delta || {};
      this.stopReason = d.stop_reason || this.stopReason;
      if (d.stop_sequence != null) this.stopSequence = d.stop_sequence;
      this.stopDetails = d.stop_details || this.stopDetails;
      const u = obj.usage || {};
      Object.assign(this.usage, u);
      if (Object.keys(u).length) this._has = true;
    } else if (t === 'error' || t === 'rate_limit_error') {
      this.error = obj.error || obj;
    }
  }

  get record() {
    if (!this._has) return null;
    return { message_id: this.messageId || '', ...this.usage };
  }

  // Mirrors proxylab billing._parse_response_meta's dict (minus `text`,
  // which the tee accumulates uncapped).
  get meta() {
    return {
      message_id: this.messageId,
      resolved_model: this.resolvedModel,
      role: this.role,
      stop_reason: this.stopReason,
      stop_sequence: this.stopSequence,
      stop_details: this.stopDetails,
      usage_start: this.usageStart,
      usage_final: this.usageFinal,
      content_block_types: this.contentBlockTypes,
      tool_uses: this.toolUses,
      error: this.error,
    };
  }
}

// File-touch observer (anthropic streams): collects which files the session's
// file-mutating tools (Edit/Write/NotebookEdit + legacy MultiEdit) were aimed
// at, off the same framer feed the text/usage collectors ride. Feeds the
// touched-files UI — a FACT extractor (tool name + target path), no policy.
//
// Hot-path discipline: tool inputs stream as input_json_delta fragments inside
// content_block_delta — the highest-volume event type. This collector JSON-
// parses a delta ONLY while a tracked file-tool block is open and its path is
// still unknown (the path key arrives early in the input object — though not
// always first: real Edit calls stream `replace_all` ahead of it); outside
// those windows deltas are dropped on the event-name check alone. A per-block
// accumulation cap bounds memory even if a path key never shows up.
//
// Semantics note: a tool_use in the response is the model's REQUEST to touch
// the file — the CLI runs it (or the user denies it) after this stream ends.
// Slight over-report is accepted; the peek/diff UI shows ground truth.
//
// Two channels, kept STRICTLY separate (the boiling pot, boiling-pot-plan.md [internal design doc, not in this repo]
// tier 1): `files` = MUTATIONS (FILE_TOOLS) — the touched-files UI's semantic
// contract, unchanged. `reads` = Read calls, captured with offset/limit when
// present, for file-heat ranking. A Read never enters `files` and a mutation
// never enters `reads` — cross-contamination is the silent-refactor hazard the
// wire-proxy test pins. Read inputs carry no huge field, so they skip the
// early-extract/give-up machinery: the whole (small) input is buffered to
// content_block_stop and parsed once (JSON, regex fallback for the path).
const FILE_TOOLS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit']);
const _FT_EVENTS = new Set(['content_block_start', 'content_block_delta', 'content_block_stop']);
// Give-up depth. The path key usually leads the input, but not always (real
// Edit calls stream `replace_all` first, and a big old_string CAN precede
// file_path) — so the cap is generous; accumulation stops at first match.
const _FT_BUF_CAP = 65536;
const _FT_PATH_RE = /"(?:file_path|notebook_path)"\s*:\s*"((?:[^"\\]|\\.)*)"/;

class FileToolCollector {
  constructor() {
    this._blocks = new Map(); // index -> { kind:'edit'|'read', tool, buf, path }
    this._files = [];         // { tool, path } mutations, in stream order
    this._reads = [];         // { tool:'Read', path, offset?, limit? } in stream order
  }

  _tryExtract(entry) {
    const m = _FT_PATH_RE.exec(entry.buf);
    if (!m) return false;
    try { entry.path = JSON.parse(`"${m[1]}"`); } catch { entry.path = m[1]; }
    entry.buf = '';
    this._files.push({ tool: entry.tool, path: entry.path });
    return true;
  }

  // A Read block's full input is buffered by content_block_stop; parse it once.
  // Primary path: the accumulated buffer is a complete JSON object (Read inputs
  // are tiny) → read file_path/offset/limit directly. Fallback: a malformed/
  // partial buffer still yields the path via the shared regex (offset/limit then
  // simply absent). offset/limit are emitted ONLY when present as integers.
  _extractRead(entry) {
    let filePath = null, offset = null, limit = null;
    let obj = null;
    try { obj = JSON.parse(entry.buf); } catch { obj = null; }
    if (obj && typeof obj === 'object') {
      if (typeof obj.file_path === 'string') filePath = obj.file_path;
      if (Number.isInteger(obj.offset)) offset = obj.offset;
      if (Number.isInteger(obj.limit)) limit = obj.limit;
    } else {
      const m = _FT_PATH_RE.exec(entry.buf);
      if (m) { try { filePath = JSON.parse(`"${m[1]}"`); } catch { filePath = m[1]; } }
    }
    if (!filePath) return;
    const rec = { tool: 'Read', path: filePath };
    if (offset != null) rec.offset = offset;
    if (limit != null) rec.limit = limit;
    this._reads.push(rec);
  }

  onEvent(event, data) {
    if (!data) return;
    if (event != null && !_FT_EVENTS.has(event)) return;
    // Nothing tracked and nothing can start here → skip the parse entirely.
    // (Unnamed events fall through, mirroring UsageCollector's gate.)
    if (event === 'content_block_delta' && this._blocks.size === 0) return;
    let obj;
    try { obj = JSON.parse(data); } catch { return; }
    const t = obj.type;
    if (t === 'content_block_start') {
      const cb = obj.content_block || {};
      if (cb.type === 'tool_use' && typeof obj.index === 'number') {
        if (FILE_TOOLS.has(cb.name)) {
          this._blocks.set(obj.index, { kind: 'edit', tool: cb.name, buf: '', path: null });
        } else if (cb.name === 'Read') {
          this._blocks.set(obj.index, { kind: 'read', tool: 'Read', buf: '', path: null });
        }
      }
    } else if (t === 'content_block_delta') {
      const entry = this._blocks.get(obj.index);
      if (!entry) return;
      const d = obj.delta || {};
      if (d.type !== 'input_json_delta' || typeof d.partial_json !== 'string') return;
      if (entry.kind === 'read') {
        // Buffer to stop, then parse once. Bound memory even on a malformed
        // never-ending input — a real Read input is well under the cap.
        entry.buf += d.partial_json;
        if (entry.buf.length > _FT_BUF_CAP) this._blocks.delete(obj.index);
        return;
      }
      if (entry.path !== null) return; // edit: accumulate only until path known
      entry.buf += d.partial_json;
      if (!this._tryExtract(entry) && entry.buf.length > _FT_BUF_CAP) {
        this._blocks.delete(obj.index); // unbounded input, no path key — drop
      }
    } else if (t === 'content_block_stop') {
      const entry = this._blocks.get(obj.index);
      if (entry) {
        if (entry.kind === 'read') this._extractRead(entry);
        else if (entry.path === null && entry.buf) this._tryExtract(entry);
        this._blocks.delete(obj.index);
      }
    }
  }

  // [{ tool, path }] for every file-MUTATING tool call whose target path was
  // seen. Reads are NOT here — they ride `reads` (the pot's separate channel).
  get files() { return this._files; }

  // [{ tool:'Read', path, offset?, limit? }] for every Read call, in stream
  // order. Empty when the turn read nothing.
  get reads() { return this._reads; }
}

// Codex/openai Responses-API stream: response.completed (or incomplete /
// failed) carries the FULL response object incl. usage. Port of
// proxylab codex._parse_openai_response minus the unframed-JSON error
// branch — a 4xx body isn't SSE, so no tee runs on it.
class OpenAIUsageCollector {
  constructor() {
    this.usage = null;
    this.resolvedModel = null;
    this.responseId = null;
    this.status = null;
    this.error = null;
  }

  onEvent(event, data) {
    if (!data || data.trim() === '[DONE]') return;
    let obj;
    try { obj = JSON.parse(data); } catch { return; }
    const t = obj.type;
    if (t === 'response.completed' || t === 'response.incomplete' || t === 'response.failed') {
      const r = obj.response || {};
      this.usage = r.usage !== undefined ? r.usage : null;
      this.resolvedModel = r.model !== undefined ? r.model : null;
      this.responseId = r.id !== undefined ? r.id : null;
      this.status = r.status !== undefined ? r.status : null;
      if (t === 'response.failed' && r.error) this.error = r.error;
    } else if (t === 'error') {
      this.error = obj;
    }
  }

  get meta() {
    return {
      usage: this.usage,
      resolved_model: this.resolvedModel,
      response_id: this.responseId,
      status: this.status,
      error: this.error,
    };
  }
}

module.exports = { SSEFramer, anthropicTextDelta, openaiTextDelta, UsageCollector, OpenAIUsageCollector, FileToolCollector, FILE_TOOLS };
