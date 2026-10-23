'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const {
  MCP_NAME_RE, mcpNameError, validateMcpEntry, secretRefs, resolveMcpEntry,
  claudeMcpServers, mcpArgvPlan, mcpServerOf, mcpLeaks, discoverMcpSources, normaliseDiscovered,
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
