'use strict';

const SINK_MESSAGE_ID = 'msg_clodex_voice_sink';

function sinkMessage(model) {
  return {
    id: SINK_MESSAGE_ID,
    type: 'message',
    role: 'assistant',
    model: typeof model === 'string' && model ? model : 'voice-sink',
    content: [{ type: 'text', text: '' }],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: 0, output_tokens: 0 },
  };
}

function sseFrame(type, data) {
  return `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
}

function sinkStream(model) {
  const msg = sinkMessage(model);
  return [
    sseFrame('message_start', { message: { ...msg, content: [], stop_reason: null } }),
    sseFrame('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }),
    sseFrame('content_block_stop', { index: 0 }),
    sseFrame('message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 0 } }),
    sseFrame('message_stop', {}),
  ].join('');
}

function parseBody(body) {
  if (!body || !body.length) return null;
  try {
    const obj = JSON.parse(body.toString('utf8'));
    return obj && typeof obj === 'object' ? obj : null;
  } catch { return null; }
}

function answerVoiceSink(res, { method, upstreamPath, body }) {
  const p = String(upstreamPath || '').replace(/\/+$/, '');
  const obj = parseBody(body);
  if (method === 'POST' && p.endsWith('/v1/messages/count_tokens')) {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ input_tokens: 0 }));
  }
  if (method === 'POST' && p.endsWith('/v1/messages')) {
    const model = obj && obj.model;
    if (obj && obj.stream === true) {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      return res.end(sinkStream(model));
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify(sinkMessage(model)));
  }
  res.writeHead(200, { 'content-type': 'application/json' });
  return res.end('{}');
}

module.exports = { answerVoiceSink, sinkMessage, sinkStream, SINK_MESSAGE_ID };
