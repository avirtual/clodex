'use strict';

const PLUGIN_GLYPH = '◇';
const INERT = Object.freeze({ glyph: '⊘', label: "won't fire" });

const g = (glyph, label) => Object.freeze({ glyph, label });

const CONTEXT = { compact: g('⊟', 'compact'), clear: g('⌫', 'clear'), reload: g('↺', 'reload') };
const SCRATCH = { begin: g('⟦', 'scratch'), end: g('⟧', 'result'), rewind: g('⇤', 'rewind'), mark: g('✱', 'mark'), cancel: g('⊗', 'cancel') };
const TASK = {
  assign: g('⇥', 'assign'),
  start: g('⇄', 'start'),
  park: g('‖', 'park'),
  respec: g('✎', 'respec'),
  reject: g('↶', 'reject'),
  cancel: g('⊗', 'cancel'),
  accept: g('⤓', 'accept'),
  done: g('✓', 'done'),
  list: g('≡', 'tickets'),
};

const CORE = {
  dm: () => g('→', 'message'),
  resend: () => g('⇉', 'resend'),
  who: () => g('◎', 'who'),
  name: () => g('@', 'name'),
  context: (i) => CONTEXT[i.sub] || g('⊟', String(i.sub || 'context')),
  scratch: (i) => SCRATCH[i.sub] || g('⟦', String(i.sub || 'scratch')),
  memory: (i) => g('◈', String(i.sub || 'memory')),
  file: () => g('▢', 'show'),
  term: () => g('▤', 'terminal'),
  exec: () => g('▸', 'run'),
  remind: (i) => {
    const word = String(i.spec || '').split(/\s+/)[0];
    if (word === 'list') return g('◷', 'list reminders');
    if (word === 'cancel') return g('◷', 'unremind');
    return g('◷', 'remind');
  },
  shout: () => g('⚑', 'shout'),
  'team-review': () => g('◐', 'review'),
  'review-done': () => g('⊨', 'verdict'),
  reboot: () => g('↻', 'reboot'),
  task: (i) => (i.sub === 'add' ? g('⊕', i.start ? 'dispatch' : 'file') : TASK[i.sub] || g('⇄', String(i.sub || 'task'))),
  'team-create': () => g('⊞', 'create'),
  team: (i) => g('⊞', String(i.sub || 'team')),
  spawn: () => g('✦', 'spawn'),
};

const REPLY_GLYPHS = Object.freeze({
  dm: g('→', 'message'),
  resend: g('⇉', 'resend'),
  who: g('◎', 'who'),
  name: g('@', 'name'),
  context: g('⊟', 'context'),
  scratch: g('⟦', 'scratch'),
  memory: g('◈', 'memory'),
  file: g('▢', 'show'),
  term: g('▤', 'terminal'),
  exec: g('▸', 'run'),
  remind: g('◷', 'remind'),
  shout: g('⚑', 'shout'),
  'team-review': g('◐', 'review'),
  'review-done': g('⊨', 'verdict'),
  reboot: g('↻', 'reboot'),
  task: g('⇄', 'task'),
  'team-create': g('⊞', 'team'),
  team: g('⊞', 'team'),
  spawn: g('✦', 'spawn'),
  intent: g('⊘', 'bounced'),
  peers: g('⇢', 'peers'),
});

const CORE_GLYPHS = new Set([
  PLUGIN_GLYPH,
  INERT.glyph,
  ...Object.values(CONTEXT).map((x) => x.glyph),
  ...Object.values(SCRATCH).map((x) => x.glyph),
  ...Object.values(TASK).map((x) => x.glyph),
  ...Object.values(REPLY_GLYPHS).map((x) => x.glyph),
  '⊕',
]);

function isPlainGlyph(s) {
  return typeof s === 'string' && Array.from(s).length === 1 && !/\p{Emoji}/u.test(s) && !/\p{Extended_Pictographic}/u.test(s);
}

function pluginGlyphOk(s) {
  return isPlainGlyph(s) && !CORE_GLYPHS.has(s);
}

function glyphFor(intent, pluginRow) {
  const type = intent && intent.type;
  if (Object.prototype.hasOwnProperty.call(CORE, type)) return CORE[type](intent);
  return g((pluginRow && pluginRow.glyph) || PLUGIN_GLYPH, String(type || ''));
}

function replyGlyphFor(verb, pluginRow) {
  if (Object.prototype.hasOwnProperty.call(REPLY_GLYPHS, verb)) return REPLY_GLYPHS[verb];
  return g((pluginRow && pluginRow.glyph) || PLUGIN_GLYPH, String(verb || ''));
}

const str = (v) => (typeof v === 'string' && v ? v : null);
const TEAM_TARGET_KEYS = ['name', 'stem', 'branch'];
const TEAM_SKIP = new Set(['type', 'sub', 'body', ...TEAM_TARGET_KEYS]);

function kvChips(intent) {
  return Object.keys(intent)
    .filter((k) => !TEAM_SKIP.has(k) && intent[k] != null && intent[k] !== '' && intent[k] !== false)
    .map((k) => `${k}:${intent[k]}`);
}

function targetAndChips(intent) {
  switch (intent.type) {
    case 'dm': return [str(intent.target), intent.urgent ? ['urgent'] : []];
    case 'task': {
      const chips = ['start', 'park', 'dup'].filter((k) => intent[k] === true);
      if (str(intent.reviewer)) chips.push(`reviewer:${intent.reviewer}`);
      return [str(intent.id) || str(intent.who), chips];
    }
    case 'exec': return [str(intent.cmd), []];
    case 'remind': {
      const spec = str(intent.spec);
      const rest = spec && spec.replace(/^(list|cancel)\b\s*/, '');
      return [rest || null, []];
    }
    case 'file': return [str(intent.path), intent.sub && intent.sub !== 'view' ? [intent.sub] : []];
    case 'team':
    case 'team-create': return [TEAM_TARGET_KEYS.map((k) => str(intent[k])).find(Boolean) || null, kvChips(intent)];
    case 'spawn': return [str(intent.name), []];
    case 'resend': return [str(intent.id), []];
    case 'scratch': return [str(intent.label), []];
    case 'shout': return ['you', []];
    default:
      if (Object.prototype.hasOwnProperty.call(CORE, intent.type)) return [null, []];
      return [str(intent.target) || str(intent.name) || str(intent.id), []];
  }
}

function headOf(intent, pluginRow) {
  const { glyph, label } = glyphFor(intent, pluginRow);
  const [target, chips] = targetAndChips(intent || {});
  return { glyph, label, target, chips };
}

module.exports = { PLUGIN_GLYPH, INERT, REPLY_GLYPHS, CORE_GLYPHS, isPlainGlyph, pluginGlyphOk, glyphFor, replyGlyphFor, headOf };
