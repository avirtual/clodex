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
  const messages = [];

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
    }

    if (!role || !text.trim()) continue;
    const prev = messages[messages.length - 1];
    // Consecutive same-role entries (multi-block turns interleaved with tool
    // calls) render as one bubble
    if (prev && prev.role === role) prev.text += '\n\n' + text.trim();
    else messages.push({ role, text: text.trim(), ts: obj.timestamp || null });
  }

  return messages.slice(-limit);
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
  return '';
}

module.exports = { jsonlToMarkdown, extractClaudeBlocks, jsonlToMessages, extractText };
