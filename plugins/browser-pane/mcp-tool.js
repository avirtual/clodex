'use strict';

const subagent = require('./subagent');

const { NAME_PATTERN } = require('./grammar');

const SERVICE_PATTERN = NAME_PATTERN;
const SERVICE_RE = new RegExp(SERVICE_PATTERN);
const ARG_KEYS = ['verb', 'service', 'bracket', 'body'];
const SUBS = subagent.SUBS;
const VERBS = [...SUBS, 'release', 'close'];

function tok(t) {
  const m = /^(--[^=\s"]+=)([\s\S]*)$/.exec(t);
  if (!m || !/[\s"]/.test(m[2])) return t;
  return `${m[1]}"${m[2].replace(/"/g, '')}"`;
}

function render({ verb, service, bracket = [], body = '' }) {
  const toks = bracket.map(tok).join(' ');
  return `[agent:browser ${verb}${service ? ' ' + service : ''}${toks ? ' ' + toks : ''}]${body ? ' ' + body : ''}\n[agent:end]`;
}

function validate(args) {
  const extra = Object.keys(args).find((k) => !ARG_KEYS.includes(k));
  if (extra) throw new Error(`unknown argument: ${extra} (use ${ARG_KEYS.join(', ')})`);
  const { verb, service } = args;
  if (!VERBS.includes(verb)) throw new Error(`verb must be one of ${SUBS.join(', ')}`);
  if (service != null && (typeof service !== 'string' || !SERVICE_RE.test(service))) throw new Error(`service must match ${SERVICE_PATTERN}`);
  const bracket = args.bracket == null ? [] : args.bracket;
  if (!Array.isArray(bracket) || bracket.some((t) => typeof t !== 'string')) throw new Error('bracket must be an array of strings');
  if (bracket.some((t) => t === '' || /[[\]\n\r]/.test(t))) throw new Error('bracket tokens must be non-empty and contain no [, ], newline or carriage return');
  const body = args.body == null ? '' : args.body;
  if (typeof body !== 'string') throw new Error('body must be a string');
  if (/[\n\r]/.test(body)) throw new Error('body must be one line');
  if (body.trim().startsWith('[agent:')) throw new Error('body must not start with [agent:');
  return { verb, service: service || '', bracket, body };
}

const TOOL = {
  name: 'browser',
  description: [
    "Drive this seat's browser pane. Same verbs, replies and refusals as `clodex '[agent:browser …]'`.",
    'A call waits up to 500 s; a browser `wait` may take up to 30 min server-side, so a result starting `completion unknown — do not retry` means the action may still have run: read the page before repeating a click, type or download.',
    'A refusal or error comes back as text, not as a tool error; the same call will fail the same way — do not retry it, return and let the seat\'s main agent decide.',
    '`bracket` holds the tokens that go INSIDE the intent bracket after the service (element number, direction, --flag, --flag=value; for click/inspect --text=<text> as ONE item); `body` is the one-line text AFTER the bracket (the URL for open/download, the text for type, the option for select, the key name for key, the note text for note).',
    'A " inside a --flag value is dropped. No release, no close, no --confirm, no note --forget: those are the main agent\'s.',
  ].join(' '),
  inputSchema: {
    type: 'object',
    properties: {
      verb: { type: 'string', enum: SUBS },
      service: { type: 'string', pattern: SERVICE_PATTERN },
      bracket: { type: 'array', items: { type: 'string' }, default: [] },
      body: { type: 'string', default: '' },
    },
    required: ['verb'],
    additionalProperties: false,
  },
  logKeys: ['verb', 'service'],
  toIntent(args) {
    return render(validate(args == null ? {} : args));
  },
};

module.exports = { TOOL };
