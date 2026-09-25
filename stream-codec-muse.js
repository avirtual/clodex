'use strict';

const os = require('os');
const crypto = require('crypto');

const TURN_ERRORS = new Set(['session/start', 'turn/start', 'session/compact']);
const SESSION_REQUESTS = new Set(['session/start', 'session/resume']);
const CONTEXT_TEXTS = new Set(['/compact', '/clear']);
const APPROVAL_ALREADY_RESOLVED = -32051;

function uuidv7(now = Date.now(), bytes = crypto.randomBytes(16)) {
  const b = Buffer.from(bytes);
  let ms = BigInt(now);
  for (let i = 5; i >= 0; i -= 1) {
    b[i] = Number(ms & 0xffn);
    ms >>= 8n;
  }
  b[6] = (b[6] & 0x0f) | 0x70;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = b.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

function approvalModeFor({ bypass, readOnly }) {
  if (bypass) return 'allowAll';
  if (readOnly) return 'denyUnmatched';
  return 'promptUnmatched';
}

function inputOf(rawArgs) {
  try {
    const parsed = JSON.parse(rawArgs);
    if (parsed && typeof parsed === 'object') return parsed;
  } catch {}
  return { rawArgs };
}

function choiceKind(choice) {
  if (choice.decision === 'abort') return 'deny';
  return choice.scope === 'once' ? 'allow' : 'allow-always';
}

function transcriptPathOf(session, home) {
  const p = typeof session.path === 'string' ? session.path : '';
  if (!p) return null;
  return p.startsWith('~/') ? `${home}${p.slice(1)}` : p;
}

function create({ cwd = null, resumeId = null, fork = false, bypass = false, readOnly = false, model = null, log = null, home = os.homedir() } = {}) {
  let nextId = 1;
  const pending = new Map();
  const approvals = new Map();
  let sessionId = null;
  let turnId = null;
  const warned = new Set();
  const approvalMode = approvalModeFor({ bypass, readOnly });

  const warnOnce = (key, msg) => {
    if (warned.has(key)) return;
    warned.add(key);
    try { if (log && log.warn) log.warn('stream-codec-muse', msg); } catch {}
  };

  const request = (method, params) => {
    const id = nextId;
    nextId += 1;
    pending.set(id, method);
    return { jsonrpc: '2.0', id, method, params };
  };

  const command = (method, params) => request(method, { commandId: uuidv7(), ...params });

  const sessionStart = () => command('session/start', {
    ...(cwd ? { workspaceRoot: cwd } : {}),
    ...(model ? { modelId: model } : {}),
    approvalMode,
  });

  const open = () => {
    const out = [
      request('initialize', { clientInfo: { name: 'clodex', title: 'clodex', version: '0' }, capabilities: { userInputDialogs: false } }),
      { jsonrpc: '2.0', method: 'initialized' },
    ];
    if (resumeId) {
      if (fork) warnOnce('fork', `muse has no fork: resuming session ${resumeId} instead`);
      out.push(command('session/resume', { sessionId: String(resumeId), history: 'auto' }));
    } else {
      out.push(sessionStart());
    }
    return out;
  };

  const errorResult = () => ({ kind: 'result', durationMs: null, costUsd: null, isError: true });

  const onResponse = (obj) => {
    const method = pending.get(obj.id);
    pending.delete(obj.id);
    if (obj.error !== undefined) {
      const detail = JSON.stringify(obj.error).slice(0, 300);
      if (method === 'approval/decide' && obj.error && obj.error.code === APPROVAL_ALREADY_RESOLVED) return { kind: 'other' };
      if (method === 'session/resume') {
        warnOnce('error:session/resume', `session/resume failed, starting a fresh session: ${detail}`);
        return { kind: 'other', send: [sessionStart()] };
      }
      warnOnce(`error:${method}`, `${method || `request ${obj.id}`} failed: ${detail}`);
      return TURN_ERRORS.has(method) ? errorResult() : { kind: 'other' };
    }
    const result = obj.result || {};
    if (SESSION_REQUESTS.has(method)) {
      const session = result.session || {};
      sessionId = session.sessionId || null;
      turnId = null;
      return {
        kind: 'init',
        sessionId,
        model: session.modelId || null,
        slashCommands: [],
        turnEnd: true,
        transcriptPath: transcriptPathOf(session, home),
      };
    }
    if (method === 'turn/start') {
      turnId = result.turnId || null;
      return { kind: 'status', status: 'running' };
    }
    return { kind: 'other' };
  };

  const onNotification = (obj) => {
    const params = obj.params || {};
    switch (obj.method) {
      case 'turn/completed':
        if (!sessionId) return { kind: 'other' };
        if (!params.turnId || params.turnId === turnId) turnId = null;
        return { kind: 'result', durationMs: null, costUsd: null, isError: params.terminal === 'failed' };
      case 'item/completed': {
        const item = params.item || {};
        if (item.kind !== 'compaction' || !sessionId) return { kind: 'other' };
        return {
          kind: 'compact',
          pre: typeof item.tokensBefore === 'number' ? item.tokensBefore : null,
          post: typeof item.tokensAfter === 'number' ? item.tokensAfter : null,
          turnEnd: !turnId,
        };
      }
      case 'approval/requested': {
        if (bypass) {
          return {
            kind: 'other',
            toolName: params.toolName || null,
            send: [command('approval/decide', {
              sessionId: params.sessionId || sessionId,
              approvalId: params.approvalId,
              choiceId: 'abort',
              requirementId: params.currentRequirementId,
            })],
          };
        }
        const subject = params.subject || null;
        const choices = (Array.isArray(params.availableChoices) ? params.availableChoices : [])
          .filter((c) => c && typeof c.choiceId === 'string')
          .map((c) => ({ id: c.choiceId, label: c.label, kind: choiceKind(c) }));
        approvals.set(params.approvalId, {
          sessionId: params.sessionId || sessionId,
          requirementId: params.currentRequirementId,
          choiceIds: new Set(choices.map((c) => c.id)),
        });
        return {
          kind: 'permission-request',
          id: params.approvalId,
          toolName: params.toolName,
          displayName: params.toolName,
          description: subject && subject.workspaceRoot ? 'in ' + subject.workspaceRoot : null,
          preview: (subject && subject.command) || null,
          input: inputOf(params.rawArgs),
          choices,
        };
      }
      default:
        return { kind: 'other' };
    }
  };

  const dropApprovals = (rec) => {
    if (rec.kind === 'result' || rec.kind === 'init') approvals.clear();
    return rec;
  };

  const decode = (obj) => {
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return { kind: 'other' };
    const hasId = obj.id !== undefined && obj.id !== null;
    if (hasId && typeof obj.method === 'string') return { kind: 'other' };
    if (hasId) return dropApprovals(onResponse(obj));
    if (typeof obj.method === 'string') return dropApprovals(onNotification(obj));
    return { kind: 'other' };
  };

  const encodePermission = (id, choiceId) => {
    const entry = approvals.get(id);
    if (!entry || !entry.choiceIds.has(choiceId)) return null;
    approvals.delete(id);
    return command('approval/decide', { sessionId: entry.sessionId, approvalId: id, choiceId, requirementId: entry.requirementId });
  };

  const encodeUser = (text, images = []) => {
    const body = text == null ? '' : String(text);
    if (CONTEXT_TEXTS.has(body.trim())) {
      warnOnce('context-text', `dropped "${body.trim()}": slash commands as text are billed model turns on muse serve, not commands`);
      return null;
    }
    const parts = (Array.isArray(images) ? images : [])
      .filter((img) => img && img.data && img.mediaType)
      .map((img) => ({ type: 'image', mediaType: img.mediaType, base64Data: img.data }));
    if (body.trim()) parts.push({ type: 'text', text: body });
    if (!parts.length) return null;
    return command('turn/start', { sessionId, input: parts });
  };

  const encodeContext = (sub) => {
    if (sub === 'compact') return sessionId ? command('session/compact', { sessionId }) : null;
    if (sub === 'clear') return sessionStart();
    return null;
  };

  const encodeInterrupt = () => {
    if (!sessionId || !turnId) return null;
    return command('turn/interrupt', { sessionId, turnId });
  };

  return { open, decode, encodeUser, encodeContext, encodeInterrupt, encodePermission };
}

module.exports = { create, uuidv7 };
