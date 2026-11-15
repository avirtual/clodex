'use strict';

const RUNNER_HANDS_OPTIONS = ['off', 'full', 'all'];
const RUNNER_GATE_OPTIONS = ['off', 'shadow'];
const RUNNER_ACTS = { 'set-runner-peer': 'peer', 'set-runner-hands': 'hands', 'set-runner-gate': 'gate' };
const RUNNER_FIELDS = { 'runner-peer': 'set-runner-peer', 'runner-hands': 'set-runner-hands', 'runner-gate': 'set-runner-gate' };

function runnerStateLine(info) {
  if (!info) return 'The test runner cannot be read here.';
  if (!info.peer) {
    return info.invalid
      ? 'invalid: the testRunner in team.json is invalid and ignored — fix it there, or remove it to set a peer here'
      : 'none: hand and gate suites run on this machine';
  }
  const tally = info.tally ? `; shadow comparisons: ${info.tally.agree} agree, ${info.tally.disagree} disagree` : '';
  const wire = info.wire === 'pull' ? 'dials in (wire pull, shadow only): ' : '';
  return `${wire}${info.reach == null ? 'checking reachability…' : info.reach}${tally}`;
}

function runnerPatchFor(act, value) {
  const key = RUNNER_ACTS[act];
  if (!key) return null;
  const v = typeof value === 'string' ? value.trim() : '';
  return { [key]: v };
}

function buildSelect(document, field, options, value, disabled) {
  const sel = document.createElement('select');
  sel.dataset.f = field;
  for (const o of options) {
    const opt = document.createElement('option');
    opt.value = o;
    opt.textContent = o;
    sel.appendChild(opt);
  }
  sel.value = options.includes(value) ? value : 'off';
  sel.disabled = disabled;
  return sel;
}

function buildButton(document, act, text, disabled) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.dataset.act = act;
  btn.textContent = text;
  btn.disabled = disabled;
  return btn;
}

function buildRunnerField(document, info) {
  const wrap = document.createElement('div');
  wrap.className = 'team-runner';
  const noPeer = !(info && info.peer);
  const unreadable = !info;

  const field = document.createElement('label');
  field.className = 'team-role-field';
  const label = document.createElement('span');
  label.textContent = 'test runner';
  const input = document.createElement('input');
  input.type = 'text';
  input.dataset.f = 'runner-peer';
  input.placeholder = 'none (peer name)';
  input.value = (info && info.peer) || '';
  input.disabled = unreadable;
  field.appendChild(label);
  field.appendChild(input);
  wrap.appendChild(field);

  const modes = document.createElement('div');
  modes.className = 'team-role-actions';
  modes.appendChild(buildButton(document, 'set-runner-peer', 'Set runner', unreadable));
  const handsLabel = document.createElement('span');
  handsLabel.textContent = 'hands';
  modes.appendChild(handsLabel);
  modes.appendChild(buildSelect(document, 'runner-hands', RUNNER_HANDS_OPTIONS, info && info.hands, noPeer));
  modes.appendChild(buildButton(document, 'set-runner-hands', 'Set hands', noPeer));
  const gateLabel = document.createElement('span');
  gateLabel.textContent = 'gate';
  modes.appendChild(gateLabel);
  modes.appendChild(buildSelect(document, 'runner-gate', RUNNER_GATE_OPTIONS, info && info.gate, noPeer));
  modes.appendChild(buildButton(document, 'set-runner-gate', 'Set gate', noPeer));
  wrap.appendChild(modes);

  const state = document.createElement('div');
  state.className = 'team-lead-hint';
  state.dataset.runner = info && info.invalid ? 'invalid' : 'state';
  state.textContent = runnerStateLine(info);
  wrap.appendChild(state);

  if (info && (info.setup || info.env)) {
    const fixed = document.createElement('div');
    fixed.className = 'team-lead-hint';
    fixed.dataset.runner = 'manifest-only';
    fixed.textContent = `${[info.setup ? 'setup' : null, info.env ? 'env' : null].filter(Boolean).join(' and ')} set in team.json — edit them there`;
    wrap.appendChild(fixed);
  }
  return wrap;
}

function paintRunnerState(wrap, info) {
  const state = wrap && Array.from(wrap.childNodes).find((n) => n.dataset && n.dataset.runner === 'state');
  if (state) state.textContent = runnerStateLine(info);
}

module.exports = { RUNNER_HANDS_OPTIONS, RUNNER_GATE_OPTIONS, RUNNER_FIELDS, runnerStateLine, runnerPatchFor, buildRunnerField, paintRunnerState };
