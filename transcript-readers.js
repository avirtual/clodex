const CODEX_TEXT_BLOCK_TYPES = ['output_text', 'input_text'];

const NON_FLUSHING_TYPES = ['assistant', 'response_item'];

const CODEX_TYPES = ['event_msg', 'response_item', 'token_usage_record', 'session_meta', 'turn_context'];

function blank() {
  return {
    text: '', isReply: false, rid: '', turnStart: false, turnEnd: false, interrupted: false,
    inert: false, sessionEnd: false, compactSummary: false, prompt: '',
  };
}

function codexResponseMessage(obj) {
  if ((obj.type || '') !== 'response_item') return null;
  const payload = obj.payload || {};
  if (payload.type !== 'message') return null;
  const role = payload.role;
  if (role !== 'assistant' && role !== 'user') return null;
  if (!Array.isArray(payload.content)) return null;
  const text = payload.content
    .filter(b => b && CODEX_TEXT_BLOCK_TYPES.includes(b.type) && b.text)
    .map(b => String(b.text))
    .join('\n');
  return text ? { role, text } : null;
}

function isCodexReply(obj) {
  const msg = codexResponseMessage(obj);
  return !!msg && msg.role === 'assistant';
}

function isTelemetryOnly(obj) {
  const type = obj.type || '';
  return type === 'token_usage_record'
    || (type === 'event_msg' && (obj.payload || {}).type === 'token_count');
}

function isTurnEndEntry(obj) {
  if (!obj || obj.isSidechain === true || obj.isMeta === true) return false;
  if ((obj.type || '') === 'assistant') {
    return ((obj.message || {}).stop_reason || '') === 'end_turn';
  }
  return (obj.type || '') === 'event_msg' && (obj.payload || {}).type === 'task_complete';
}

function isInterruptEntry(obj) {
  if (!obj || obj.isSidechain === true || obj.isMeta === true) return false;
  if ((obj.type || '') !== 'user') return false;
  const content = (obj.message || {}).content;
  if (!Array.isArray(content)) return false;
  const text = content
    .filter(b => b && b.type === 'text' && typeof b.text === 'string')
    .map(b => b.text)
    .join('\n')
    .trim();
  return text === '[Request interrupted by user]'
    || text === '[Request interrupted by user for tool use]';
}

function extractText(obj) {
  const type = obj.type || '';
  if (type === 'assistant') {
    const content = (obj.message || {}).content || [];
    if (!Array.isArray(content)) return '';
    return content
      .filter(b => b && b.type === 'text' && b.text)
      .map(b => b.text)
      .join('\n');
  }
  const payload = obj.payload || {};
  if (type === 'event_msg' && payload.type === 'agent_message') {
    return String(payload.message || '');
  }
  if (type === 'response_item' && payload.type === 'function_call_output') {
    return String(payload.output || '');
  }
  const msg = codexResponseMessage(obj);
  return msg && msg.role === 'assistant' ? msg.text : '';
}

function userPrompt(obj) {
  const type = obj.type || '';
  const payload = obj.payload || {};
  if (type === 'user') {
    const content = (obj.message || {}).content;
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
      return content.filter(b => b && b.type === 'text' && b.text).map(b => b.text).join('\n');
    }
    return '';
  }
  if (type === 'event_msg' && payload.type === 'user_message' && payload.message) {
    return String(payload.message);
  }
  const msg = codexResponseMessage(obj);
  return msg && msg.role === 'user' ? msg.text : '';
}

function classifyClaudeCodex(obj) {
  const c = blank();
  const type = obj.type || '';
  const payload = obj.payload || {};
  c.text = extractText(obj);
  c.rid = obj.requestId || payload.id || '';
  c.isReply = type === 'assistant' || payload.type === 'agent_message' || isCodexReply(obj);
  c.turnEnd = isTurnEndEntry(obj);
  c.interrupted = isInterruptEntry(obj);
  c.compactSummary = obj.isCompactSummary === true;
  c.prompt = userPrompt(obj);
  c.inert = !c.text && (NON_FLUSHING_TYPES.includes(type) || isTelemetryOnly(obj));
  return c;
}

function identity(obj) { return [obj]; }

function museExpand(obj) {
  if (obj.retained_marker !== undefined || obj.omitted_live_only !== undefined) return [];
  if (obj.retained_frame !== undefined) {
    const out = [];
    for (const child of Array.isArray(obj.children) ? obj.children : []) {
      if (!child || typeof child.record_json !== 'string') continue;
      try { out.push(JSON.parse(child.record_json)); } catch {}
    }
    return out;
  }
  return [obj];
}

function museClassify(obj) {
  const c = blank();
  const payloadType = obj.payload_type || '';
  const payload = obj.payload || {};
  if (payloadType === 'runtime.session' && payload.kind === 'run') {
    const event = payload.event || {};
    if (event.kind === 'assistant_message_committed') {
      c.text = String(event.text || '');
      c.isReply = true;
      c.rid = event.message_id || '';
      return c;
    }
    if (event.kind === 'terminal') {
      c.turnEnd = true;
      c.interrupted = event.terminal !== 'completed';
      return c;
    }
    if (event.kind === 'started') {
      c.turnStart = true;
      return c;
    }
    c.inert = true;
    return c;
  }
  if (payloadType === 'runtime.user_intent.accepted') {
    const blocks = Array.isArray(payload.refill_blocks) ? payload.refill_blocks : [];
    c.prompt = blocks.filter(b => b && typeof b.text === 'string').map(b => b.text).join('\n');
    return c;
  }
  if (payloadType === 'session.end') {
    c.sessionEnd = true;
    return c;
  }
  c.inert = true;
  return c;
}

function museSessionIdOf(target) {
  const m = /([^/]+)\/session\.jsonl$/.exec(target);
  return m ? m[1] : null;
}

const READERS = {
  claude: { id: 'claude', expand: identity, classify: classifyClaudeCodex },
  codex: { id: 'codex', expand: identity, classify: classifyClaudeCodex },
  muse: { id: 'muse', expand: museExpand, classify: museClassify, sessionIdOf: museSessionIdOf },
};

function sniffReader(obj) {
  if (!obj || typeof obj !== 'object') return READERS.claude;
  if (obj.payload_type !== undefined || obj.retained_frame !== undefined
    || obj.retained_marker !== undefined || obj.omitted_live_only !== undefined) return READERS.muse;
  if (CODEX_TYPES.includes(obj.type || '')) return READERS.codex;
  return READERS.claude;
}

const SNIFFING = {
  id: null,
  expand: (obj) => sniffReader(obj).expand(obj),
  classify: (obj) => sniffReader(obj).classify(obj),
};

function readerFor(id) {
  return Object.hasOwn(READERS, id) ? READERS[id] : SNIFFING;
}

module.exports = {
  readerFor, sniffReader,
  extractText, isTurnEndEntry, isInterruptEntry, isCodexReply, isTelemetryOnly, NON_FLUSHING_TYPES,
};
