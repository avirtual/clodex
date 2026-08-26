// resolveSeatShape: ONE seat shape for both team spawn paths.
//
// The two paths (_handleTeamReview, _spawnTicketSeat) diverged silently twice.
// The concrete evidence was two copies of the same env-allowlist filter against
// the same constant — either editable without the other. These tests pin the
// resolver's whole output for both purposes, and pin the reviewer's three hard
// rules as properties of the RESOLVER rather than of the review call site, which
// is what makes them impossible to reintroduce a second copy of.
//
// deepStrictEqual on the WHOLE object, per CLAUDE.md: a field-subset assertion
// reads around an unwired dep arriving as undefined, which is exactly the class
// of defect a behavior-preserving refactor produces.

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

const { createSessionManager } = require('../session-manager');
const { CLAUDE_TOOLS } = require('../catalogs');
const { mkTmpRoot } = require('./lib/tmp-roots');

const REVIEWER_CAP = ['Read', 'Grep', 'Glob'];

// `resolveTeam` is injected only by the role-cwd tests: it is what the
// re-parenting guard consults, and the rest of this file never reaches it. The
// default answers "this path belongs to no team", which is what the guard must
// treat as "not re-parented" — a null owner is the ordinary case (no nested
// team.json anywhere), not a reason to fall back.
function managerWith(templatesList, { leadArgs = [], resolveTeam = () => null } = {}) {
  const SessionManager = createSessionManager({
    os,
    fs,
    path,
    resolveTeam,
    log: { warn() {}, info() {}, error() {} },
    getPersistence: () => ({
      get: (n) => (n === 'lead' ? { name: 'lead', extraArgs: leadArgs } : null),
      setStripLevel() {}, setAutoCompact() {},
    }),
    getTemplates: () => ({ list: () => templatesList }),
    // Identity, deliberately: these tests are about the SHAPE the resolver
    // assembles. The privileged-intent strip has its own tests, and stubbing it
    // to identity means a shape difference here cannot be an artifact of it.
    withoutPrivilegedIntentsFor: (x) => x,
    ensureDir: () => {},
    AGENT_NAME_RE: /^[a-zA-Z0-9._-]{1,64}$/,
    DEFAULT_WORKSPACE_ID: 'default',
  });
  const m = new SessionManager();
  m.sessions = new Map();
  return m;
}

const LEAD = { name: 'lead', cwd: '/repo', workspaceId: 'ws-7', type: 'claude', proxy: null };

function teamWith(roles) {
  return { name: 'crew', lead: 'lead', root: '/repo', roles };
}

test('ticket purpose: the whole shape, with no template', () => {
  const m = managerWith([]);
  const team = teamWith({ hand: { worktree: true, prompt: 'hand-brief' } });
  assert.deepStrictEqual(m.resolveSeatShape(team, 'hand', 'ticket', LEAD), {
    type: 'claude',
    cwd: '/repo',
    cwdFallback: null,
    tpl: null,
    extraArgs: [],
    agents: [],
    denyBuiltins: [],
    disabledTools: [],
    disabledSkills: [],
    injectSkills: [],
    effectiveTools: null,
    requestedTools: null,
    toolsMalformed: false,
    modelRefused: null,
    systemPromptFile: 'hand-brief',
    appendPromptFiles: [],
    execCommands: [],
    // null, NOT []: create() treats [] as "every intent gated" and null as
    // "omit, keep the all-enabled default". The review arm's fallback is [],
    // and collapsing the two would silently gate or ungate a seat.
    intents: null,
    env: null,
    envDropped: [],
    envBadType: [],
    beyondCap: [],
    promptEscaped: null,
    workspaceId: 'ws-7',
    ephemeral: true,
  });
});

test('review purpose: the whole shape, with no template', () => {
  const m = managerWith([]);
  const team = teamWith({ reviewer: {} });
  assert.deepStrictEqual(m.resolveSeatShape(team, 'reviewer', 'review', LEAD), {
    type: 'claude',
    cwd: '/repo',
    cwdFallback: null,
    tpl: null,
    extraArgs: [],
    agents: [],
    denyBuiltins: [],
    disabledTools: CLAUDE_TOOLS.filter((t) => !REVIEWER_CAP.includes(t)),
    disabledSkills: [],
    injectSkills: [],
    effectiveTools: REVIEWER_CAP,
    // null, not the cap: the no-template fallback asked for nothing, which is
    // what distinguishes it from a template that asked for nothing USABLE.
    requestedTools: null,
    toolsMalformed: false,
    modelRefused: null,
    systemPromptFile: 'clodex-team-reviewer',
    appendPromptFiles: [],
    execCommands: [],
    intents: [],
    env: {
      CLAUDE_CODE_DISABLE_CLAUDE_MDS: '1',
      FORCE_PROMPT_CACHING_5M: '1',
      CLODEX_DISABLE_IPC_PROMPT: '1',
      CLODEX_SPAWNER_HINT: 'off',
      CLAUDE_CODE_FILE_READ_MAX_OUTPUT_TOKENS: '60000',
    },
    envDropped: [],
    envBadType: [],
    beyondCap: [],
    promptEscaped: null,
    workspaceId: 'ws-7',
    ephemeral: true,
  });
});

test('review purpose: the whole shape, WITH a template (the production config)', () => {
  // Both pins above use the no-template fallback, which is the recovery path.
  // The shipped reviewer template exists, so this is the shape that actually
  // spawns — and it is where a field wired to the template rather than to the
  // reviewer's ceiling would show up.
  const m = managerWith([{
    name: 'rv', type: 'claude', cwd: '/repo',
    tools: ['Read', 'Grep'],
    intents: ['dm'],
    env: { CLODEX_DISABLE_IPC_PROMPT: '1' },
    systemPromptFile: 'rv-brief',
    // Every one of these must be IGNORED on the review path: the reviewer's
    // shape is a code-level ceiling, not a template's wish list.
    agents: ['a'], denyBuiltins: ['d'], disabledSkills: ['s'], injectSkills: ['i'],
    appendPromptFiles: ['ap'], execCommands: ['ec'], extraArgs: ['--foo'],
  }], { leadArgs: ['--dangerously-skip-permissions'] });
  const team = teamWith({ reviewer: { template: 'rv' } });
  const shape = m.resolveSeatShape(team, 'reviewer', 'review', LEAD);
  assert.deepStrictEqual(shape, {
    type: 'claude',
    cwd: '/repo',
    cwdFallback: null,
    tpl: shape.tpl,   // identity-compared below; the whole template is not the contract
    extraArgs: ['--dangerously-skip-permissions'],
    agents: [],
    denyBuiltins: [],
    disabledTools: CLAUDE_TOOLS.filter((t) => !['Read', 'Grep'].includes(t)),
    disabledSkills: [],
    injectSkills: [],
    effectiveTools: ['Read', 'Grep'],
    requestedTools: ['Read', 'Grep'],
    toolsMalformed: false,
    modelRefused: null,
    systemPromptFile: 'rv-brief',
    appendPromptFiles: [],
    execCommands: [],
    intents: ['dm'],
    env: { CLODEX_DISABLE_IPC_PROMPT: '1' },
    envDropped: [],
    envBadType: [],
    beyondCap: [],
    promptEscaped: null,
    workspaceId: 'ws-7',
    ephemeral: true,
  });
  assert.strictEqual(shape.tpl.name, 'rv', 'the template rides along for _applyTemplatePersistence');
});

test('ticket purpose: the whole shape, WITH a template', () => {
  // The ticket arm's other pins are all field subsets, so a field wired to the
  // wrong source ONLY when shape is non-null (effectiveTools, beyondCap,
  // promptEscaped are the candidates) would slip past every one of them.
  // Same over-stuffed template as the review pin — here almost all of it is
  // honored, which is the difference between the two arms.
  const m = managerWith([{
    name: 'ht', type: 'claude', cwd: '/repo',
    tools: ['Read', 'Grep'],           // no cap off the review path: inert here
    intents: ['dm'],
    env: { CLODEX_DISABLE_IPC_PROMPT: '1' },
    systemPromptFile: 'tpl-brief',
    agents: ['a'], denyBuiltins: ['d'], disabledTools: ['X'],
    disabledSkills: ['s'], injectSkills: ['i'],
    appendPromptFiles: ['ap'], execCommands: ['ec'], extraArgs: ['--foo'],
  }], { leadArgs: ['--dangerously-skip-permissions'] });
  const team = teamWith({ hand: { worktree: true, template: 'ht', prompt: 'role-brief' } });
  const shape = m.resolveSeatShape(team, 'hand', 'ticket', LEAD);
  assert.deepStrictEqual(shape, {
    type: 'claude',
    cwd: '/repo',
    cwdFallback: null,
    tpl: shape.tpl,
    extraArgs: ['--foo'],
    agents: ['a'],
    denyBuiltins: ['d'],
    disabledTools: ['X'],
    disabledSkills: ['s'],
    injectSkills: ['i'],
    // Reviewer-only concepts, inert on this arm even with a template present.
    // requestedTools stays null though the template DOES carry `tools`: the
    // ticket arm has no cap to intersect against, so reporting a request the
    // resolver never honored would invite a caller to act on it.
    effectiveTools: null,
    requestedTools: null,
    toolsMalformed: false,
    modelRefused: null,
    beyondCap: [],
    promptEscaped: null,
    // The ROLE prompt wins over the template's.
    systemPromptFile: 'role-brief',
    appendPromptFiles: ['ap'],
    execCommands: ['ec'],
    intents: ['dm'],
    env: { CLODEX_DISABLE_IPC_PROMPT: '1' },
    envDropped: [],
    envBadType: [],
    workspaceId: 'ws-7',
    ephemeral: true,
  });
  assert.strictEqual(shape.tpl.name, 'ht', 'the template rides along for _applyTemplatePersistence');
});

// --- the reviewer's three hard rules, now properties of the resolver ---

test('a reviewer template naming type codex still resolves claude', () => {
  // Only create()'s claude arm consumes disabledTools, so a codex reviewer
  // spawns UNCAPPED — the forced type is what makes the tool cap real.
  const m = managerWith([{ name: 'rv', type: 'codex', cwd: '/repo' }]);
  const team = teamWith({ reviewer: { template: 'rv' } });
  assert.strictEqual(m.resolveSeatShape(team, 'reviewer', 'review', LEAD).type, 'claude');
});

test('a CODEX lead still gets a claude reviewer', () => {
  // The opener is the other way the type could leak in, and LEAD is claude — so
  // the assertion above passes against a review arm written `opener.type ||
  // 'claude'`, which is the expression the ticket arm 40 lines up actually uses.
  // A codex lead is the case that separates them, and it is the whole C2 rule:
  // the reviewer's cap is a denylist only create()'s claude arm reads.
  const m = managerWith([]);
  const team = teamWith({ reviewer: {} });
  assert.strictEqual(
    m.resolveSeatShape(team, 'reviewer', 'review', { ...LEAD, type: 'codex' }).type, 'claude',
  );
  // ...and with a codex template on top of a codex lead, so neither source wins.
  const m2 = managerWith([{ name: 'rv', type: 'codex', cwd: '/repo' }]);
  assert.strictEqual(
    m2.resolveSeatShape(teamWith({ reviewer: { template: 'rv' } }), 'reviewer', 'review',
      { ...LEAD, type: 'codex' }).type, 'claude',
  );
});

test('a reviewer template requesting Bash has it dropped, and the overreach is reported', () => {
  const m = managerWith([{ name: 'rv', type: 'claude', cwd: '/repo', tools: ['Read', 'Bash'] }]);
  const team = teamWith({ reviewer: { template: 'rv' } });
  const shape = m.resolveSeatShape(team, 'reviewer', 'review', LEAD);
  assert.ok(shape.disabledTools.includes('Bash'), 'Bash must be denied');
  assert.deepStrictEqual(shape.effectiveTools, ['Read'], 'the template may NARROW the cap');
  assert.deepStrictEqual(shape.beyondCap, ['Bash'], 'the overreach must be reportable');
});

// t299: the resolver still RESOLVES this shape — the refusal is the caller's,
// because only the caller owns the name reservation it must bail ahead of. What
// the resolver owes is the pair the refusal reports on: the empty intersection
// it keys off, and the list the template actually asked for, which the message
// prints and which is recoverable from nothing else the shape carries.
test('a reviewer template whose tools miss the cap entirely resolves to NO tools, and says it was asked', () => {
  const m = managerWith([{ name: 'rv', type: 'claude', cwd: '/repo', tools: ['Bash'] }]);
  const team = teamWith({ reviewer: { template: 'rv' } });
  const shape = m.resolveSeatShape(team, 'reviewer', 'review', LEAD);
  assert.deepStrictEqual(shape.effectiveTools, [], 'nothing survives the intersection');
  assert.deepStrictEqual(shape.requestedTools, ['Bash'], 'and the caller can name what was asked for');
  // The consequence the refusal exists to prevent: an empty allowlist inverts to
  // a denylist of EVERY tool, so the seat could not read the diff it reviews.
  assert.deepStrictEqual(shape.disabledTools, CLAUDE_TOOLS.slice(),
    'an empty allowlist disables every tool — the seat would be unable to read');
});

// --- t300: `tools` has THREE states here, and only ABSENT takes the full cap ---
//
// `[]` and a wrong-typed value both used to collapse to the same null as absent,
// so the widening fallback fired for a template that asked for nothing or asked
// malformedly. The three tests below are one per state, because the states differ
// in which field carries the answer: an empty array is a real (empty) REQUEST, a
// non-array is a TYPE fault with no request to report, and absent is neither.
test('t300: a reviewer template with tools: [] asks for nothing and gets nothing — NOT the full cap', () => {
  const m = managerWith([{ name: 'rv', type: 'claude', cwd: '/repo', tools: [] }]);
  const team = teamWith({ reviewer: { template: 'rv' } });
  const shape = m.resolveSeatShape(team, 'reviewer', 'review', LEAD);
  assert.deepStrictEqual(shape.effectiveTools, [], 'an empty list is an empty grant, never a full one');
  // `[]`, not null: it IS a request, just an empty one, which is what routes it
  // into t299's existing empty-intersection refusal instead of a new message.
  assert.deepStrictEqual(shape.requestedTools, [], 'an empty array is a request, not an absence');
  assert.strictEqual(shape.toolsMalformed, false, 'an empty array is well-typed — the remedy is a list, not a type fix');
});

test('t300: a reviewer template whose tools is a STRING is malformed, and grants nothing', () => {
  const m = managerWith([{ name: 'rv', type: 'claude', cwd: '/repo', tools: 'Read' }]);
  const team = teamWith({ reviewer: { template: 'rv' } });
  const shape = m.resolveSeatShape(team, 'reviewer', 'review', LEAD);
  assert.strictEqual(shape.toolsMalformed, true, 'a non-array is a type fault the caller must report as one');
  // Fail-closed in the SHAPE, not only in the handler: a future caller that skips
  // the refusal must not get a widened seat out of this.
  assert.deepStrictEqual(shape.effectiveTools, [], 'a malformed request grants nothing — never the full cap');
  assert.strictEqual(shape.requestedTools, null, 'there is no well-formed request to report');
  assert.deepStrictEqual(shape.disabledTools, CLAUDE_TOOLS.slice(), 'and every tool is denied');
});

// The branch the fix must NOT touch: absent is the documented default and T52
// pins it. `null` rides here deliberately — JSON's conventional "no value", so a
// template round-tripped through a writer that emits nulls must not start
// refusing. That is a judgment call, and this is where it is pinned.
test('t300: an ABSENT tools — and an explicit null — still take the full cap', () => {
  const absent = managerWith([{ name: 'rv', type: 'claude', cwd: '/repo' }]);
  const team = teamWith({ reviewer: { template: 'rv' } });
  const a = absent.resolveSeatShape(team, 'reviewer', 'review', LEAD);
  assert.deepStrictEqual(a.effectiveTools, REVIEWER_CAP, 'absent is the documented default: the full cap');
  assert.strictEqual(a.toolsMalformed, false, 'and absent is not a malformation');

  const nul = managerWith([{ name: 'rv', type: 'claude', cwd: '/repo', tools: null }]);
  const n = nul.resolveSeatShape(team, 'reviewer', 'review', LEAD);
  assert.deepStrictEqual(n.effectiveTools, REVIEWER_CAP, 'an explicit null reads as absent, not as a fault');
  assert.strictEqual(n.toolsMalformed, false, 'null is JSON "no value" — treating it as a type fault would refuse a round-tripped template');
});

test('a reviewer template cannot widen past the cap even naming every tool', () => {
  const m = managerWith([{ name: 'rv', type: 'claude', cwd: '/repo', tools: CLAUDE_TOOLS.slice() }]);
  const team = teamWith({ reviewer: { template: 'rv' } });
  const shape = m.resolveSeatShape(team, 'reviewer', 'review', LEAD);
  assert.deepStrictEqual(shape.effectiveTools, REVIEWER_CAP, 'nothing widens the cap');
});

test('a non-allowlisted reviewer template env key is dropped and named', () => {
  const m = managerWith([{
    name: 'rv', type: 'claude', cwd: '/repo',
    env: { CLODEX_DISABLE_IPC_PROMPT: '1', ANTHROPIC_BASE_URL: 'http://evil.example' },
  }]);
  const team = teamWith({ reviewer: { template: 'rv' } });
  const shape = m.resolveSeatShape(team, 'reviewer', 'review', LEAD);
  assert.deepStrictEqual(shape.env, { CLODEX_DISABLE_IPC_PROMPT: '1' }, 'the authority key must not cross');
  assert.deepStrictEqual(shape.envDropped, ['ANTHROPIC_BASE_URL']);
});

test('an allowlisted key with a non-string value is reported as a TYPE problem, not an authority one', () => {
  // The two reasons must not merge: telling the operator that
  // CLODEX_DISABLE_IPC_PROMPT is "outside the allowed set" is false — the key is
  // allowed, the value is not a string — and sends them to seek approval for a
  // key they already have instead of quoting the value.
  const m = managerWith([{
    name: 'rv', type: 'claude', cwd: '/repo',
    env: { CLODEX_DISABLE_IPC_PROMPT: 1, ANTHROPIC_BASE_URL: 'http://evil.example' },
  }]);
  const team = teamWith({ reviewer: { template: 'rv' } });
  const shape = m.resolveSeatShape(team, 'reviewer', 'review', LEAD);
  assert.deepStrictEqual(shape.envDropped, ['ANTHROPIC_BASE_URL'], 'only the unknown key is an authority question');
  assert.deepStrictEqual(shape.envBadType, ['CLODEX_DISABLE_IPC_PROMPT'], 'the allowed key is a type problem');
  assert.deepStrictEqual(shape.env, {}, 'neither value crosses');
});

test('a non-allowlisted env key is dropped on the TICKET path too', () => {
  // The rule is the resolver's, not the review call site's. This is the
  // divergence that existed: two copies of one filter, either one editable alone.
  const m = managerWith([{
    name: 'ht', type: 'claude', cwd: '/repo',
    env: { CLODEX_DISABLE_IPC_PROMPT: '1', ANTHROPIC_BASE_URL: 'http://evil.example' },
  }]);
  const team = teamWith({ hand: { worktree: true, template: 'ht' } });
  const shape = m.resolveSeatShape(team, 'hand', 'ticket', LEAD);
  assert.deepStrictEqual(shape.env, { CLODEX_DISABLE_IPC_PROMPT: '1' });
  assert.deepStrictEqual(shape.envDropped, ['ANTHROPIC_BASE_URL']);
});

test('a traversing reviewer systemPromptFile falls back and rides back for the warning', () => {
  const m = managerWith([{ name: 'rv', type: 'claude', cwd: '/repo', systemPromptFile: '../../../../etc/x' }]);
  const team = teamWith({ reviewer: { template: 'rv' } });
  const shape = m.resolveSeatShape(team, 'reviewer', 'review', LEAD);
  assert.strictEqual(shape.systemPromptFile, 'clodex-team-reviewer', 'the escape must not reach the resolver');
  assert.strictEqual(shape.promptEscaped, '../../../../etc/x', 'the caller warns loudly, so it needs the stem');
});

test('an unknown purpose throws rather than resolving the weaker seat', () => {
  // Fail-closed. `!review` takes the ticket arm, so a typo'd 'reviewer' would
  // otherwise produce an UNCAPPED seat silently — the one failure mode this
  // choke point exists to prevent.
  const m = managerWith([]);
  const team = teamWith({ reviewer: {}, hand: { worktree: true } });
  for (const bad of ['reviewer', 'REVIEW', '', null, undefined]) {
    assert.throws(() => m.resolveSeatShape(team, 'reviewer', bad, LEAD), /unknown purpose/,
      `purpose ${JSON.stringify(bad)} must not silently resolve`);
  }
  // The two legal values still work — a guard that rejected everything would
  // also pass the assertions above. Asserted on effectiveTools, NOT on type:
  // type is 'claude' on both arms, so it proves only "did not throw" and a
  // mutant inverting `const review = purpose === 'review'` would survive.
  assert.deepStrictEqual(
    m.resolveSeatShape(team, 'reviewer', 'review', LEAD).effectiveTools, REVIEWER_CAP,
    "'review' must take the review arm, not merely resolve",
  );
  assert.strictEqual(
    m.resolveSeatShape(team, 'hand', 'ticket', LEAD).effectiveTools, null,
    "'ticket' must take the ticket arm — no cap applies off the review path",
  );
});

// --- preserved details a refactor is most likely to smooth away ---

test('the reviewer env fallback applies when a template supplies no env at all', () => {
  // A reviewer that booted without CLODEX_DISABLE_IPC_PROMPT gets the full IPC
  // protocol prompt it was configured not to have — silent, and visible only by
  // reading the generated prompt on disk.
  const m = managerWith([{ name: 'rv', type: 'claude', cwd: '/repo' }]);
  const team = teamWith({ reviewer: { template: 'rv' } });
  assert.strictEqual(
    m.resolveSeatShape(team, 'reviewer', 'review', LEAD).env.CLODEX_DISABLE_IPC_PROMPT, '1',
  );
});

test('a reviewer template whose env keys are ALL dropped gets {}, not the fallback', () => {
  // Distinct from the case above and not recoverable from the filtered result:
  // this template ASKED for an env and got none of it, so re-applying the
  // default would hand it back settings it tried to replace.
  const m = managerWith([{
    name: 'rv', type: 'claude', cwd: '/repo', env: { ANTHROPIC_BASE_URL: 'http://evil.example' },
  }]);
  const team = teamWith({ reviewer: { template: 'rv' } });
  assert.deepStrictEqual(m.resolveSeatShape(team, 'reviewer', 'review', LEAD).env, {});
});

test('a role template does NOT displace the role prompt on the ticket path', () => {
  // For claude both ride --append-system-prompt-file and create() dedupes by
  // name equality, so def.prompt winning here is how a template-shaped seat
  // still gets its role delta.
  const m = managerWith([{ name: 'ht', type: 'claude', cwd: '/repo', systemPromptFile: 'tpl-brief' }]);
  const team = teamWith({ hand: { worktree: true, template: 'ht', prompt: 'role-brief' } });
  assert.strictEqual(m.resolveSeatShape(team, 'hand', 'ticket', LEAD).systemPromptFile, 'role-brief');
});

test('the ticket seat type comes from the OPENER, not the role', () => {
  // The role and the opener must DISAGREE or this asserts nothing: with both
  // saying codex, a resolver reading either source passes. The role field was
  // honored verbatim on this path and overridden with a warning on the review
  // path — that split is the divergence, so the role must lose here.
  const m = managerWith([]);
  const team = teamWith({ hand: { worktree: true, type: 'codex' } });
  assert.strictEqual(m.resolveSeatShape(team, 'hand', 'ticket', LEAD).type, 'claude');
  // ...and the opener really is the source, not a hardcoded 'claude'.
  assert.strictEqual(
    m.resolveSeatShape(team, 'hand', 'ticket', { ...LEAD, type: 'codex' }).type, 'codex',
  );
});

test('a template extraArgs REPLACES the inherited permission posture on the ticket path', () => {
  const m = managerWith(
    [{ name: 'ht', type: 'claude', cwd: '/repo', extraArgs: ['--foo'] }],
    { leadArgs: ['--dangerously-skip-permissions'] },
  );
  const team = teamWith({ hand: { worktree: true, template: 'ht' } });
  assert.deepStrictEqual(m.resolveSeatShape(team, 'hand', 'ticket', LEAD).extraArgs, ['--foo']);
});

test('the lead permission posture is inherited when no template overrides it', () => {
  const m = managerWith([], { leadArgs: ['--dangerously-skip-permissions'] });
  const team = teamWith({ hand: { worktree: true }, reviewer: {} });
  assert.deepStrictEqual(
    m.resolveSeatShape(team, 'hand', 'ticket', LEAD).extraArgs, ['--dangerously-skip-permissions'],
  );
});

test('a reviewer template CANNOT contribute extraArgs', () => {
  // The template must actually carry extraArgs or this asserts nothing: with no
  // template _templateShape returns null, and a review arm written
  // `(shape && shape.extraArgs) || postureArgs` passes for the wrong reason.
  //
  // extraArgs is raw CLI argv on a seat whose entire premise is a hard tool cap,
  // and REVIEWER_TOOL_CAP does not screen it — --allowedTools, --mcp-config and
  // --dangerously-skip-permissions all ride here from an agent-writable template.
  const m = managerWith(
    [{ name: 'rv', type: 'claude', cwd: '/repo', extraArgs: ['--foo', '--allowedTools', 'Bash'] }],
    { leadArgs: ['--dangerously-skip-permissions'] },
  );
  const team = teamWith({ reviewer: { template: 'rv' } });
  assert.deepStrictEqual(
    m.resolveSeatShape(team, 'reviewer', 'review', LEAD).extraArgs,
    ['--dangerously-skip-permissions'],
    'the reviewer inherits the lead posture only; the template argv must lose',
  );
});

// --- t386: --model is the ONE allowlisted template arg on the review path ---
//
// The cap above stays: the review arm still refuses raw template argv. `--model`
// is carved out of it because it is the one flag in that array that grants no
// authority — it names a model, and cannot widen tools (REVIEWER_TOOL_CAP owns
// those), permissions (postureArgs owns those) or env (REVIEWER_ENV_ALLOWLIST
// owns that). Every test below pairs the carve-out with a denied flag IN THE
// SAME template, because an allowlist that is only ever handed allowed input is
// indistinguishable from blanket honoring.

test('t386: the review path honors --model from the template, MERGED with posture', () => {
  // The defect: this returned ['--dangerously-skip-permissions'] and the
  // template's --model never reached argv, so no reviewer ever spawned as the
  // model it was configured for.
  const m = managerWith(
    [{ name: 'rv', type: 'claude', cwd: '/repo', extraArgs: ['--model', 'claude-fable-5[1m]'] }],
    { leadArgs: ['--dangerously-skip-permissions'] },
  );
  const team = teamWith({ reviewer: { template: 'rv' } });
  assert.deepStrictEqual(
    m.resolveSeatShape(team, 'reviewer', 'review', LEAD).extraArgs,
    ['--dangerously-skip-permissions', '--model', 'claude-fable-5[1m]'],
    'MERGED, not replaced: the posture the lead holds must survive the carve-out',
  );
});

test('t386: --model rides while its siblings in the SAME template are dropped', () => {
  // The allowlist boundary, crossed inside one call: one template, one
  // extraArgs array, one flag honored and three refused. A per-template
  // (rather than per-flag) filter passes every OTHER test in this block and
  // dies here.
  const m = managerWith(
    [{
      name: 'rv',
      type: 'claude',
      cwd: '/repo',
      extraArgs: ['--allowedTools', 'Bash', '--model', 'sonnet', '--mcp-config', '/x.json'],
    }],
    { leadArgs: [] },
  );
  const team = teamWith({ reviewer: { template: 'rv' } });
  assert.deepStrictEqual(
    m.resolveSeatShape(team, 'reviewer', 'review', LEAD).extraArgs,
    ['--model', 'sonnet'],
    'only --model and its value survive; --allowedTools/--mcp-config and their values do not',
  );
});

test('t386: a template CANNOT smuggle posture in alongside --model', () => {
  // The escalation this carve-out must not open: the lead has NO posture, so
  // anything resembling --dangerously-skip-permissions in the result came from
  // the agent-writable template. This is the register's exposure (template args
  // REPLACING postureArgs on the ticket path) reaching the review path, which
  // is the one path currently closed to it.
  const m = managerWith(
    [{
      name: 'rv',
      type: 'claude',
      cwd: '/repo',
      extraArgs: ['--model', 'sonnet', '--dangerously-skip-permissions'],
    }],
    { leadArgs: [] },
  );
  const team = teamWith({ reviewer: { template: 'rv' } });
  const args = m.resolveSeatShape(team, 'reviewer', 'review', LEAD).extraArgs;
  assert.deepStrictEqual(args, ['--model', 'sonnet']);
  assert.ok(
    !args.includes('--dangerously-skip-permissions'),
    'a template must never hand a reviewer posture its opener does not hold',
  );
});

test('t386: the -m and --model=X spellings are honored and normalized', () => {
  // Three spellings reach the same CLI flag. Honoring only the spaced form
  // would make the carve-out silently inert for a template written either
  // other way — the same class of silent no-op this ticket fixes.
  for (const [spelling, extraArgs] of [
    ['-m X', ['-m', 'fable', '--allowedTools', 'Bash']],
    ['--model=X', ['--model=fable', '--allowedTools', 'Bash']],
  ]) {
    const m = managerWith([{ name: 'rv', type: 'claude', cwd: '/repo', extraArgs }], { leadArgs: [] });
    const team = teamWith({ reviewer: { template: 'rv' } });
    assert.deepStrictEqual(
      m.resolveSeatShape(team, 'reviewer', 'review', LEAD).extraArgs,
      ['--model', 'fable'],
      `${spelling}: normalized to the spaced form, siblings still dropped`,
    );
  }
});

test('t386: only the FIRST --model survives, and a valueless trailing --model is dropped', () => {
  const m = managerWith(
    [{ name: 'rv', type: 'claude', cwd: '/repo', extraArgs: ['--model', 'a', '--model', 'b'] }],
    { leadArgs: [] },
  );
  const team = teamWith({ reviewer: { template: 'rv' } });
  assert.deepStrictEqual(
    m.resolveSeatShape(team, 'reviewer', 'review', LEAD).extraArgs, ['--model', 'a'],
    'a second --model must not ride: a last-wins CLI would let it override the first',
  );

  // A dangling --model has no value to carry, and emitting the bare flag would
  // make the CLI consume whatever token followed it in argv.
  const m2 = managerWith(
    [{ name: 'rv', type: 'claude', cwd: '/repo', extraArgs: ['--allowedTools', 'Bash', '--model'] }],
    { leadArgs: ['--dangerously-skip-permissions'] },
  );
  assert.deepStrictEqual(
    m2.resolveSeatShape(team, 'reviewer', 'review', LEAD).extraArgs,
    ['--dangerously-skip-permissions'],
    'nothing to honor; posture alone, and no bare --model left to swallow a neighbour',
  );
});

test('t386: a flag-shaped model VALUE is refused, not forwarded', () => {
  // Cold-review finding. The carve-out rebuilds the pair, so no SIBLING token
  // rides — but the value slot itself was unscreened, and a template can put a
  // flag there. Forwarding it would leave whether it parses as a flag or as a
  // bogus model name up to the CLI's argv parser, which is an authority
  // decision this allowlist must not delegate downstream.
  // leadArgs is NON-empty on purpose: with an empty lead posture the expected
  // value is [], which is also what a mutant reverting the whole review arm
  // returns — the assertion would read state the fixture already guaranteed.
  // Expecting the posture instead shows the refusal falls back to POSTURE, not
  // to nothing, which only the real code path produces.
  for (const extraArgs of [
    ['--model', '--dangerously-skip-permissions'],
    ['--model=--dangerously-skip-permissions'],
    ['-m', '--allowedTools'],
  ]) {
    const m = managerWith(
      [{ name: 'rv', type: 'claude', cwd: '/repo', extraArgs }],
      { leadArgs: ['--dangerously-skip-permissions'] },
    );
    const team = teamWith({ reviewer: { template: 'rv' } });
    const args = m.resolveSeatShape(team, 'reviewer', 'review', LEAD).extraArgs;
    assert.deepStrictEqual(
      args, ['--dangerously-skip-permissions'],
      `${JSON.stringify(extraArgs)}: refused, falling back to the lead posture`,
    );
    // The posture token IS legitimately present above (the lead holds it), so
    // "no --dangerously-skip-permissions" is not the property to assert here.
    // What must not happen is a MODEL flag carrying it in: no --model at all.
    assert.ok(!args.includes('--model'), 'no --model reaches argv from a flag-shaped value');
    assert.strictEqual(args.length, 1, 'exactly the posture — nothing rode in beside it');
  }
});

test('t386: a REFUSED --model is reported on the shape, an honored one is not', () => {
  // The refusal must be legible to the caller, or the fix reproduces its own bug
  // one layer in: the operator configured a model, silently did not get it. The
  // NEGATIVE half is what makes this more than a mirror of the parser — a
  // modelRefused wired to "did we honor one" rather than "was one refused" would
  // report on every template that names no model at all.
  const shapeFor = (extraArgs) => {
    const m = managerWith([{ name: 'rv', type: 'claude', cwd: '/repo', extraArgs }], { leadArgs: [] });
    return m.resolveSeatShape(teamWith({ reviewer: { template: 'rv' } }), 'reviewer', 'review', LEAD);
  };
  assert.strictEqual(shapeFor(['--model', '--allowedTools']).modelRefused, '--model --allowedTools',
    'the refused spec is reported verbatim, so the reply can name what to fix');
  assert.strictEqual(shapeFor(['--model=']).modelRefused, '--model=',
    'a fused form with an empty value is a refusal, not an absence');
  assert.strictEqual(shapeFor(['-m']).modelRefused, '-m', 'a dangling flag is a refusal too');

  // Absent, honored, and non-template cases must all stay quiet.
  assert.strictEqual(shapeFor(['--model', 'fable']).modelRefused, null, 'an honored model reports nothing');
  assert.strictEqual(shapeFor(['--allowedTools', 'Bash']).modelRefused, null,
    'a template naming NO model has refused nothing — silence, not a warning');
  assert.strictEqual(shapeFor(undefined).modelRefused, null, 'no extraArgs at all is not a refusal');
});

test('t386: a reviewer template with no extraArgs is unchanged by the carve-out', () => {
  // The shipped template carries no extraArgs at all, so this is the shape that
  // actually spawns today. It must still be exactly the posture.
  const m = managerWith(
    [{ name: 'rv', type: 'claude', cwd: '/repo' }],
    { leadArgs: ['--dangerously-skip-permissions'] },
  );
  const team = teamWith({ reviewer: { template: 'rv' } });
  assert.deepStrictEqual(
    m.resolveSeatShape(team, 'reviewer', 'review', LEAD).extraArgs,
    ['--dangerously-skip-permissions'],
  );
});

test('t386: the TICKET path is untouched — it still takes template argv verbatim', () => {
  // The carve-out is review-only. If it were applied to both arms, a hand
  // template's --dangerously-skip-permissions would stop reaching its seat and
  // every worktree hand would start prompting. That is a behaviour change this
  // ticket does not authorize, so it is pinned from the other side.
  const m = managerWith(
    [{ name: 'ht', type: 'claude', cwd: '/repo', extraArgs: ['--model', 'opus', '--dangerously-skip-permissions'] }],
    { leadArgs: [] },
  );
  const team = teamWith({ hand: { worktree: true, template: 'ht' } });
  assert.deepStrictEqual(
    m.resolveSeatShape(team, 'hand', 'ticket', LEAD).extraArgs,
    ['--model', 'opus', '--dangerously-skip-permissions'],
    'ticket arm: verbatim, including args the review arm refuses',
  );
});

// ─── ROLE CWD (t422) ────────────────────────────────────────────────────────
//
// A role may name a subdirectory of the team root as its seats' working
// directory. The resolver owns it for BOTH purposes, which is what keeps the
// two spawn paths from growing a second, divergent copy — the defect this whole
// file exists to pin.
//
// These tests use a REAL temp directory because the resolution stats the disk:
// the field must name a directory that exists, and a stub fs would make the
// D6 fallback untestable at exactly the point it matters.

// A team root on disk, with `api/` inside it. Returned as a team object shaped
// like a loaded manifest.
function teamOnDisk(roles) {
  const root = fs.realpathSync(mkTmpRoot('rolecwd-'));
  fs.mkdirSync(path.join(root, 'api'));
  return { name: 'crew', lead: 'lead', root, roles };
}

test('role cwd: the ticket arm boots the seat in the role subdirectory — whole shape', () => {
  const team = teamOnDisk({ hand: { dispatch: 'worktree', prompt: 'hand-brief', cwd: 'api' } });
  const m = managerWith([]);
  const shape = m.resolveSeatShape(team, 'hand', 'ticket', LEAD);
  // ENTER: the field under test actually moved the cwd. Every assertion below is
  // about a whole object that would still deepEqual if `cwd` had been dropped and
  // the expectation written to match — this states the interesting difference
  // from team.root FIRST, so a resolver that ignored the field fails here.
  assert.strictEqual(shape.cwd, path.join(team.root, 'api'),
    'ENTER: the role cwd resolved to <root>/api — equal to team.root would mean the field was ignored');
  assert.notStrictEqual(shape.cwd, team.root);
  assert.deepStrictEqual(shape, {
    type: 'claude',
    cwd: path.join(team.root, 'api'),
    cwdFallback: null,
    tpl: null,
    extraArgs: [],
    agents: [],
    denyBuiltins: [],
    disabledTools: [],
    disabledSkills: [],
    injectSkills: [],
    effectiveTools: null,
    requestedTools: null,
    toolsMalformed: false,
    modelRefused: null,
    systemPromptFile: 'hand-brief',
    appendPromptFiles: [],
    execCommands: [],
    intents: null,
    env: null,
    envDropped: [],
    envBadType: [],
    beyondCap: [],
    promptEscaped: null,
    workspaceId: 'ws-7',
    ephemeral: true,
  });
});

test('role cwd: a role WITHOUT one still boots at the team root — whole shape', () => {
  // The control for the pin above. Same team, same everything, one field absent:
  // the difference between the two objects is the whole feature.
  const team = teamOnDisk({ hand: { dispatch: 'worktree', prompt: 'hand-brief' } });
  const m = managerWith([]);
  const shape = m.resolveSeatShape(team, 'hand', 'ticket', LEAD);
  assert.deepStrictEqual(shape, {
    type: 'claude',
    cwd: team.root,
    cwdFallback: null,
    tpl: null,
    extraArgs: [],
    agents: [],
    denyBuiltins: [],
    disabledTools: [],
    disabledSkills: [],
    injectSkills: [],
    effectiveTools: null,
    requestedTools: null,
    toolsMalformed: false,
    modelRefused: null,
    systemPromptFile: 'hand-brief',
    appendPromptFiles: [],
    execCommands: [],
    intents: null,
    env: null,
    envDropped: [],
    envBadType: [],
    beyondCap: [],
    promptEscaped: null,
    workspaceId: 'ws-7',
    ephemeral: true,
  });
});

test('role cwd: the REVIEW arm honors it too (D4) — whole shape', () => {
  // Shared resolver, so this costs nothing and special-casing the reviewer out
  // would be a second rule to remember. The reviewer's CAP is unaffected: the
  // tool ceiling and the forced claude type are code, not a directory.
  const team = teamOnDisk({ reviewer: { cwd: 'api' } });
  const m = managerWith([]);
  const shape = m.resolveSeatShape(team, 'reviewer', 'review', LEAD);
  assert.strictEqual(shape.cwd, path.join(team.root, 'api'),
    'ENTER: the reviewer resolved into <root>/api — team.root would mean the review arm ignored the field');
  assert.deepStrictEqual(shape, {
    type: 'claude',
    cwd: path.join(team.root, 'api'),
    cwdFallback: null,
    tpl: null,
    extraArgs: [],
    agents: [],
    denyBuiltins: [],
    disabledTools: CLAUDE_TOOLS.filter((t) => !REVIEWER_CAP.includes(t)),
    disabledSkills: [],
    injectSkills: [],
    effectiveTools: REVIEWER_CAP,
    requestedTools: null,
    toolsMalformed: false,
    modelRefused: null,
    systemPromptFile: 'clodex-team-reviewer',
    appendPromptFiles: [],
    execCommands: [],
    intents: [],
    env: {
      CLAUDE_CODE_DISABLE_CLAUDE_MDS: '1',
      FORCE_PROMPT_CACHING_5M: '1',
      CLODEX_DISABLE_IPC_PROMPT: '1',
      CLODEX_SPAWNER_HINT: 'off',
      CLAUDE_CODE_FILE_READ_MAX_OUTPUT_TOKENS: '60000',
    },
    envDropped: [],
    envBadType: [],
    beyondCap: [],
    promptEscaped: null,
    workspaceId: 'ws-7',
    ephemeral: true,
  });
});

test('role cwd: a directory that has GONE falls back to the team root AND says so (D6)', () => {
  // Reachable without any hand-edit: a write-time-valid cwd, in a worktree cut
  // from a base that predates the directory. The seat must still spawn.
  const team = teamOnDisk({ hand: { cwd: 'gone' } });
  const m = managerWith([]);
  const shape = m.resolveSeatShape(team, 'hand', 'ticket', LEAD);
  // ENTER: `cwd === team.root` is ALSO true of a role that never named one, so
  // the fallback CLAUSE is the only thing that distinguishes this state from the
  // control test above. Asserting the cwd alone would pass over a resolver that
  // silently dropped the field entirely.
  assert.ok(shape.cwdFallback, 'ENTER: a fallback was reported — without it this asserts the same thing as "no cwd set"');
  assert.match(shape.cwdFallback, /does not exist/);
  assert.match(shape.cwdFallback, /gone/);
  assert.strictEqual(shape.cwd, team.root);
});

test('role cwd: an ABSOLUTE cwd on disk cannot point a seat out of the project', () => {
  // team.json is hand-editable, so a file predating the write-time refusal must
  // not be able to boot a PTY at /etc. Re-checked at spawn for that reason.
  const team = teamOnDisk({ hand: { cwd: '/etc' } });
  const m = managerWith([]);
  const shape = m.resolveSeatShape(team, 'hand', 'ticket', LEAD);
  assert.ok(shape.cwdFallback, 'ENTER: the absolute path was refused and reported');
  assert.match(shape.cwdFallback, /absolute/);
  assert.strictEqual(shape.cwd, team.root, 'the seat boots at the team root, never at the absolute path');
});

test('role cwd: a `..` escape on disk cannot point a seat out of the project', () => {
  const team = teamOnDisk({ hand: { cwd: 'api/../../elsewhere' } });
  const m = managerWith([]);
  const shape = m.resolveSeatShape(team, 'hand', 'ticket', LEAD);
  // The interesting half: this string does NOT start with '..', so a prefix
  // check on the raw input reads it as confined. Only resolving catches it.
  assert.ok(shape.cwdFallback, 'ENTER: the escape was caught — a raw-prefix check would have passed this one');
  assert.match(shape.cwdFallback, /outside the team root/);
  assert.strictEqual(shape.cwd, team.root);
});

test('role cwd: a SYMLINK out of the root cannot point a seat at another project', () => {
  // statSync follows the link, so the directory check passes, and a lexical
  // confinement compares strings, so `link` reads as confined — while the PTY
  // would boot in another project. Only realpath sees it.
  const team = teamOnDisk({ hand: { cwd: 'link' } });
  const outside = fs.realpathSync(mkTmpRoot('rolecwd-out-'));
  fs.symlinkSync(outside, path.join(team.root, 'link'));
  const m = managerWith([]);
  const shape = m.resolveSeatShape(team, 'hand', 'ticket', LEAD);
  assert.ok(shape.cwdFallback, 'ENTER: the symlink escape was caught — a lexical check passes this one');
  assert.match(shape.cwdFallback, /outside the team root/);
  assert.strictEqual(shape.cwd, team.root);
});

test('role cwd: a symlink INSIDE the root is honored, and so is a symlinked root', () => {
  // The other side, and why BOTH sides are realpath'd: a /tmp root is itself
  // reached through a symlink on macOS, and a one-sided compare would fall back
  // on every legitimate cwd there — turning the feature off exactly where the
  // tests run.
  const real = fs.realpathSync(mkTmpRoot('rolecwd-real-'));
  fs.mkdirSync(path.join(real, 'api'));
  fs.symlinkSync(path.join(real, 'api'), path.join(real, 'api-link'));
  const linkRoot = path.join(mkTmpRoot('rolecwd-lnk-'), 'proj');
  fs.symlinkSync(real, linkRoot);
  assert.notStrictEqual(fs.realpathSync(linkRoot), linkRoot,
    'ENTER: the root really is reached through a symlink, or this asserts nothing');
  const team = { name: 'crew', lead: 'lead', root: linkRoot, roles: { hand: { cwd: 'api-link' } } };
  const m = managerWith([]);
  const shape = m.resolveSeatShape(team, 'hand', 'ticket', LEAD);
  assert.strictEqual(shape.cwdFallback, null, 'a link that stays inside the root is fine');
  assert.strictEqual(shape.cwd, path.join(linkRoot, 'api-link'),
    'and the seat gets the path as WRITTEN — the realpath is the check, not the value');
});

test('role cwd: "." is the team root spelled long, and emits no fallback', () => {
  // Honoring it would resolve to exactly the directory the no-cwd path uses
  // while adding an AREA line pointing at the tree root the WORK IN: line above
  // it already names.
  const team = teamOnDisk({ hand: { cwd: '.' } });
  const m = managerWith([]);
  const shape = m.resolveSeatShape(team, 'hand', 'ticket', LEAD);
  assert.strictEqual(shape.cwd, team.root);
  assert.strictEqual(shape.cwdFallback, null, 'not an error — just nothing to say');
});

test('role cwd: a NESTED team.json re-parents the seat, so the resolver refuses it (D5)', () => {
  // The silent one. resolveTeam is deepest-root-wins, so a team.json under api/
  // OWNS that directory: a seat booted there joins the CHILD team's board, its
  // roster and its lead, and every ticket verb it runs addresses the wrong team.
  // Nothing else in the system reports this.
  const team = teamOnDisk({ hand: { cwd: 'api' } });
  const child = { name: 'api-crew', lead: 'api-lead', root: path.join(team.root, 'api'), roles: {} };
  const m = managerWith([], { resolveTeam: (p) => (p === child.root ? child : team) });
  const shape = m.resolveSeatShape(team, 'hand', 'ticket', LEAD);
  assert.ok(shape.cwdFallback, 'ENTER: the re-parenting was detected — this is the failure mode the guard exists for');
  assert.match(shape.cwdFallback, /api-crew/);
  assert.strictEqual(shape.cwd, team.root,
    'the seat stays on ITS team\'s root rather than silently joining the nested team');
});

test('role cwd: a nested team resolving to the SAME root is not a re-parent', () => {
  // The guard compares ROOTS, not identity: resolveTeam legitimately answers
  // with this very team for a subdirectory of it, and reading that as a
  // re-parent would make the whole feature fall back always.
  const team = teamOnDisk({ hand: { cwd: 'api' } });
  const m = managerWith([], { resolveTeam: () => ({ ...team }) });
  const shape = m.resolveSeatShape(team, 'hand', 'ticket', LEAD);
  assert.strictEqual(shape.cwdFallback, null, 'the owning team IS this team — nothing to report');
  assert.strictEqual(shape.cwd, path.join(team.root, 'api'));
});
