'use strict';
// template-editor-deny-roundtrip.test.js — a template opened in a cwd whose own
// .claude/settings.json denies some of its entries must save them back.
//
// The bug: the editor read the deny for the template's cwd and greyed those
// rows out, so collectToolChecklist / collectSkillChecklist — which skip
// disabled rows on purpose — dropped the names. The operator's hand template
// lost 15 tool denies and 14 skill offs on one save.
//
// The whole path is real here: the deny is read by the shipped engine from a
// settings.json planted in a TEMP cwd (never the checkout's), the advisory
// marking is the shipped `advisoryEffective` extracted from renderer.js, and
// the rows are drawn and collected by the shipped checklists. A test that
// handed the renderer a hand-built effective map would assert the marking and
// prove nothing about what the editor reads.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const { createEngine } = require('../engine');
const { registerIpcHandlers } = require('../ipc-handlers');
const { CLAUDE_TOOLS } = require('../catalogs');
const { mkTmpRoot } = require('./lib/tmp-roots');

// The whole catalog off, which is the shape that lost names: the operator's own
// hand template denies 35 of the 44 tools and 26 skills. Denying EVERY name is
// strictly the harder round-trip and needs no reference to a file outside the
// repo, which a fixture reading their template would have.
const DENIED_TOOLS = ['AskUserQuestion', 'EnterPlanMode'];
const DENIED_SKILLS = ['code-review', 'review'];

function el(tag) {
  const e = {
    tagName: tag, className: '', type: '', value: '', checked: false, disabled: false,
    innerHTML: '', children: [],
    appendChild(c) { e.children.push(c); return c; },
    querySelectorAll(sel) {
      assert.strictEqual(sel, 'input[type="checkbox"]:not(:checked):not(:disabled)');
      const flat = [];
      const walk = (n) => { for (const c of n.children) { flat.push(c); walk(c); } };
      walk(e);
      return flat.filter((c) => c.tagName === 'input' && c.type === 'checkbox' && !c.checked && !c.disabled);
    },
  };
  let text = '';
  Object.defineProperty(e, 'textContent', {
    get: () => text,
    set(v) {
      text = v == null ? '' : String(v);
      e.innerHTML = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    },
  });
  return e;
}

function withDom(fn) {
  const had = global.document;
  global.document = { createElement: el, addEventListener() {} };
  try { return fn(); } finally { global.document = had; }
}

const checklists = withDom(() => require('../renderer/lib/checklists'));

const rendererSrc = fs.readFileSync(path.join(ROOT, 'renderer', 'renderer.js'), 'utf8');
const ADVISORY_FN = (() => {
  const m = /\n(function advisoryEffective\([\s\S]*?\n\})\n/.exec(rendererSrc);
  assert.ok(m, 'ENTER: advisoryEffective was not found in renderer.js — every assertion below would be vacuous');
  return new Function(`${m[1]}\nreturn advisoryEffective;`)();
})();

// Plants the deny in a temp cwd AND repoints HOME at another temp dir, so the
// global settings layer the engine also reads is this fixture's, not the
// operator's — a real ~/.claude deny would otherwise leak into the assertions.
function mkBox() {
  const tmp = mkTmpRoot('clx-tpl-deny-');
  const cwd = path.join(tmp, 'ticket-worktree');
  fs.mkdirSync(path.join(cwd, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(cwd, '.claude', 'settings.json'), JSON.stringify({
    permissions: { deny: [...DENIED_TOOLS, 'Bash(rm:*)'] },
    skillOverrides: Object.fromEntries(DENIED_SKILLS.map((s) => [s, 'off'])),
  }));
  const fakeHome = path.join(tmp, 'home');
  fs.mkdirSync(path.join(fakeHome, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(fakeHome, '.claude', 'settings.json'), '{}');

  const registryDir = path.join(tmp, 'clodex-home');
  fs.mkdirSync(path.join(registryDir, 'run'), { recursive: true });
  const log = { info() {}, warn() {}, error() {} };
  const engine = createEngine({ userDataPath: tmp, seams: { registryDir }, log });
  const handlers = new Map();
  registerIpcHandlers({ ...engine, handle: (ch, fn) => handlers.set(ch, fn), on: (ch, fn) => handlers.set(ch, fn), log });
  return {
    cwd,
    fakeHome,
    tools: () => handlers.get('settings:toolCatalogFor')(null, cwd),
    skills: () => handlers.get('settings:skillCatalogFor')(null, cwd),
  };
}

function withHome(home, fn) {
  const had = process.env.HOME;
  process.env.HOME = home;
  try { return fn(); } finally {
    if (had === undefined) delete process.env.HOME; else process.env.HOME = had;
  }
}

test('a template opened in a cwd that denies its entries saves them unchanged', () => {
  const box = mkBox();
  const { toolRes, skillRes } = withHome(box.fakeHome, () => ({ toolRes: box.tools(), skillRes: box.skills() }));

  assert.ok(toolRes && toolRes.ok, 'ENTER: the tool catalog read must succeed');
  for (const name of DENIED_TOOLS) {
    assert.strictEqual(toolRes.effective[name] && toolRes.effective[name].value, 'off',
      `ENTER: the fixture cwd must really deny ${name}, or the round-trip proves nothing`);
  }
  assert.ok(!toolRes.effective.Bash, 'ENTER: a scoped deny is not a tool-level off');
  assert.ok(skillRes && skillRes.ok, 'ENTER: the skill catalog read must succeed');
  assert.strictEqual(skillRes.skillsLocked, false,
    'ENTER: a managed policy lock on this box would grey every row for a reason this test is not about');
  for (const name of DENIED_SKILLS) {
    assert.strictEqual(skillRes.effective[name] && skillRes.effective[name].value, 'off',
      `ENTER: the fixture cwd must really turn ${name} off`);
  }

  const tplTools = [...CLAUDE_TOOLS];
  const tplSkills = [...(skillRes.names || [])];
  assert.ok(tplTools.length >= 35 && tplSkills.length >= 14,
    `ENTER: the fixture template must be at least the size of the one that lost names (got ${tplTools.length}/${tplSkills.length})`);

  const collected = withDom(() => {
    checklists.setClaudeToolsCache([...CLAUDE_TOOLS]);
    const toolList = el('div');
    checklists.renderToolChecklist(toolList, new Set(tplTools),
      ADVISORY_FN(toolRes.effective, true));
    const skillList = el('div');
    checklists.renderSkillChecklist(skillList, tplSkills, new Set(tplSkills),
      ADVISORY_FN(skillRes.effective, true),
      { skillsLocked: skillRes.skillsLocked, canReenable: skillRes.canReenable });
    return {
      tools: checklists.collectToolChecklist(toolList),
      skills: checklists.collectSkillChecklist(skillList),
    };
  });

  assert.deepStrictEqual(collected.tools.slice().sort(), tplTools.slice().sort(),
    'every disabled tool must survive open -> save, denied by the cwd or not');
  assert.deepStrictEqual(collected.skills.slice().sort(), tplSkills.slice().sort(),
    'every disabled skill must survive open -> save');
});

test('the same read, unmarked, is what dropped the names', () => {
  // The live-session treatment against the same fixture: this is the behaviour
  // the New Session dialog keeps, and the reason the template path needed its
  // own flag rather than a change to the renderers' defaults.
  const box = mkBox();
  const toolRes = withHome(box.fakeHome, () => box.tools());

  const collected = withDom(() => {
    checklists.setClaudeToolsCache([...CLAUDE_TOOLS]);
    const list = el('div');
    checklists.renderToolChecklist(list, new Set([...DENIED_TOOLS, 'Workflow']), toolRes.effective);
    return checklists.collectToolChecklist(list);
  });
  for (const name of DENIED_TOOLS) {
    assert.ok(!collected.includes(name), `${name} is owned by the cwd's layer here, so it stays out`);
  }
  assert.ok(collected.includes('Workflow'), 'a tool the cwd does not deny still collects');
});

// The engine leaves background timers running (proxy poll, pending poll); the
// same force-exit every other createEngine file uses.
test('done', () => { setImmediate(() => process.exit(0)); });
