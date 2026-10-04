'use strict';

const REASON_LABEL = { login: 'sign-in', otp: 'sign-in', captcha: 'sign-in', idp: 'sign-in', takeover: 'takeover' };

function initial() {
  return { state: 'closed', reason: null, seat: null, what: null, takeover: false, suppress: false };
}

function released(s, state, reason = null) {
  return { ...s, state, reason, seat: null, what: null, takeover: false };
}

function reduce(s, ev) {
  const t = ev && ev.type;
  if (t === 'closed') return initial();
  if (t === 'navigate') return s.suppress ? { ...s, suppress: false } : s;
  switch (s.state) {
    case 'closed':
      return t === 'open' ? { ...s, state: 'idle' } : s;
    case 'idle':
      if (t === 'gate') return { ...s, state: 'gating', seat: ev.seat || null, what: ev.what || null };
      if (t === 'takeover') return released(s, 'held', 'takeover');
      if (t === 'signin' && ev.reason && (ev.force || !s.suppress)) return released(s, 'held', ev.reason);
      return s;
    case 'gating':
      if (t === 'quiet') return { ...s, state: 'driving' };
      if (t === 'busy' || t === 'done') return released(s, 'idle');
      if (t === 'takeover') return released(s, 'held', 'takeover');
      return s;
    case 'driving':
      if (t === 'describe') return { ...s, what: ev.what || s.what };
      if (t === 'takeover') return { ...s, takeover: true };
      if (t === 'done') {
        if (s.takeover) return released(s, 'held', 'takeover');
        if (ev.signin && (ev.force || !s.suppress)) return released(s, 'held', ev.signin);
        return released(s, 'idle');
      }
      return s;
    case 'held':
      if (t === 'handback') return { ...released(s, 'idle'), suppress: true };
      return s;
    default:
      return s;
  }
}

function barView(s, { service = '', url = '' } = {}) {
  const base = { service, url, state: s.state, tone: 'grey', text: '', takeover: false, handback: false };
  if (s.state === 'closed') return { ...base, text: 'closed' };
  if (s.state === 'idle') return { ...base, text: 'Idle — agents act only after you pause for 3s', takeover: true };
  if (s.state === 'gating') {
    return { ...base, tone: 'wait', text: `Agent waiting for you to pause — ${s.seat} wants to ${s.what}`, takeover: true };
  }
  if (s.state === 'driving') {
    if (s.takeover) {
      return { ...base, tone: 'amber', text: `Take over requested — you get control when ${s.seat}: ${s.what} finishes` };
    }
    return {
      ...base, tone: 'amber', takeover: true,
      text: `● Agent driving — ${s.seat}: ${s.what} — your clicks and keys are ignored until it finishes`,
    };
  }
  const label = REASON_LABEL[s.reason] || 'sign-in';
  return { ...base, tone: 'blue', handback: true, text: `You have control (${label}) — Hand back to agent ▸` };
}

module.exports = { initial, reduce, barView };
