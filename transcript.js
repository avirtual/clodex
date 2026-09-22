// Transcript rendering off the CLI's on-disk JSONL. Two renderers: a full
// markdown export (jsonlToMarkdown, tool traffic included) and the chat-message
// list served to both the phone page and the `clodex` CLI
// (jsonlToMessages, user/assistant text only). Both read the JSONL the CLI
// writes regardless of which observation path is live, so the remote view
// never depends on the intent machinery. Role and text per entry come from the
// platform reader in transcript-readers.js, sniffed per record.
// Seam: plain functions over a path/string/object; only Node `fs` for the two
// file readers — no main.js state, no Electron.

const fs = require('fs');
const {
  sniffReader, extractText, isTurnEndEntry, isInterruptEntry, isCodexReply,
} = require('./transcript-readers');

// Panel/phone sends carry the operator delivery label; every consumer of
// jsonlToMessages renders the operator's own chat, so drop it (peer labels like
// [agent:from reviewer] stay visible). Injected input can be recorded with the
// leading Ctrl-U (\x15) that _injectText uses to clear the line — control chars
// go first. Applied to every user text whatever entry shape produced it.
function cleanUserText(text) {
  return text.replace(/^[\x00-\x1f]+/, '').replace(/^\[agent:from user\]\s*/, '');
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
    for (const rec of sniffReader(obj).expand(obj)) {
      const reader = sniffReader(rec);
      const c = reader.classify(rec);
      const full = reader.id === 'claude' ? extractClaudeBlocks((rec.message || {}).content) : '';
      let role = null, text = '';
      if (c.isReply) { role = 'assistant'; text = full || c.text; }
      else if (c.prompt || full) { role = 'user'; text = full || c.prompt; }
      if (!role || !text.trim()) continue;
      if (lastRole !== role) parts.push(role === 'assistant' ? '\n## 🤖 Assistant\n' : '\n## 👤 User\n');
      parts.push(text.trim());
      lastRole = role;
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

// Transcript → chat messages for every transcript reader: user/assistant
// text only, no tool traffic. Reads the on-disk JSONL, which is written by the CLI
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
    for (const rec of sniffReader(obj).expand(obj)) {
      const c = sniffReader(rec).classify(rec);
      let role = null, text = '';
      if (c.isReply) { role = 'assistant'; text = c.text; }
      else if (c.prompt) {
        role = 'user';
        // local slash-command echoes and injected context aren't conversation
        text = c.prompt.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
          .replace(/<task-notification>[\s\S]*?<\/task-notification>/g, '').trim();
        if (text.startsWith('<command-name>') || text.startsWith('<local-command-stdout>')) text = '';
        text = cleanUserText(text);
      }
      if (!role || !text.trim()) {
        if (c.turnEnd) records.push({ role: null, text: '', ts: null, turnEnd: true });
        continue;
      }
      records.push({ role, text: text.trim(), ts: rec.timestamp || null, turnEnd: c.turnEnd });
    }
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

function turnStart(all) {
  for (let i = all.length - 1; i >= 0; i--) if (all[i].role === 'user') return all[i].seq;
  return 0;
}

function keepAfter(m, floor) {
  if (m.ts == null) return true;
  const t = Date.parse(m.ts);
  return !Number.isFinite(t) || t >= floor;
}

function sliceSince(all, since, limit, after = null) {
  const cursor = turnStart(all);
  let rows = since == null ? all : all.filter((m) => m.seq >= since);
  const floor = after == null ? NaN : Date.parse(after);
  if (Number.isFinite(floor)) rows = rows.filter((m) => keepAfter(m, floor));
  const page = rows.slice(-limit);
  return { messages: page, cursor, complete: true };
}

module.exports = { jsonlToMarkdown, extractClaudeBlocks, jsonlToMessages, cachedMessages, sliceSince, extractText, isTurnEndEntry, isInterruptEntry, isCodexReply };
