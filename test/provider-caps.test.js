// provider-caps.test.js — the per-CLI capability table the two session dialogs
// gate on (t749). Whole-object assertions: a partial match would read around a
// key a new row forgot, and an absent key is `undefined`, which every gate here
// treats as "hide" without a word.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { PROVIDER_CAPS, CAP_KEYS, capsFor } = require('../renderer/lib/provider-caps');
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
  });
});

test('t749: an unlisted type gets an all-false row, not undefined', () => {
  const allFalse = Object.fromEntries(CAP_KEYS.map((k) => [k, false]));
  for (const type of ['bash', 'sandbox', '', null, undefined]) {
    assert.deepStrictEqual(capsFor(type), allFalse, `${String(type)} must read as all-false`);
  }
});

test('t749: every row carries every key', () => {
  for (const [type, row] of Object.entries(PROVIDER_CAPS)) {
    assert.deepStrictEqual(Object.keys(row).sort(), [...CAP_KEYS].sort(),
      `${type} must declare the whole key set`);
    for (const k of CAP_KEYS) {
      assert.strictEqual(typeof row[k], 'boolean', `${type}.${k} must be a boolean`);
    }
  }
});

test('t749: the dialog may not offer skills to a provider main cannot deliver to', () => {
  const offered = Object.keys(PROVIDER_CAPS).filter((k) => PROVIDER_CAPS[k].injectSkills);
  assert.ok(offered.length, 'ENTER: at least one provider is offered the Custom skills row');
  const deliverable = createSkillDelivery({}).providers();
  assert.deepStrictEqual(offered.sort(), [...deliverable].sort());
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
  assert.match(body, /const isSkillsEditable = \(caps\.injectSkills \|\| caps\.skillRoster\) && !!argsSource && !!skillCatalog/);
  assert.match(body, /argsSkillsRow\.style\.display = \(isSkillsEditable && caps\.skillRoster\) \?/,
    'the roster checklist inside the section stays claude-only');
  assert.match(body, /argsToolsSection\.style\.display = caps\.tools \?/);
  assert.match(body, /argsAgentsRow\.style\.display = caps\.agents \?/);
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
