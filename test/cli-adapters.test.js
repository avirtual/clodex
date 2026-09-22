// cli-adapters.test.js — the per-CLI adapter table; its `ui` rows are what the two session dialogs
// gate on (t749). Whole-object assertions: a partial match would read around a
// key a new row forgot, and an absent key is `undefined`, which every gate here
// treats as "hide" without a word.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const {
  ADAPTERS, PLATFORMS, CAP_KEYS, capsFor, adapterFor, seatType, stripModelArgs, hasBypass, resolveModelId,
} = require('../cli-adapters');
const { createSkillDelivery } = require('../skill-delivery');

test('t749: claude is the full row', () => {
  assert.deepStrictEqual(capsFor('claude'), {
    injectSkills: true,
    skillRoster: true,
    plugins: true,
    agents: true,
    tools: true,
    strip: true,
    autoCompact: true,
    noWire: true,
    accounts: true,
  });
});

test('t749: codex gets exactly the two settings it honours', () => {
  assert.deepStrictEqual(capsFor('codex'), {
    injectSkills: true,
    skillRoster: false,
    plugins: true,
    agents: false,
    tools: false,
    strip: false,
    autoCompact: false,
    noWire: false,
    accounts: false,
  });
});

test('t749: an unlisted type gets an all-false row, not undefined', () => {
  const allFalse = Object.fromEntries(CAP_KEYS.map((k) => [k, false]));
  for (const type of ['bash', 'sandbox', '', null, undefined]) {
    assert.deepStrictEqual(capsFor(type), allFalse, `${String(type)} must read as all-false`);
  }
});

test('t749: every row carries every key', () => {
  for (const [type, entry] of Object.entries(ADAPTERS)) {
    const row = entry.ui;
    assert.deepStrictEqual(Object.keys(row).sort(), [...CAP_KEYS].sort(),
      `${type} must declare the whole key set`);
    for (const k of CAP_KEYS) {
      assert.strictEqual(typeof row[k], 'boolean', `${type}.${k} must be a boolean`);
    }
  }
});

test('t749: the dialog may not offer skills to a provider main cannot deliver to', () => {
  const offered = Object.keys(ADAPTERS).filter((k) => ADAPTERS[k].ui.injectSkills);
  assert.ok(offered.length, 'ENTER: at least one provider is offered the Custom skills row');
  const deliverable = createSkillDelivery({}).providers();
  assert.deepStrictEqual(offered.sort(), [...deliverable].sort());
});

const ENTRY_KEYS = ['id', 'label', 'cmd', 'model', 'posture', 'account', 'cwdDir', 'readOnlyCap', 'instructions', 'transcript', 'caps', 'ui'];

test('every adapter entry carries the whole entry key set', () => {
  for (const [type, entry] of Object.entries(ADAPTERS)) {
    assert.deepStrictEqual(Object.keys(entry), ENTRY_KEYS, `${type} must declare every entry key, in order`);
    assert.strictEqual(entry.id, type);
    assert.deepStrictEqual(Object.keys(entry.model), ['flags', 'aliases', 'idRe']);
    assert.deepStrictEqual(Object.keys(entry.caps), ['park', 'transcript', 'warmth']);
    assert.deepStrictEqual(Object.keys(entry.transcript), ['reader', 'link']);
    assert.deepStrictEqual(Object.keys(entry.posture), ['bypassArgs']);
    assert.ok(Array.isArray(entry.posture.bypassArgs) && entry.posture.bypassArgs.length > 0
      && entry.posture.bypassArgs.every((t) => typeof t === 'string'), `${type}: bypassArgs is a non-empty string array`);
  }
});

test('m0: the table rows declare posture, cwdDir, transcript and warmth literally', () => {
  assert.deepStrictEqual(ADAPTERS.claude.posture, { bypassArgs: ['--dangerously-skip-permissions'] });
  assert.deepStrictEqual(ADAPTERS.codex.posture, { bypassArgs: ['--dangerously-bypass-approvals-and-sandbox'] });
  assert.strictEqual(ADAPTERS.claude.cwdDir, null);
  assert.strictEqual(ADAPTERS.codex.cwdDir, '.codex');
  assert.deepStrictEqual(ADAPTERS.claude.transcript, { reader: 'claude', link: 'hook' });
  assert.deepStrictEqual(ADAPTERS.codex.transcript, { reader: 'codex', link: 'hook' });
  assert.deepStrictEqual(ADAPTERS.claude.caps, { park: true, transcript: true, warmth: true });
  assert.deepStrictEqual(ADAPTERS.codex.caps, { park: false, transcript: true, warmth: false });
  assert.deepStrictEqual(ADAPTERS.muse.posture, { bypassArgs: ['--approval-mode', 'never', '--disable-sandbox'] });
  assert.strictEqual(ADAPTERS.muse.cwdDir, null);
  assert.deepStrictEqual(ADAPTERS.muse.transcript, { reader: 'muse', link: 'clodex' });
  assert.deepStrictEqual(ADAPTERS.muse.caps, { park: false, transcript: true, warmth: false });
});

test('m2: the muse row — Meta\'s CLI, XDG overlay bootstrap, user-scope AGENTS.md, no read-only cap yet', () => {
  assert.deepStrictEqual(ADAPTERS.muse, {
    id: 'muse',
    label: 'Muse Code',
    cmd: 'muse',
    model: { flags: ['--model'], aliases: {}, idRe: ADAPTERS.claude.model.idRe },
    posture: { bypassArgs: ['--approval-mode', 'never', '--disable-sandbox'] },
    account: { envKey: 'XDG_CONFIG_HOME', bootstrap: 'xdg-overlay' },
    cwdDir: null,
    readOnlyCap: null,
    instructions: 'user-agents-md',
    transcript: { reader: 'muse', link: 'clodex' },
    caps: { park: false, transcript: true, warmth: false },
    ui: {
      injectSkills: true, skillRoster: false, plugins: true, agents: false, tools: false,
      strip: false, autoCompact: false, noWire: false, accounts: false,
    },
  });
  assert.deepStrictEqual(capsFor('muse'), {
    injectSkills: true, skillRoster: false, plugins: true, agents: false, tools: false,
    strip: false, autoCompact: false, noWire: false, accounts: false,
  });
  assert.deepStrictEqual(stripModelArgs('muse', ['--model', 'x', 'y']), ['y']);
  assert.strictEqual(resolveModelId('muse', 'opus'), 'opus', 'no aliases: an alias word is not expanded, it passes through as an id');
  assert.strictEqual(resolveModelId('muse', 'not a model!'), null);
});

test('m0: hasBypass is a contiguous-subsequence match on posture.bypassArgs', () => {
  const claude = ADAPTERS.claude;
  const two = { posture: { bypassArgs: ['--a', '--b'] } };
  const rows = [
    [claude, [], false],
    [claude, ['--dangerously-skip-permissions'], true],
    [claude, ['--model', 'x', '--dangerously-skip-permissions', '--foo'], true],
    [claude, ['--dangerously-bypass-approvals-and-sandbox'], false],
    [two, ['--a', '--x', '--b'], false],
    [two, ['--y', '--a', '--b'], true],
    [two, ['--a'], false],
    [two, ['--b', '--a'], false],
    [claude, undefined, false],
    [claude, null, false],
    [claude, '--dangerously-skip-permissions', false],
    [null, ['--dangerously-skip-permissions'], false],
  ];
  for (const [adapter, argv, want] of rows) {
    assert.strictEqual(hasBypass(adapter, argv), want, `hasBypass(${adapter && JSON.stringify(adapter.posture)}, ${JSON.stringify(argv)})`);
  }
});

test('the adapter table names exactly the providers skill-delivery can deliver to', () => {
  assert.deepStrictEqual(Object.keys(ADAPTERS), createSkillDelivery({}).providers());
});

test('readOnlyCap: claude is a tool denylist, codex is the argv sandbox pair', () => {
  assert.deepStrictEqual(ADAPTERS.claude.readOnlyCap, { enforce: 'tool-denylist' });
  assert.deepStrictEqual(ADAPTERS.codex.readOnlyCap, {
    enforce: 'argv',
    args: ['--sandbox', 'read-only', '--ask-for-approval', 'never'],
  });
  for (const entry of Object.values(ADAPTERS)) {
    assert.ok(entry.readOnlyCap === null || ['tool-denylist', 'argv'].includes(entry.readOnlyCap.enforce),
      `${entry.id}: readOnlyCap.enforce names a mode the review arm branches on`);
  }
});

test('PLATFORMS is the table order', () => {
  assert.deepStrictEqual(PLATFORMS, ['claude', 'codex', 'muse']);
});

test('adapterFor answers null for anything the table does not name', () => {
  assert.strictEqual(adapterFor('sh'), null);
  assert.strictEqual(adapterFor(undefined), null);
  assert.strictEqual(adapterFor(null), null);
  assert.strictEqual(adapterFor('toString'), null);
  assert.strictEqual(adapterFor('claude'), ADAPTERS.claude);
});

test('seatType: the template decides when present, the opener only when there is none', () => {
  assert.strictEqual(seatType(null, { type: 'codex' }), 'codex');
  assert.strictEqual(seatType({}, { type: 'codex' }), 'claude');
  assert.strictEqual(seatType({ type: 'codex' }, { type: 'claude' }), 'codex');
  assert.strictEqual(seatType(null, null), 'claude');
  assert.throws(() => seatType({ type: 'sh' }, null), /unknown seat type "sh".*claude, codex/);
  assert.throws(() => seatType(null, { type: 'sh' }), /unknown seat type "sh"/);
});

test('stripModelArgs strips every model flag the adapter declares, and only those', () => {
  assert.deepStrictEqual(stripModelArgs('codex', ['-m', 'o3', '--model=x', '--foo']), ['--foo']);
  assert.deepStrictEqual(stripModelArgs('claude', ['-m', 'o3']), ['-m', 'o3']);
  assert.deepStrictEqual(stripModelArgs('claude', ['--model', 'opus', '--model=x', '-v']), ['-v']);
  assert.deepStrictEqual(stripModelArgs('sh', ['--model', 'x']), ['--model', 'x']);
});

test('t749: the caps table is the only thing the dialogs gate these sections on', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'renderer.js'), 'utf8');
  const at = src.indexOf('function applyTypeDefaults(');
  assert.ok(at > 0, 'ENTER: applyTypeDefaults was located');
  const fn = src.slice(at, src.indexOf('\nlet lastToolCheck', at));
  assert.match(fn, /const caps = capsFor\(type\);/, 'ENTER: the caps lookup the rows read');
  assert.ok(!/claudeOnly/.test(fn), 'the claudeOnly flag is gone from the new-session gates');

  assert.match(fn, /skillsSection\.style\.display = \(caps\.injectSkills \|\| caps\.skillRoster\) \?/);
  assert.match(fn, /skillsRow\.style\.display = caps\.skillRoster \?/);
  assert.match(fn, /injectSkillsRow\.style\.display = caps\.injectSkills \?/);
  assert.match(fn, /pluginsRow\.style\.display = caps\.plugins \?/);
  assert.match(fn, /agentsRow\.style\.display = caps\.agents \?/);
  assert.match(fn, /toolsSection\.style\.display = caps\.tools \?/);
  assert.match(fn, /stripRow\.style\.display = caps\.strip \?/);
  assert.match(fn, /autoCompactRow\.style\.display = caps\.autoCompact \?/);
  assert.match(fn, /noWireRow\.style\.display = caps\.noWire \?/);
});

test('the account picker row is gated on caps.accounts in both dialogs', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'renderer.js'), 'utf8');
  const nat = src.indexOf('function applyTypeDefaults(');
  assert.ok(nat > 0, 'ENTER: applyTypeDefaults was located');
  const fn = src.slice(nat, src.indexOf('\nlet lastToolCheck', nat));
  assert.match(fn, /accountRow\.style\.display = caps\.accounts \?/,
    'New Session hides the Account picker for a provider that cannot read it');

  const eat = src.indexOf('async function openArgsDialog(');
  assert.ok(eat > 0, 'ENTER: openArgsDialog was located');
  const body = src.slice(eat, src.indexOf('\nfunction closeArgsDialog', eat));
  assert.match(body, /const caps = capsFor\(res\.type\);/, 'ENTER: the caps lookup the gate reads');
  assert.match(body, /argsAccountRow\.style\.display = caps\.accounts \?/,
    'Edit Session hides the Account picker for a provider that cannot read it');
});

test('t749: a widened section is repainted for the type that widened it', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'renderer.js'), 'utf8');
  const at = src.indexOf('function applyTypeDefaults(');
  const fn = src.slice(at, src.indexOf('\nlet lastToolCheck', at));
  // Shown-but-stale is worse than hidden: the container still holds whatever the
  // previous claude selection painted into it.
  assert.match(fn, /if \(caps\.injectSkills\) refreshNewSessionInjectSkills\(\);/);
  assert.match(fn, /if \(caps\.skillRoster\) refreshNewSessionSkills\(modeSkillDenySet\(\)\);/);
  assert.match(fn, /if \(caps\.tools\) refreshNewSessionTools\(modeToolDenySet\(\)\);/);

  const guarded = src.slice(src.indexOf('function newSessionSeat()'));
  assert.match(guarded, /async function refreshNewSessionInjectSkills[\s\S]{0,160}if \(!capsFor\(inputType\.value\)\.injectSkills\) return;/);
  assert.match(guarded, /async function refreshNewSessionPlugins[\s\S]{0,240}if \(!capsFor\(inputType\.value\)\.plugins\) return;/);
});

test('t749: the Edit dialog gates plugins and skills on caps, not on isClaude', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'renderer.js'), 'utf8');
  const at = src.indexOf('async function openArgsDialog(');
  assert.ok(at > 0, 'ENTER: openArgsDialog was located');
  const body = src.slice(at, src.indexOf('\nfunction closeArgsDialog', at));
  assert.match(body, /const caps = capsFor\(res\.type\);/, 'ENTER: the caps lookup the gates read');

  assert.ok(!/isPluginsEditable = isClaude/.test(body));
  assert.ok(!/isSkillsEditable = isClaude/.test(body));
  assert.match(body, /const isPluginsEditable = caps\.plugins && !argsSource/,
    'plugins keeps its peer-row hide while widening to codex');
  assert.match(body, /const isSkillsEditable = \(caps\.injectSkills \|\| caps\.skillRoster\) && !!skillCatalog;/);
  assert.match(body, /argsSkillsRow\.style\.display = \(isSkillsEditable && caps\.skillRoster\) \?/,
    'the roster checklist inside the section stays claude-only');
  assert.match(body, /argsToolsSection\.style\.display = caps\.tools \?/);
  assert.match(body, /argsAgentsRow\.style\.display = caps\.agents \?/);
});

test('the Edit dialog shows Skills for a LOCAL seat and saves both lists', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'renderer.js'), 'utf8');
  const at = src.indexOf('async function openArgsDialog(');
  assert.ok(at > 0, 'ENTER: openArgsDialog was located');
  const body = src.slice(at, src.indexOf('\nfunction closeArgsDialog', at));

  assert.match(body, /window\.api\.getSkillCatalog\(name\),/,
    'the local Promise.all fetches the skill catalog');
  assert.match(body, /skillCatalog = \(sc && sc\.ok\) \? sc : null;/,
    'the local arm stores the catalog the gate reads');
  assert.ok(!/!!argsSource && !!skillCatalog/.test(body),
    'the gate no longer excludes a local seat');

  const sat = src.indexOf("document.getElementById('btn-args-save')");
  assert.ok(sat > 0, 'ENTER: the Edit save handler was located');
  const save = src.slice(sat, src.indexOf('alert(`Save settings failed', sat));
  assert.match(save, /setSessionArgs\(name, parsed, restart, proxy, undefined, agents, denyBuiltins, disabledTools, disabledSkills, injectSkills, systemPromptFile/,
    'the local save sends both skill lists at positions 9 and 10');
});

// The Skills section opens for any provider whose caps row has injectSkills OR
// skillRoster, so a codex seat opens it for the inject checklist alone and never
// paints the roster list inside it. The save must not read that unpainted list:
// collectSkillChecklist would answer [], or whatever a previous claude edit left
// in the container, and either lands as this seat's real answer — a re-enable of
// every skill the box had turned off.
//
// `undefined` is NOT the alternative: peerSkillsSource's save (peers-ui.js) skips
// the whole peerSetSessionSkills call when disabledSkills is absent, so the
// injectSkills this ticket exists to deliver would never land. Echoing back what
// readSkillCatalog reported is the only option that satisfies both.
test('t749: the Edit save echoes a roster it never painted instead of clearing it', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'renderer.js'), 'utf8');
  const at = src.indexOf("document.getElementById('btn-args-save')");
  assert.ok(at > 0, 'ENTER: the Edit save handler was located');
  const body = src.slice(at, src.indexOf('\nasync function ', at));
  assert.match(body, /const skillsShown = argsSkillsSection\.style\.display !== 'none';/,
    'ENTER: the section-shown flag the save reads');
  assert.match(body, /argsSkillsRow\.style\.display === 'none'\s*\n?\s*\? argsSkillsDisabledPersisted/);
  assert.ok(!/const disabledSkills = skillsShown \? collectSkillChecklist/.test(body),
    'the roster collect is no longer keyed on the whole section');
  // The echo is only as good as its source: an open that skips the capture leaves
  // the last seat's roster in the variable, which the save would then send.
  const dlg = src.slice(src.indexOf('async function openArgsDialog('),
    src.indexOf('\nfunction closeArgsDialog'));
  assert.match(dlg, /argsSkillsDisabledPersisted = sc\.disabledSkills \|\| \[\];/,
    'openArgsDialog captures the read roster for the save to echo');
});
