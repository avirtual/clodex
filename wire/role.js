'use strict';

// Main-line vs subagent discrimination, ported from proxylab (wirescope):
// writer.py (_classify_role, _genuine_subagent, _billing_is_subagent,
// fingerprint state) + meta.py (_is_title_call, _is_probe_call).
//
// Why this exists: Task-spawned subagents share the PARENT's session_id on
// the wire, so anything keyed by session (intents, identity, telemetry
// rows) must not be driven by subagent turns. Main line = role "parent" or
// "unknown"; consumers filter on that plus sideCall=false.
//
// PORTING LANDMINE (wirescope): the classification is STATEFUL. The
// billing header's cc_is_subagent=true flag can leak onto a parent turn
// together with a recycled x-claude-code-agent-id (wire-confirmed
// 2026-06-14). The backstop is the cc_version CONTENT fingerprint: the CLI
// recomputes it every request from the first user message, so a leaked
// parent turn still carries the parent's fingerprint. RoleClassifier keeps
// the per-session main-line fingerprint; porting the boolean check alone
// reintroduces the leak.

// Roles assigned to Task-spawned subagents. "subagent" is the generic
// bucket for a custom agent whose system prompt matched no known signature
// (the wire carries no custom agent name, only the boolean flag).
const SUBAGENT_ROLES = new Set(['Plan', 'verification', 'general-purpose', 'subagent']);

function isSubagentRole(role) {
  return SUBAGENT_ROLES.has(role);
}

function sysText(obj) {
  const sys = obj.system;
  if (Array.isArray(sys)) {
    return sys.map((b) => (b && typeof b === 'object' ? (b.text || '') : '')).join(' ');
  }
  return typeof sys === 'string' ? sys : '';
}

// Ground-truth subagent flag from the billing header (block 0 of system[]).
// Not trusted alone — see the fingerprint backstop above.
function billingIsSubagent(obj) {
  return sysText(obj).includes('cc_is_subagent=true');
}

const BILLING_FP_RE = /cc_version=([0-9a-f.]+)/;

function billingFingerprint(obj) {
  const m = BILLING_FP_RE.exec(sysText(obj));
  return m ? m[1] : null;
}

// The CLI's per-session title-generator side-call: zero tools + the title
// system prompt. Its response text IS the session title, not a turn.
const TITLE_SYS_PREFIX = 'Generate a concise, sentence-case title';

function isTitleCall(obj) {
  if (Array.isArray(obj.tools) && obj.tools.length) return false;
  const sys = obj.system;
  const texts = Array.isArray(sys)
    ? sys.map((b) => (b && typeof b === 'object' ? (b.text || '') : ''))
    : [typeof sys === 'string' ? sys : ''];
  return texts.some((t) => t.startsWith(TITLE_SYS_PREFIX));
}

// A health/availability probe: bare user message, no system, no tools,
// tiny max_tokens. Shares the session_id but is not an agent turn.
const PROBE_MAX_TOKENS = 16;

function isProbeCall(obj) {
  if ((Array.isArray(obj.tools) && obj.tools.length) || obj.system) return false;
  const mt = obj.max_tokens;
  if (!Number.isInteger(mt) || mt > PROBE_MAX_TOKENS) return false;
  return Array.isArray(obj.messages) && obj.messages.length <= 1;
}

class RoleClassifier {
  constructor() {
    // sessionId → the main line's cc_version content fingerprint. Written
    // ONLY from the durable main-line path (never a side-call or a
    // subagent), so it is the parent's stable first-message fingerprint.
    this._mainFp = new Map();
  }

  // True only for a REAL subagent. Signal (either suffices): the header
  // flag, or a present x-claude-code-agent-id (the only signal carried by
  // proxy/teammate-spawned top-level agents). In both cases the
  // fingerprint backstop must clear it: a leaked parent turn carries the
  // main line's fingerprint and reads NOT-genuine — fail closed onto the
  // main line. Pure read; never mutates the fingerprint map.
  genuineSubagent(obj, sessionId, agentId) {
    if (!billingIsSubagent(obj) && !agentId) return false;
    const mainFp = sessionId ? this._mainFp.get(sessionId) : null;
    const fp = billingFingerprint(obj);
    if (mainFp && fp && fp === mainFp) return false; // leaked parent turn (stale agent-id)
    return true;
  }

  // System-prompt signature first, wire subagent signals as the backstop.
  classify(obj, sessionId, agentId) {
    const s = sysText(obj);
    if (s.includes('software architect and planning')) return 'Plan';
    if (s.includes('verification specialist')) return 'verification';
    if (s.includes('agent for Claude Code') || s.includes('Searching for code')) return 'general-purpose';
    if (this.genuineSubagent(obj, sessionId, agentId)) return 'subagent';
    if (s.includes('Claude Code')) return 'parent';
    return 'unknown';
  }

  // Called only from the main-line path (role parent/unknown, not a
  // side-call) — mirrors proxylab meta._capture_session_meta.
  noteMainFingerprint(sessionId, obj) {
    if (!sessionId) return;
    const fp = billingFingerprint(obj);
    if (fp) this._mainFp.set(sessionId, fp);
  }

  forgetSession(sessionId) {
    this._mainFp.delete(sessionId);
  }
}

module.exports = {
  RoleClassifier, SUBAGENT_ROLES, isSubagentRole,
  sysText, billingIsSubagent, billingFingerprint, isTitleCall, isProbeCall,
};
