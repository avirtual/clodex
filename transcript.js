// Transcript rendering off the CLI's on-disk JSONL. Two consumers: a full
// markdown export (jsonlToMarkdown, tool traffic included) and the remote
// (phone) chat view (jsonlToMessages, user/assistant text only). Both read the
// JSONL the CLI writes regardless of which observation path is live, so the
// remote view never depends on the intent machinery. extractText pulls the
// assistant-visible text from ONE parsed entry — the JsonlWatcher's per-line
// hook (that class stays in main.js this phase).
// Seam: plain functions over a path/string/object; only Node `fs` for the two
// file readers — no main.js state, no Electron. Handles BOTH the Claude
// (type:"user"/"assistant") and Codex (event_msg / response_item) shapes.
// Gotcha: jsonlToMessages strips injected control chars + the `[agent:from …]`
// delivery label so the sender's own phone view renders clean.

const fs = require('fs');

const CODEX_TEXT_BLOCK_TYPES = ['output_text', 'input_text'];

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

function jsonlToMarkdown(jsonlPath, agentType, sessionName) {
  const raw = fs.readFileSync(jsonlPath, 'utf-8');
  const lines = raw.split('\n').filter(l => l.trim());

  const parts = [];
  parts.push(`# ${sessionName} — conversation transcript`);
  parts.push(`*Agent: ${agentType} · Exported: ${new Date().toISOString()}*`);
  parts.push(`*Source: \`${jsonlPath}\`*`);
  parts.push('---');

  let lastRole = null;

  for (const line of lines) {
    let obj;
    try { obj = JSON.parse(line); } catch { continue; }
    const type = obj.type || '';

    // --- Claude format ---
    if (type === 'user') {
      const content = (obj.message || {}).content;
      const text = typeof content === 'string' ? content : extractClaudeBlocks(content);
      if (text && text.trim()) {
        if (lastRole !== 'user') parts.push('\n## 👤 User\n');
        parts.push(text.trim());
        lastRole = 'user';
      }
    } else if (type === 'assistant') {
      const content = (obj.message || {}).content;
      const text = extractClaudeBlocks(content);
      if (text && text.trim()) {
        if (lastRole !== 'assistant') parts.push('\n## 🤖 Assistant\n');
        parts.push(text.trim());
        lastRole = 'assistant';
      }
    }
    // --- Codex format ---
    else if (type === 'event_msg') {
      const payload = obj.payload || {};
      if (payload.type === 'agent_message' && payload.message) {
        if (lastRole !== 'assistant') parts.push('\n## 🤖 Assistant\n');
        parts.push(String(payload.message).trim());
        lastRole = 'assistant';
      } else if (payload.type === 'user_message' && payload.message) {
        if (lastRole !== 'user') parts.push('\n## 👤 User\n');
        parts.push(String(payload.message).trim());
        lastRole = 'user';
      }
    } else {
      const msg = codexResponseMessage(obj);
      if (msg && msg.text.trim()) {
        if (lastRole !== msg.role) parts.push(msg.role === 'assistant' ? '\n## 🤖 Assistant\n' : '\n## 👤 User\n');
        parts.push(msg.text.trim());
        lastRole = msg.role;
      }
    }
  }

  return parts.join('\n') + '\n';
}

function extractClaudeBlocks(content) {
  if (!Array.isArray(content)) return typeof content === 'string' ? content : '';
  const out = [];
  for (const block of content) {
    if (!block) continue;
    if (block.type === 'text' && block.text) {
      out.push(block.text);
    } else if (block.type === 'tool_use') {
      out.push(`\n\n> 🔧 *Used tool: \`${block.name}\`*`);
    } else if (block.type === 'tool_result') {
      const txt = typeof block.content === 'string'
        ? block.content
        : Array.isArray(block.content)
          ? block.content.filter(c => c?.type === 'text').map(c => c.text).join('\n')
          : '';
      if (txt.trim()) {
        const truncated = txt.length > 500 ? txt.slice(0, 500) + '\n…[truncated]' : txt;
        out.push(`\n\n> 📥 *Tool result:*\n> \`\`\`\n> ${truncated.split('\n').join('\n> ')}\n> \`\`\``);
      }
    }
  }
  return out.join('\n');
}

// Transcript → chat messages for the remote (phone) view: user/assistant text
// only, no tool traffic. Reads the on-disk JSONL, which is written by the CLI
// regardless of which observation path (wire vs JsonlWatcher) is live — so the
// remote view never depends on the intent machinery.
function jsonlToMessages(jsonlPath, limit = 100) {
  const raw = fs.readFileSync(jsonlPath, 'utf-8');
  const records = [];

  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let obj;
    try { obj = JSON.parse(line); } catch { continue; }
    if (obj.isSidechain || obj.isMeta) continue;
    const type = obj.type || '';
    let role = null, text = '';

    if (type === 'user') {
      const content = (obj.message || {}).content;
      role = 'user';
      if (typeof content === 'string') text = content;
      else if (Array.isArray(content)) {
        // text blocks only — a tool_result-carrying user entry is tool
        // traffic, not something the operator typed
        text = content.filter(b => b && b.type === 'text' && b.text).map(b => b.text).join('\n');
      }
      // local slash-command echoes and injected context aren't conversation
      text = text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim();
      if (text.startsWith('<command-name>') || text.startsWith('<local-command-stdout>')) text = '';
      // panel/phone sends carry the delivery label; the phone view is the
      // sender's own chat, so render them clean (peer labels stay visible).
      // Injected input can be recorded with the leading Ctrl-U (\x15) that
      // _injectText uses to clear the line — drop control chars first.
      text = text.replace(/^[\x00-\x1f]+/, '').replace(/^\[agent:from user\]\s*/, '');
    } else if (type === 'assistant') {
      role = 'assistant';
      const content = (obj.message || {}).content;
      if (Array.isArray(content)) {
        text = content.filter(b => b && b.type === 'text' && b.text).map(b => b.text).join('\n');
      }
    } else if (type === 'event_msg') {
      const payload = obj.payload || {};
      if (payload.type === 'agent_message' && payload.message) { role = 'assistant'; text = String(payload.message); }
      else if (payload.type === 'user_message' && payload.message) { role = 'user'; text = String(payload.message); }
    } else {
      const msg = codexResponseMessage(obj);
      if (msg) { role = msg.role; text = msg.text; }
    }

    const turnEnd = isTurnEndEntry(obj);
    if (!role || !text.trim()) {
      if (turnEnd) records.push({ role: null, text: '', ts: null, turnEnd: true });
      continue;
    }
    records.push({ role, text: text.trim(), ts: obj.timestamp || null, turnEnd });
  }

  const turns = [];
  let turn = [];
  for (const r of records) {
    if (r.role === 'user' && turn.length) { turns.push(turn); turn = []; }
    turn.push(r);
  }
  if (turn.length) turns.push(turn);

  const messages = [];
  for (let t = 0; t < turns.length; t++) {
    const entries = turns[t];
    let lastAssistant = -1;
    for (let i = 0; i < entries.length; i++) if (entries[i].role === 'assistant') lastAssistant = i;
    let tailFinal = t < turns.length - 1;
    if (!tailFinal && lastAssistant >= 0) {
      for (let i = lastAssistant; i < entries.length; i++) if (entries[i].turnEnd) tailFinal = true;
    }
    for (let i = 0; i < entries.length; i++) {
      const r = entries[i];
      if (!r.role) continue;
      const interim = r.role === 'assistant' && !(i === lastAssistant && tailFinal);
      const prev = messages[messages.length - 1];
      if (prev && prev.role === r.role && prev.interim === interim) prev.text += '\n\n' + r.text;
      else messages.push({ role: r.role, text: r.text, ts: r.ts, interim });
    }
  }

  for (let i = 0; i < messages.length; i++) messages[i].seq = i;

  return messages.slice(-limit);
}

let messageCache = null;
function cachedMessages(jsonlPath) {
  const st = fs.statSync(jsonlPath);
  const key = `${jsonlPath}\0${st.size}\0${st.mtimeMs}`;
  if (messageCache && messageCache.key === key) return messageCache.messages;
  const messages = jsonlToMessages(jsonlPath, Infinity);
  messageCache = { key, messages };
  return messages;
}

function sliceSince(all, since, limit) {
  if (since == null) return { messages: all.slice(-limit) };
  const page = all.filter((m) => m.seq >= since).slice(-limit);
  const cursor = page.length ? page[page.length - 1].seq : since - 1;
  return { messages: page, cursor, complete: true };
}

// Does THIS entry end the agent's main-line turn? The discriminator the
// renderer activity seam cannot give you: session-manager passes
// `state === 'idle'` for the jsonl watcher, so its `turnEnd` is true on every
// inter-tool flush. Read the transcript instead, which carries the model's own
// stop reason.
//
// Measured over 60 real transcripts: assistant stop_reason is `tool_use` 1768
// times against `end_turn` 107 — the ratio is the whole point, since speaking
// on the wrong one narrates after every tool call.
//
// A sidechain entry is a SUBAGENT's turn ending, not the seat's, and it lands
// in the same transcript. Excluded here rather than at the call site so no
// second consumer has to rediscover it.
function isTurnEndEntry(obj) {
  if (!obj || obj.isSidechain === true || obj.isMeta === true) return false;
  if ((obj.type || '') === 'assistant') {
    return ((obj.message || {}).stop_reason || '') === 'end_turn';
  }
  // Codex closes a turn with its own event; `agent_message` is per-chunk and
  // says nothing about the turn being over.
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
  // Claude format
  if (type === 'assistant') {
    const content = (obj.message || {}).content || [];
    if (!Array.isArray(content)) return '';
    return content
      .filter(b => b && b.type === 'text' && b.text)
      .map(b => b.text)
      .join('\n');
  }
  // Codex format
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

module.exports = { jsonlToMarkdown, extractClaudeBlocks, jsonlToMessages, cachedMessages, sliceSince, extractText, isTurnEndEntry, isInterruptEntry, isCodexReply };
