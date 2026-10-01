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
        terminalSlashCommands: Array.isArray(obj.terminal_slash_commands) ? obj.terminal_slash_commands : [],
        pluginErrors: Array.isArray(obj.plugin_errors) ? obj.plugin_errors.filter((e) => e && typeof e === 'object').map((e) => ({
          plugin: typeof e.plugin === 'string' ? e.plugin : null,
          type: typeof e.type === 'string' ? e.type : null,
          message: typeof e.message === 'string' ? e.message : '',
          path: typeof e.path === 'string' ? e.path : null,
        })) : [],
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
  const outbound = new Set();
  let interrupts = 0;
  let setModels = 0;

  const decodeTracked = (obj) => {
    const ack = obj && obj.type === 'control_response' && obj.response;
    if (ack && outbound.delete(ack.request_id)) {
      return { kind: 'control-ack', id: ack.request_id, ok: ack.subtype === 'success', error: ack.error || null, errorCode: ack.error_code || null };
    }
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

  const encodeInterrupt = () => ({ type: 'control_request', request_id: `clodex-interrupt-${++interrupts}`, request: { subtype: 'interrupt' } });

  const encodeSetModel = (model) => {
    const id = `clodex-set-model-${++setModels}`;
    outbound.add(id);
    return { type: 'control_request', request_id: id, request: { subtype: 'set_model', model } };
  };

  return { decode: decodeTracked, encodeUser, encodePermission, encodeInterrupt, encodeSetModel };
}

module.exports = { create, decode, encodeUser };
