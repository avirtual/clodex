'use strict';

const os = require('os');

const UUID_TAIL_RE = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;
const APPROVAL_TOOLS = {
  'item/commandExecution/requestApproval': 'commandExecution',
  'item/fileChange/requestApproval': 'fileChange',
};
const APPROVAL_NAMES = { commandExecution: 'Shell command', fileChange: 'File change' };
const DEFAULT_DECISIONS = ['accept', 'decline', 'cancel'];
const TURN_REQUESTS = new Set(['turn/start', 'thread/compact/start']);
const THREAD_REQUESTS = new Set(['thread/start', 'thread/resume']);
const CONTEXT_TEXTS = new Set(['/compact', '/clear']);

function transcriptPathOf(thread, home) {
  const p = typeof thread.path === 'string' ? thread.path : '';
  if (!p) return null;
  return p.startsWith('~/') ? `${home}${p.slice(1)}` : p;
}

function sessionIdOf(thread) {
  const p = typeof thread.path === 'string' ? thread.path : '';
  const base = p.slice(p.lastIndexOf('/') + 1).replace(/\.jsonl$/, '');
  return base && UUID_TAIL_RE.test(base) ? base : (thread.id || null);
}

function choiceOf(decision) {
  if (decision === 'accept') return { id: 'accept', label: 'Allow', kind: 'allow', decision };
  if (decision === 'acceptForSession') return { id: 'acceptForSession', label: 'Allow for this session', kind: 'allow-always', decision };
  if (decision === 'decline') return { id: 'decline', label: 'Deny', kind: 'deny', decision };
  if (decision === 'cancel') return { id: 'cancel', label: 'Deny and stop the turn', kind: 'deny', decision };
  const amendment = decision && typeof decision === 'object' ? decision.acceptWithExecpolicyAmendment : null;
  if (amendment && Array.isArray(amendment.execpolicy_amendment)) {
    return { id: 'accept-always', label: 'Always allow: ' + amendment.execpolicy_amendment.join(' '), kind: 'allow-always', decision };
  }
  return null;
}

function offeredChoices(decisions) {
  const all = decisions.map(choiceOf).filter(Boolean);
  const has = (id) => all.some((c) => c.id === id);
  if (has('cancel') && !has('decline')) all.push(choiceOf('decline'));
  const allows = all.filter((c) => c.kind !== 'deny');
  return [...allows, ...all.filter((c) => c.id === 'decline'), ...all.filter((c) => c.id === 'cancel')];
}

function postureFor({ bypass, readOnly }) {
  if (bypass) return { approvalPolicy: 'never', sandbox: 'danger-full-access' };
  if (readOnly) return { approvalPolicy: 'never', sandbox: 'read-only' };
  return { approvalPolicy: 'untrusted', sandbox: 'workspace-write' };
}

function create({ cwd = null, resumeId = null, fork = false, bypass = false, readOnly = false, model = null, log = null, home = os.homedir() } = {}) {
  let nextId = 1;
  const pending = new Map();
  const approvals = new Map();
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
      if (method === 'thread/resume') {
        warnOnce('error:thread/resume', `thread/resume failed, starting a fresh thread: ${JSON.stringify(obj.error).slice(0, 300)}`);
        return { kind: 'other', send: [threadStart()] };
      }
      if (method === 'thread/start') {
        warnOnce('error:thread/start', `thread/start failed: ${JSON.stringify(obj.error).slice(0, 300)}`);
        return { kind: 'result', durationMs: null, costUsd: null, isError: true };
      }
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
        transcriptPath: transcriptPathOf(thread, home),
      };
    }
    return { kind: 'other' };
  };

  const onServerRequest = (obj) => {
    const toolName = APPROVAL_TOOLS[obj.method];
    if (!toolName) return { kind: 'other' };
    if (bypass) return { kind: 'other', toolName, send: [{ id: obj.id, result: { decision: 'decline' } }] };
    const params = obj.params || {};
    const decisions = Array.isArray(params.availableDecisions) ? params.availableDecisions : DEFAULT_DECISIONS;
    const offered = offeredChoices(decisions);
    const id = String(obj.id);
    approvals.set(id, { wireId: obj.id, decisions: new Map(offered.map((c) => [c.id, c.decision])) });
    return {
      kind: 'permission-request',
      id,
      toolName,
      displayName: APPROVAL_NAMES[toolName],
      description: params.cwd ? 'in ' + params.cwd : null,
      preview: (toolName === 'fileChange' ? params.reason : params.command) || null,
      input: params,
      choices: offered.map(({ id: choiceId, label, kind }) => ({ id: choiceId, label, kind })),
    };
  };

  const encodePermission = (id, choiceId) => {
    const entry = approvals.get(String(id));
    if (!entry || !entry.decisions.has(choiceId)) return null;
    approvals.delete(String(id));
    return { id: entry.wireId, result: { decision: entry.decisions.get(choiceId) } };
  };

  const dropApprovals = (rec) => {
    if (rec.kind === 'result' || rec.kind === 'init') approvals.clear();
    return rec;
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
    if (hasId) return dropApprovals(onResponse(obj));
    if (typeof obj.method === 'string') return dropApprovals(onNotification(obj));
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

  return { open, decode, encodeUser, encodeContext, encodeInterrupt, encodePermission };
}

module.exports = { create };
