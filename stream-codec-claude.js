'use strict';

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
  if (body) content.push({ type: 'text', text: body });
  return { type: 'user', message: { role: 'user', content } };
}

module.exports = { decode, encodeUser };
