'use strict';

const UUID_TAIL_RE = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;
const APPROVAL_TOOLS = {
  'item/commandExecution/requestApproval': 'commandExecution',
  'item/fileChange/requestApproval': 'fileChange',
};
const TURN_REQUESTS = new Set(['turn/start', 'thread/compact/start']);
const THREAD_REQUESTS = new Set(['thread/start', 'thread/resume']);
const CONTEXT_TEXTS = new Set(['/compact', '/clear']);

function sessionIdOf(thread) {
  const p = typeof thread.path === 'string' ? thread.path : '';
  const base = p.slice(p.lastIndexOf('/') + 1).replace(/\.jsonl$/, '');
  return base && UUID_TAIL_RE.test(base) ? base : (thread.id || null);
}

function postureFor({ bypass, readOnly }) {
  if (bypass) return { approvalPolicy: 'never', sandbox: 'danger-full-access' };
  if (readOnly) return { approvalPolicy: 'never', sandbox: 'read-only' };
  return { approvalPolicy: 'untrusted', sandbox: 'workspace-write' };
}

function create({ cwd = null, resumeId = null, fork = false, bypass = false, readOnly = false, model = null, log = null } = {}) {
  let nextId = 1;
  const pending = new Map();
  let threadId = null;
  let turnId = null;
  const warned = new Set();
  const posture = postureFor({ bypass, readOnly });

  const warnOnce = (key, msg) => {
    if (warned.has(key)) return;
    warned.add(key);
    try { if (log && log.warn) log.warn('stream-codec-codex', msg); } catch {}
  };

  const request = (method, params) => {
    const id = nextId;
    nextId += 1;
    pending.set(id, method);
    return { id, method, params };
  };

  const threadStart = () => request('thread/start', { ...(cwd ? { cwd } : {}), ...posture });

  const open = () => {
    const out = [
      request('initialize', { clientInfo: { name: 'clodex', title: null, version: '0' }, capabilities: { experimentalApi: true } }),
      { method: 'initialized' },
    ];
    if (resumeId) {
      if (fork) warnOnce('fork', `codex stream seats cannot fork: resuming ${resumeId} instead`);
      const m = String(resumeId).match(UUID_TAIL_RE);
      out.push(request('thread/resume', { threadId: m ? m[1] : String(resumeId), ...(cwd ? { cwd } : {}), ...posture }));
    } else {
      out.push(threadStart());
    }
    return out;
  };

  const onResponse = (obj) => {
    const method = pending.get(obj.id);
    pending.delete(obj.id);
    if (obj.error !== undefined) {
      if (TURN_REQUESTS.has(method)) return { kind: 'result', durationMs: null, costUsd: null, isError: true };
      warnOnce(`error:${method}`, `${method || `request ${obj.id}`} failed: ${JSON.stringify(obj.error).slice(0, 300)}`);
      return { kind: 'other' };
    }
    if (THREAD_REQUESTS.has(method)) {
      const result = obj.result || {};
      const thread = result.thread || {};
      threadId = thread.id || null;
      turnId = null;
      return {
        kind: 'init',
        sessionId: sessionIdOf(thread),
        model: result.model || thread.model || null,
        slashCommands: [],
        turnEnd: true,
      };
    }
    return { kind: 'other' };
  };

  const onServerRequest = (obj) => {
    const toolName = APPROVAL_TOOLS[obj.method];
    if (!toolName) return { kind: 'other' };
    return {
      kind: bypass ? 'other' : 'permission-denied',
      toolName,
      send: [{ id: obj.id, result: { decision: 'decline' } }],
    };
  };

  const onNotification = (obj) => {
    const params = obj.params || {};
    switch (obj.method) {
      case 'turn/started':
        turnId = (params.turn && params.turn.id) || null;
        return { kind: 'status', status: 'running' };
      case 'turn/completed': {
        const status = params.turn ? params.turn.status : null;
        turnId = null;
        return { kind: 'result', durationMs: null, costUsd: null, isError: status === 'failed' };
      }
      case 'item/completed': {
        const item = params.item || {};
        if (item.type !== 'contextCompaction') return { kind: 'other' };
        return {
          kind: 'compact',
          pre: typeof item.preTokens === 'number' ? item.preTokens : null,
          post: typeof item.postTokens === 'number' ? item.postTokens : null,
        };
      }
      default:
        return { kind: 'other' };
    }
  };

  const decode = (obj) => {
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return { kind: 'other' };
    const hasId = obj.id !== undefined && obj.id !== null;
    if (hasId && typeof obj.method === 'string') return onServerRequest(obj);
    if (hasId) return onResponse(obj);
    if (typeof obj.method === 'string') return onNotification(obj);
    return { kind: 'other' };
  };

  const encodeUser = (text, images = []) => {
    const body = text == null ? '' : String(text);
    if (CONTEXT_TEXTS.has(body.trim())) {
      warnOnce('context-text', `dropped "${body.trim()}": slash commands as text are billed model turns on codex app-server, not commands`);
      return null;
    }
    if (Array.isArray(images) && images.length) warnOnce('images', `dropped ${images.length} image(s): codex stream seats send text only`);
    if (!body.trim()) return null;
    return request('turn/start', {
      threadId,
      input: [{ type: 'text', text: body, text_elements: [] }],
      ...(model ? { model } : {}),
    });
  };

  const encodeContext = (sub) => {
    if (sub === 'compact') return threadId ? request('thread/compact/start', { threadId }) : null;
    if (sub === 'clear') return threadStart();
    return null;
  };

  const encodeInterrupt = () => {
    if (!threadId || !turnId) return null;
    return request('turn/interrupt', { threadId, turnId });
  };

  return { open, decode, encodeUser, encodeContext, encodeInterrupt };
}

module.exports = { create, postureFor };
