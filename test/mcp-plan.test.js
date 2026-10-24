'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const {
  MCP_NAME_RE, mcpNameError, validateMcpEntry, secretRefs, resolveMcpEntry,
  claudeMcpServers, mcpArgvPlan, mcpDigest, digestShape, mcpServerOf, mcpLeaks, discoverMcpSources, normaliseDiscovered,
  tomlString, codexMcpArgs,
} = require('../mcp-plan');
const { mkTmpRoot } = require('./lib/tmp-roots');

test('MCP_NAME_RE: the server-name grammar, row by row', () => {
  const rows = [
    ['jira', true], ['two_words', true], ['a-b', true], ['A1', true], ['x'.repeat(64), true],
    ['a__b', false], ['__a', false], ['a__', false], ['a.b', false], ['', false], ['_a', false],
    ['-a', false], ['a b', false], ['a/b', false], ['x'.repeat(65), false],
  ];
  for (const [name, ok] of rows) assert.strictEqual(MCP_NAME_RE.test(name), ok, name);
});

test('mcpNameError: reserved names are refused even though the grammar admits them', () => {
  assert.strictEqual(MCP_NAME_RE.test('clodex'), true);
  assert.strictEqual(MCP_NAME_RE.test('claude_design'), true);
  assert.strictEqual(mcpNameError('clodex'), 'reserved MCP server name: clodex');
  assert.strictEqual(mcpNameError('claude_design'), 'reserved MCP server name: claude_design');
  assert.strictEqual(mcpNameError('a__b'), 'invalid MCP server name: a__b');
  assert.strictEqual(mcpNameError('a.b'), 'invalid MCP server name: a.b');
  assert.strictEqual(mcpNameError('jira'), null);
});

test('validateMcpEntry: shape rows', () => {
  const rows = [
    [{ command: 'npx' }, true],
    [{ type: 'stdio', command: 'npx', args: ['-y', 'x'], env: { A: '1' }, cwd: '/tmp' }, true],
    [{ type: 'http', url: 'https://x/mcp' }, true],
    [{ type: 'sse', url: 'https://x/sse', headers: { 'X-Trace': 'on' } }, true],
    [{ command: 'npx', platforms: ['claude', 'muse'], tags: ['a'], description: 'd' }, true],
    [{}, false],
    [{ type: 'stdio' }, false],
    [{ type: 'http' }, false],
    [{ type: 'ws', url: 'x' }, false],
    [{ command: 'npx', args: [1] }, false],
    [{ command: 'npx', env: { A: 1 } }, false],
    [{ command: 'npx', platforms: ['vim'] }, false],
    [null, false],
    [['npx'], false],
  ];
  for (const [entry, ok] of rows) assert.strictEqual(validateMcpEntry(entry).ok, ok, JSON.stringify(entry));
});

test('validateMcpEntry: the literal-secret lint names the key, case-insensitive on headers', () => {
  const rows = [
    [{ type: 'http', url: 'u', headers: { Authorization: 'Bearer abc123' } }, 'header Authorization'],
    [{ type: 'http', url: 'u', headers: { authorization: 'abc123' } }, 'header authorization'],
    [{ type: 'http', url: 'u', headers: { 'X-API-Key': 'abc' } }, 'header X-API-Key'],
    [{ type: 'http', url: 'u', headers: { 'x-apikey': 'abc' } }, 'header x-apikey'],
    [{ type: 'sse', url: 'u', headers: { 'X-Auth-Token': 'abc' } }, 'header X-Auth-Token'],
    [{ command: 'c', env: { JIRA_TOKEN: 'hunter2' } }, 'env JIRA_TOKEN'],
    [{ command: 'c', env: { db_password: 'pw' } }, 'env db_password'],
    [{ command: 'c', env: { OPENAI_API_KEY: 'sk' } }, 'env OPENAI_API_KEY'],
    [{ command: 'c', env: { CLIENT_SECRET: 's' } }, 'env CLIENT_SECRET'],
  ];
  for (const [entry, key] of rows) {
    const r = validateMcpEntry(entry);
    assert.strictEqual(r.ok, false, key);
    assert.ok(r.errors.some((e) => e.startsWith(key)), `${key}: ${JSON.stringify(r.errors)}`);
  }
  const clean = [
    { type: 'http', url: 'u', headers: { Authorization: 'Bearer ${ATL}' } },
    { type: 'http', url: 'u', headers: { Authorization: '${ATL}' } },
    { type: 'http', url: 'u', headers: { 'X-Trace': 'literal-ok' } },
    { command: 'c', env: { JIRA_TOKEN: '${JIRA_TOKEN}', JIRA_URL: 'https://x' } },
  ];
  for (const entry of clean) assert.deepStrictEqual(validateMcpEntry(entry), { ok: true, errors: [] }, JSON.stringify(entry));
});

test('secretRefs: every ${NAME} in env, headers, url and args, sorted and unique', () => {
  const entry = {
    type: 'http', url: 'https://${HOST}/mcp', headers: { Authorization: 'Bearer ${TOK}', X: '${TOK}' },
    env: { A: '${ENV_A}' }, args: ['--k', '${ARG_B}'],
  };
  assert.deepStrictEqual(secretRefs(entry), ['ARG_B', 'ENV_A', 'HOST', 'TOK']);
  assert.deepStrictEqual(secretRefs({ command: 'x' }), []);
});

test('resolveMcpEntry: substitutes from env; a missing or empty var omits the server', () => {
  const entry = { command: 'npx', args: ['-y', 'jira'], env: { JIRA_TOKEN: '${JIRA_TOKEN}', JIRA_URL: '${JIRA_URL}' }, description: 'd' };
  assert.deepStrictEqual(resolveMcpEntry(entry, { JIRA_TOKEN: 't0k', JIRA_URL: 'https://j' }), {
    resolved: { type: 'stdio', command: 'npx', args: ['-y', 'jira'], env: { JIRA_TOKEN: 't0k', JIRA_URL: 'https://j' } },
    missing: [],
  });
  assert.deepStrictEqual(resolveMcpEntry(entry, { JIRA_URL: 'https://j' }), { resolved: null, missing: ['JIRA_TOKEN'] });
  assert.deepStrictEqual(resolveMcpEntry(entry, { JIRA_TOKEN: '', JIRA_URL: 'https://j' }), { resolved: null, missing: ['JIRA_TOKEN'] });
  const http = { type: 'http', url: 'https://x/${P}', headers: { Authorization: 'Bearer ${T}' } };
  assert.deepStrictEqual(resolveMcpEntry(http, { P: 'mcp', T: 'z' }).resolved,
    { type: 'http', url: 'https://x/mcp', headers: { Authorization: 'Bearer z' } });
});

const LIB = [
  { name: 'jira', entry: { command: 'npx', args: ['jira'], env: { JIRA_TOKEN: '${JIRA_TOKEN}' } } },
  { name: 'docs', entry: { type: 'http', url: 'https://docs/mcp' } },
  { name: 'codexonly', entry: { command: 'c', platforms: ['codex'] } },
];

test('claudeMcpServers: unknown, platform-excluded and unresolved names warn and are absent', () => {
  const r = claudeMcpServers({ selected: ['jira', 'docs', 'ghost', 'codexonly'], library: LIB, env: {}, cli: 'claude' });
  assert.deepStrictEqual(Object.keys(r.servers), ['docs']);
  assert.deepStrictEqual(r.warnings, [
    'MCP jira: not loaded — JIRA_TOKEN is not set (Preferences ▸ Environment)',
    'MCP ghost: not in the library',
    'MCP codexonly: not available on claude',
  ]);
  assert.deepStrictEqual(r.applied.names, ['docs']);
  assert.match(r.applied.digest, /^[0-9a-f]{64}$/);
});

test('claudeMcpServers: a resolved selection lands every server with its values', () => {
  const r = claudeMcpServers({ selected: ['jira', 'docs'], library: LIB, env: { JIRA_TOKEN: 's3cret' }, cli: 'claude' });
  assert.deepStrictEqual(r.servers, {
    jira: { type: 'stdio', command: 'npx', args: ['jira'], env: { JIRA_TOKEN: 's3cret' } },
    docs: { type: 'http', url: 'https://docs/mcp' },
  });
  assert.deepStrictEqual(r.warnings, []);
  assert.deepStrictEqual(r.applied.names, ['docs', 'jira']);
});

test('claudeMcpServers: the digest ignores secret values and moves with the shape', () => {
  const at = (env, lib = LIB) => claudeMcpServers({ selected: ['jira', 'docs'], library: lib, env }).applied.digest;
  const base = at({ JIRA_TOKEN: 'one' });
  assert.strictEqual(at({ JIRA_TOKEN: 'two' }), base);
  assert.ok(!base.includes('one'));
  const changed = [{ ...LIB[0], entry: { ...LIB[0].entry, args: ['jira', '--v2'] } }, LIB[1]];
  assert.notStrictEqual(at({ JIRA_TOKEN: 'one' }, changed), base);
  assert.notStrictEqual(claudeMcpServers({ selected: ['docs'], library: LIB, env: {} }).applied.digest, base);
});

test('validateMcpEntry: denyTools rows, each refusal naming the field', () => {
  const rows = [
    [['createJiraIssue', 'edit-page'], true],
    [[], true],
    [['a__b'], false],
    [['__a'], false],
    [['create issue'], false],
    [['tab\tname'], false],
    [['foo(x)'], false],
    [['a.b'], false],
    [['mcp__*'], false],
    [[''], false],
    [[7], false],
    ['createJiraIssue', false],
    [{ a: 'b' }, false],
  ];
  for (const [denyTools, ok] of rows) {
    const r = validateMcpEntry({ type: 'http', url: 'https://x/mcp', denyTools });
    assert.strictEqual(r.ok, ok, JSON.stringify(denyTools));
    if (!ok) assert.deepStrictEqual(r.errors, ['denyTools must be an array of tool names of letters, digits, _ and -, without __']);
  }
});

const DENY_LIB = [
  { name: 'atlassian', entry: { type: 'http', url: 'https://mcp.atlassian.com/v2/mcp', denyTools: ['createJiraIssue', 'editJiraIssue'] } },
  { name: 'jira', entry: { command: 'npx', env: { JIRA_TOKEN: '${JIRA_TOKEN}' }, denyTools: ['transitionJiraIssue'] } },
  { name: 'docs', entry: { type: 'http', url: 'https://docs/mcp' } },
];

test('claudeMcpServers: denyRules prefix every denied tool of a loaded server; an omitted server contributes none', () => {
  const r = claudeMcpServers({ selected: ['atlassian', 'jira', 'docs'], library: DENY_LIB, env: {}, cli: 'claude' });
  assert.deepStrictEqual(r.applied.names, ['atlassian', 'docs']);
  assert.deepStrictEqual(r.applied.denyRules, ['mcp__atlassian__createJiraIssue', 'mcp__atlassian__editJiraIssue']);
  assert.deepStrictEqual(r.applied.denied, { atlassian: ['createJiraIssue', 'editJiraIssue'] });
  assert.strictEqual('denyTools' in r.servers.atlassian, false);
  const loaded = claudeMcpServers({ selected: ['atlassian', 'jira'], library: DENY_LIB, env: { JIRA_TOKEN: 't' }, cli: 'claude' });
  assert.deepStrictEqual(loaded.applied.denyRules,
    ['mcp__atlassian__createJiraIssue', 'mcp__atlassian__editJiraIssue', 'mcp__jira__transitionJiraIssue']);
  const none = claudeMcpServers({ selected: ['docs'], library: DENY_LIB, env: {}, cli: 'claude' });
  assert.deepStrictEqual(none.applied, { names: ['docs'], digest: none.applied.digest, denyRules: [] });
});

test('claudeMcpServers: cli codex computes the same denyRules for the codex arm to map', () => {
  const claude = claudeMcpServers({ selected: ['atlassian', 'jira'], library: DENY_LIB, env: { JIRA_TOKEN: 't' }, cli: 'claude' });
  const codex = claudeMcpServers({ selected: ['atlassian', 'jira'], library: DENY_LIB, env: { JIRA_TOKEN: 't' }, cli: 'codex' });
  assert.deepStrictEqual(codex.applied.denyRules,
    ['mcp__atlassian__createJiraIssue', 'mcp__atlassian__editJiraIssue', 'mcp__jira__transitionJiraIssue']);
  assert.deepStrictEqual(codex.applied.denyRules, claude.applied.denyRules);
});

test('claudeMcpServers: the digest moves when denyTools changes and matches digestShape', () => {
  const at = (deny) => claudeMcpServers({
    selected: ['atlassian'], library: [{ name: 'atlassian', entry: { ...DENY_LIB[0].entry, denyTools: deny } }], env: {},
  }).applied.digest;
  const base = at(['createJiraIssue']);
  assert.notStrictEqual(at(['createJiraIssue', 'editJiraIssue']), base);
  assert.notStrictEqual(at(undefined), base);
  assert.strictEqual(at([]), at(undefined));
  assert.strictEqual(at(['editJiraIssue', 'createJiraIssue', 'editJiraIssue']), at(['createJiraIssue', 'editJiraIssue']));
  assert.strictEqual(base, mcpDigest({ atlassian: digestShape({ ...DENY_LIB[0].entry, denyTools: ['createJiraIssue'] }) }));
});

test('mcpArgvPlan: three arms with the exact push arrays; both user arms are unmanaged', () => {
  const P = '/run/seat/mcp.json';
  assert.deepStrictEqual(mcpArgvPlan({ userMcp: false, userStrict: false, mcpPath: P }),
    { push: ['--strict-mcp-config', '--mcp-config', P], writeConfig: true, unmanaged: false, notice: null });
  assert.deepStrictEqual(mcpArgvPlan({ userMcp: true, userStrict: false, mcpPath: P }), {
    push: [], writeConfig: false, unmanaged: true,
    notice: "MCP: the clodex MCP tools are not available to this session — the seat's extra args carry their own --mcp-config.",
  });
  assert.deepStrictEqual(mcpArgvPlan({ userMcp: true, userStrict: true, mcpPath: P }), mcpArgvPlan({ userMcp: true, userStrict: false, mcpPath: P }));
  assert.deepStrictEqual(mcpArgvPlan({ userMcp: false, userStrict: true, mcpPath: P }), {
    push: [], writeConfig: false, unmanaged: true,
    notice: "MCP: the clodex MCP tools are not available to this session — the seat's extra args carry --strict-mcp-config with no config, which is the empty set.",
  });
});

test('mcpLeaks: roster servers outside {implicit} ∪ selection, first-seen order', () => {
  assert.deepStrictEqual(mcpLeaks({ rosterServers: ['clodex', 'jira'], selected: ['jira'] }), []);
  assert.deepStrictEqual(mcpLeaks({ rosterServers: ['clodex', 'claude_design', 'jira', 'claude_design'], selected: [] }), ['claude_design', 'jira']);
  assert.deepStrictEqual(mcpLeaks({ rosterServers: ['clodex'], selected: [], implicit: [] }), ['clodex']);
  assert.deepStrictEqual(mcpLeaks({}), []);
});

test('mcpServerOf: the same lazy grammar as the renderer copy', () => {
  assert.strictEqual(mcpServerOf('mcp__jira__search'), 'jira');
  assert.strictEqual(mcpServerOf('mcp__two_words__pong'), 'two_words');
  assert.strictEqual(mcpServerOf('mcp__has__dunder__ping'), 'has');
  assert.strictEqual(mcpServerOf('Read'), null);
  const leaf = fs.readFileSync(path.join(__dirname, '..', 'mcp-plan.js'), 'utf8');
  const renderer = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'lib', 'mcp-group.js'), 'utf8');
  const lit = (src) => (src.match(/const MCP_TOOL_RE = (\/.*\/);/) || [])[1];
  assert.ok(lit(leaf), 'leaf literal found');
  assert.strictEqual(lit(leaf), lit(renderer));
});

test('discoverMcpSources: user, local and project scopes from a fixture home and cwd', () => {
  const root = mkTmpRoot('clodex-mcp-disc-');
  const home = path.join(root, 'home');
  const cwd = path.join(root, 'proj');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(cwd, { recursive: true });
  fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({
    mcpServers: { jira: { command: 'npx' } },
    projects: { [cwd]: { mcpServers: { local1: { type: 'http', url: 'u' } } }, '/other': { mcpServers: { nope: { command: 'x' } } } },
  }));
  fs.writeFileSync(path.join(cwd, '.mcp.json'), JSON.stringify({ mcpServers: { proj1: { command: 'p' }, bad: 'x' } }));
  const got = discoverMcpSources({ home, cwd });
  assert.deepStrictEqual(got.map((r) => [r.source.split(' ')[0], r.name]), [
    ['claude:user', 'jira'], ['claude:local', 'local1'], ['claude:project', 'proj1'],
  ]);
  assert.deepStrictEqual(got[0].entry, { command: 'npx' });
  const cfgDir = path.join(root, 'cfg');
  fs.mkdirSync(cfgDir);
  fs.writeFileSync(path.join(cfgDir, '.claude.json'), JSON.stringify({ mcpServers: { fromCfg: { command: 'c' } } }));
  assert.deepStrictEqual(discoverMcpSources({ home, cwd: null, claudeConfigDir: cfgDir }).map((r) => r.name), ['fromCfg']);
  assert.deepStrictEqual(discoverMcpSources({ home: path.join(root, 'missing'), cwd: null }), []);
});

test('normaliseDiscovered: secret-looking literals become ${NAME} and the values are only returned', () => {
  const src = { type: 'http', url: 'u', headers: { Authorization: 'Bearer abc', 'X-Trace': 'on' }, env: { JIRA_TOKEN: 'hunter2', URL: 'x' } };
  const before = JSON.stringify(src);
  const { entry, secrets } = normaliseDiscovered(src);
  assert.strictEqual(JSON.stringify(src), before);
  assert.deepStrictEqual(entry.headers, { Authorization: 'Bearer ${AUTHORIZATION}', 'X-Trace': 'on' });
  assert.deepStrictEqual(entry.env, { JIRA_TOKEN: '${JIRA_TOKEN}', URL: 'x' });
  assert.deepStrictEqual(secrets, { AUTHORIZATION: 'abc', JIRA_TOKEN: 'hunter2' });
  assert.strictEqual(validateMcpEntry(entry).ok, true);
});

test('tomlString: TOML basic-string escapes, unicode verbatim', () => {
  const rows = [
    ['a"b', '"a\\"b"'],
    ['a\\b', '"a\\\\b"'],
    ['a\nb\r\tc', '"a\\nb\\r\\tc"'],
    ['héllo ✓', '"héllo ✓"'],
    ['', '""'],
    ['\u0001', '"\\u0001"'],
  ];
  for (const [input, want] of rows) assert.strictEqual(tomlString(input), want, JSON.stringify(input));
});

const CX_LIB = [
  { name: 'jira', entry: { command: 'npx', args: ['jira'], env: { API_TOKEN: '${JIRA_TOKEN}', MODE: 'ro' }, denyTools: ['delete', 'admin'] } },
  { name: 'bearer', entry: { type: 'http', url: 'https://b/mcp', headers: { Authorization: 'Bearer ${X}' } } },
  { name: 'hdr', entry: { type: 'http', url: 'https://h/mcp', headers: { 'X-Key': '${X}', 'X-Team': 'core' } } },
  { name: 'mixed', entry: { type: 'http', url: 'https://m/mcp', headers: { 'X-Key': 'k=${X}' } } },
  { name: 'argref', entry: { command: 'srv', args: ['--token=${X}'] } },
  { name: 'urlref', entry: { type: 'http', url: 'https://u/${X}' } },
  { name: 'old', entry: { type: 'sse', url: 'https://s/sse' } },
];

function cxFor(selected, extra = {}) {
  const env = { JIRA_TOKEN: 'hunter2', X: 'xv' };
  const plan = claudeMcpServers({ selected, library: CX_LIB, env, cli: 'codex' });
  return codexMcpArgs({ servers: plan.servers, library: CX_LIB, env, configNames: [], ...extra });
}
const cxPairs = (cx) => cx.args.filter((_a, i) => i % 2 === 1);

test('codexMcpArgs: a stdio env alias rides the seat env by name; argv never holds the value', () => {
  const cx = cxFor(['jira']);
  assert.ok(cx.args.every((a, i) => i % 2 === 1 || a === '-c'));
  assert.deepStrictEqual(cxPairs(cx), [
    'mcp_servers.jira.command="npx"',
    'mcp_servers.jira.args=["jira"]',
    'mcp_servers.jira.env={MODE="ro"}',
    'mcp_servers.jira.env_vars=["API_TOKEN"]',
    'mcp_servers.jira.disabled_tools=["admin","delete"]',
    'mcp_servers.jira.enabled=true',
  ]);
  assert.ok(!cx.args.join(' ').includes('hunter2'));
  assert.deepStrictEqual(cx.seatEnv, { API_TOKEN: 'hunter2' });
  assert.deepStrictEqual(cx.warnings, []);
  assert.deepStrictEqual(cx.applied.denied, { jira: ['admin', 'delete'] });
  assert.deepStrictEqual(cx.applied.residue, []);
});

test('codexMcpArgs: http headers map to bearer_token_env_var, env_http_headers and http_headers', () => {
  assert.deepStrictEqual(cxPairs(cxFor(['bearer'])), [
    'mcp_servers.bearer.url="https://b/mcp"',
    'mcp_servers.bearer.bearer_token_env_var="X"',
    'mcp_servers.bearer.enabled=true',
  ]);
  assert.deepStrictEqual(cxPairs(cxFor(['hdr'])), [
    'mcp_servers.hdr.url="https://h/mcp"',
    'mcp_servers.hdr.http_headers={X-Team="core"}',
    'mcp_servers.hdr.env_http_headers={X-Key="X"}',
    'mcp_servers.hdr.enabled=true',
  ]);
});

test('codexMcpArgs: inexpressible servers are absent with the exact warning and leave applied.names', () => {
  const cx = cxFor(['mixed', 'argref', 'urlref', 'old', 'jira']);
  assert.deepStrictEqual(cx.warnings, [
    'MCP argref: not expressible on Codex — args reference an env var',
    'MCP mixed: not expressible on Codex — header X-Key mixes text and an env var',
    'MCP old: not available on codex (sse)',
    'MCP urlref: not expressible on Codex — url references an env var',
  ]);
  assert.ok(cxPairs(cx).includes('mcp_servers.jira.enabled=true'), 'ENTER: the expressible server survives');
  assert.ok(!cxPairs(cx).some((p) => /^mcp_servers\.(mixed|argref|urlref|old)\./.test(p)), cx.args.join(' '));
  assert.deepStrictEqual(cx.applied.names, ['jira']);
  assert.strictEqual(cx.applied.digest, mcpDigest({ jira: digestShape(CX_LIB[0].entry) }));
});

test('codexMcpArgs: the seat\'s own -c mcp_servers wins; Clodex pushes nothing', () => {
  assert.deepStrictEqual(cxFor(['jira'], { userOwn: true }), {
    args: [], seatEnv: {}, warnings: ["MCP: selection not applied — the seat's extra args carry their own -c mcp_servers"], applied: null,
  });
});

test('codexMcpArgs: config.toml servers outside the selection are disabled by name; a selected one warns', () => {
  const cx = cxFor(['jira'], { configNames: ['jira', 'legacy', 'my-srv'] });
  assert.deepStrictEqual(cxPairs(cx).slice(-2), ['mcp_servers.legacy.enabled=false', 'mcp_servers.my-srv.enabled=false']);
  assert.ok(!cxPairs(cx).includes('mcp_servers.jira.enabled=false'));
  assert.deepStrictEqual(cx.warnings, ["MCP jira: also in config.toml — Codex merges Clodex's keys over it; stale keys survive"]);
});
