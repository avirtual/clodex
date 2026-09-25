'use strict';

const PATH_TOOLS = new Set(['Write', 'Edit', 'NotebookEdit', 'Read']);
const DENY_MESSAGE = 'Denied by the operator in Clodex.';

function previewOf(toolName, input, description) {
  const i = input && typeof input === 'object' ? input : {};
  if (toolName === 'Bash' && typeof i.command === 'string') return i.command;
  if (PATH_TOOLS.has(toolName) && typeof i.file_path === 'string') return i.file_path;
  if (toolName === 'WebFetch' && typeof i.url === 'string') return i.url;
  return description;
}

function alwaysLabel(suggestion) {
  const s = suggestion || {};
  if (s.type === 'setMode' && s.mode === 'acceptEdits') return 'Accept edits for this session';
  if (s.type === 'addRules' && Array.isArray(s.rules) && s.rules.length) {
    return 'Always allow ' + s.rules.map((r) => r.toolName + (r.ruleContent ? '(' + r.ruleContent + ')' : '')).join(', ');
  }
  return 'Always allow';
}

function decodePermission(obj) {
  const req = obj.request;
  const toolName = req.tool_name || null;
  const input = req.input || null;
  const description = req.description || null;
  const suggestions = Array.isArray(req.permission_suggestions) ? req.permission_suggestions : [];
  const choices = [{ id: 'allow', label: 'Allow', kind: 'allow' }];
  if (suggestions.length) choices.push({ id: 'allow-always', label: alwaysLabel(suggestions[0]), kind: 'allow-always' });
  choices.push({ id: 'deny', label: 'Deny', kind: 'deny' });
  return {
    kind: 'permission-request',
    id: obj.request_id,
    toolName,
    displayName: req.display_name || toolName,
    description,
    preview: previewOf(toolName, input, description),
    input,
    choices,
  };
}

function decode(obj) {
  if (!obj || typeof obj !== 'object') return { kind: 'other' };
  if (obj.type === 'result') {
    return {
      kind: 'result',
      durationMs: typeof obj.duration_ms === 'number' ? obj.duration_ms : null,
      costUsd: typeof obj.total_cost_usd === 'number' ? obj.total_cost_usd : null,
      isError: obj.is_error === true,
    };
  }
  if (obj.type === 'conversation_reset') {
    return { kind: 'reset', newConversationId: obj.new_conversation_id || null };
  }
  if (obj.type === 'control_request') {
    return obj.request && obj.request.subtype === 'can_use_tool' && obj.request_id ? decodePermission(obj) : { kind: 'other' };
  }
  if (obj.type !== 'system') return { kind: 'other' };
  switch (obj.subtype) {
    case 'init':
      return {
        kind: 'init',
        sessionId: obj.session_id || null,
        model: obj.model || null,
        slashCommands: Array.isArray(obj.slash_commands) ? obj.slash_commands : [],
      };
    case 'compact_boundary': {
      const meta = obj.compact_metadata || {};
      return {
        kind: 'compact',
        pre: typeof meta.pre_tokens === 'number' ? meta.pre_tokens : null,
        post: typeof meta.post_tokens === 'number' ? meta.post_tokens : null,
      };
    }
    case 'status':
      return { kind: 'status', status: obj.status === undefined ? null : obj.status };
    case 'permission_denied':
      return { kind: 'permission-denied', toolName: obj.tool_name || null };
    default:
      return { kind: 'other' };
  }
}

function encodeUser(text, images = []) {
  if (!images || !images.length) return { type: 'user', message: { role: 'user', content: String(text) } };
  const content = images.map((img) => ({ type: 'image', source: { type: 'base64', media_type: img.mediaType, data: img.data } }));
  const body = text == null ? '' : String(text);
  if (body.trim()) content.push({ type: 'text', text: body });
  return { type: 'user', message: { role: 'user', content } };
}

function create() {
  const pending = new Map();

  const decodeTracked = (obj) => {
    const rec = decode(obj);
    if (rec.kind === 'permission-request') {
      pending.set(rec.id, { input: rec.input, suggestions: Array.isArray(obj.request.permission_suggestions) ? obj.request.permission_suggestions : [] });
    } else if (rec.kind === 'result' || rec.kind === 'init') {
      pending.clear();
    }
    return rec;
  };

  const encodePermission = (id, choiceId) => {
    const entry = pending.get(id);
    if (!entry) return null;
    let response;
    if (choiceId === 'deny') response = { behavior: 'deny', message: DENY_MESSAGE };
    else if (choiceId === 'allow') response = { behavior: 'allow', updatedInput: entry.input };
    else if (choiceId === 'allow-always' && entry.suggestions.length) {
      response = { behavior: 'allow', updatedInput: entry.input, updatedPermissions: entry.suggestions };
    } else return null;
    pending.delete(id);
    return { type: 'control_response', response: { subtype: 'success', request_id: id, response } };
  };

  return { decode: decodeTracked, encodeUser, encodePermission };
}

module.exports = { create, decode, encodeUser };
