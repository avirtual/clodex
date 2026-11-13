'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const tb = require('../team-box');
const { createTicketMethods } = require('../team-tickets');
const { parseIntent } = require('../intent-scanner');
const registry = require('../intent-registry');
const { mkTmpRoot } = require('./lib/tmp-roots');

const GOOD = 'ARG CLODEX_BASE\nFROM ${CLODEX_BASE}\nUSER root\nRUN apt-get install -y jq\nUSER clodex\n';

function mkTeam({ bootstrap = null, noBox = false } = {}) {
  const home = mkTmpRoot('t2277-');
  const teamsDir = path.join(home, 'teams');
  const dir = path.join(teamsDir, 'clodex');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const team = { name: 'clodex', root: '/proj', lead: 'lead', file: path.join(dir, 'team.json'), dir, roles: { lead: {}, hand: {} } };
  fs.writeFileSync(team.file, '{"name":"clodex","root":"/proj","lead":"lead","roles":{"lead":{},"hand":{}}}\n');
  const box = { getConfig: () => ({ bootstrap }) };
  const manager = { get: (id) => (!noBox && id === 'team-clodex' ? box : null) };
  const methods = createTicketMethods({
    fs, path, teamsDir,
    listTeams: () => ['clodex'],
    resolveTeam: (cwd) => (cwd === '/proj' ? team : null),
    refreshAppMenu: () => {},
    getSandboxManager: () => manager,
    getPeerManager: () => null,
    log: { info() {}, warn() {}, error() {} },
  }, {});
  const injected = [];
  const m = Object.create(methods);
  m._injectText = (_s, text) => { injected.push(text); };
  m.recordMisfire = () => true;
  const lead = { name: 'lead', agentType: 'claude', cwd: '/proj' };
  const hand = { name: 'clodex-hand', agentType: 'claude', cwd: '/proj' };
  const fire = (session, action, body = '') => {
    m._handleTeam(session, { type: 'team', sub: 'box', action, body });
    return injected[injected.length - 1];
  };
  return { dir, lead, hand, fire, file: path.join(dir, 'box', 'Dockerfile'), meta: path.join(dir, 'box', 'box.json') };
}

const readMeta = (t) => JSON.parse(fs.readFileSync(t.meta, 'utf8'));

const REFUSED = [
  ['no FROM at all', '# a box\nRUN apt-get install -y jq\n', /the definition has no FROM/],
  ['COPY . .', 'FROM node:25-bookworm\nCOPY . .\n', /line 2: COPY without --from= is refused/],
  ['ENV API_TOKEN=x', 'FROM node:25-bookworm\nENV API_TOKEN=x\n', /line 2 looks like a secret/],
  ['a secret inside a RUN heredoc', 'FROM node:25-bookworm\nRUN <<EOF\nset -e\nexport GH_TOKEN=abc\nEOF\n', /line 4 looks like a secret/],
  ['a secret mount', 'FROM node:25-bookworm\nRUN --mount=type=secret,id=npm npm ci\n', /line 2: secret and ssh mounts are refused/],
  ['# syntax=', '# syntax=docker/dockerfile:1\nFROM node:25-bookworm\n', /line 1: parser directives/],
  ['16385 bytes', `FROM node:25-bookworm\n${'#'.repeat(16385 - 23)}\n`, /the definition is 16385 bytes; the cap is 16384/],
];

for (const [label, text, why] of REFUSED) {
  test(`validateBoxDefinition refuses: ${label}`, () => {
    if (label === '16385 bytes') assert.strictEqual(Buffer.byteLength(text), 16385, 'ENTER: the row is the size it names');
    const r = tb.validateBoxDefinition(text);
    assert.strictEqual(r.ok, false);
    assert.match(r.error, why);
  });
}

const ACCEPTED = [
  ['FROM node:25-bookworm single stage', 'FROM node:25-bookworm\nRUN apt-get update && apt-get install -y jq\nWORKDIR /work\nCMD ["bash"]\n'],
  ['multi-stage ending on a non-Clodex image', 'FROM golang:1.22 AS build\nRUN go install example.com/tool@latest\n'
    + 'FROM debian:bookworm-slim\nCOPY --from=build /go/bin/tool /usr/local/bin/tool\nRUN <<EOF\nset -e\necho COPY . . is text here\nEOF\nUSER root\n'],
  ['ARG CLODEX_BASE / FROM ${CLODEX_BASE}', 'ARG CLODEX_BASE\nFROM ${CLODEX_BASE}\nUSER root\nRUN apt-get install -y jq\nUSER clodex\n'],
];

for (const [label, text] of ACCEPTED) {
  test(`validateBoxDefinition accepts: ${label}`, () => {
    assert.deepStrictEqual(tb.validateBoxDefinition(text), { ok: true, text, definitionHash: tb.boxFingerprint(text) });
  });
}

test('show passes --build-arg CLODEX_BASE only when the file declares that ARG', () => {
  const t = mkTeam();
  t.fire(t.lead, 'set', 'FROM node:25-bookworm\nRUN true\n');
  assert.strictEqual(t.fire(t.lead, 'show').split('\n')[2], `checked for form; not built — build it by hand: docker build -t clodex-box:fa502f955d13 --label clodex.box=fa502f955d138e4a78faa0ef2c6525d18955f6e2d5dbeac135c8f9ab60ae884f - < ${t.file}`);
});

test('definitionHash: CRLF equals LF, a one-byte edit differs', () => {
  const lf = tb.boxFingerprint(GOOD);
  assert.match(lf, /^[0-9a-f]{64}$/);
  assert.strictEqual(tb.boxFingerprint(GOOD.replace(/\n/g, '\r\n')), lf);
  assert.notStrictEqual(tb.boxFingerprint(GOOD.replace('jq', 'jr')), lf);
});

test('rev: 1 after set, unchanged and unwritten after an identical set, 2 after a change, 3 after clear then set', () => {
  const t = mkTeam();
  assert.match(t.fire(t.lead, 'set', GOOD), /^\[agent:team\] box definition rev 1 · definition hash [0-9a-f]{64} — saved to .*; checked for form; not built$/);
  assert.strictEqual(readMeta(t).rev, 1);
  const ino = [fs.statSync(t.file).ino, fs.statSync(t.meta).ino];

  assert.match(t.fire(t.lead, 'set', GOOD.replace(/\n/g, '\r\n')), /rev 1 .* unchanged, nothing written; checked for form; not built$/);
  assert.deepStrictEqual([fs.statSync(t.file).ino, fs.statSync(t.meta).ino], ino, 'an identical set replaces neither file');
  assert.strictEqual(readMeta(t).rev, 1);

  t.fire(t.lead, 'set', GOOD.replace('jq', 'git'));
  assert.strictEqual(readMeta(t).rev, 2);

  assert.strictEqual(t.fire(t.lead, 'clear'), '[agent:team] box definition cleared (was rev 2); kept in history — the next set or init is rev 3');
  assert.strictEqual(fs.existsSync(t.file), false);
  t.fire(t.lead, 'set', GOOD);
  assert.strictEqual(readMeta(t).rev, 3);
  assert.deepStrictEqual(readMeta(t).history.map((h) => [h.rev, h.text]), [[1, GOOD], [2, GOOD.replace('jq', 'git')]]);
});

test('a refused set leaves the stored file and rev untouched', () => {
  const t = mkTeam();
  t.fire(t.lead, 'set', GOOD);
  assert.match(t.fire(t.lead, 'set', 'ARG CLODEX_BASE\nFROM ${CLODEX_BASE}\nCOPY . .\n'),
    /^\[agent:team\] error: box definition refused, the stored one is unchanged: line 3: COPY without --from= is refused/);
  assert.strictEqual(fs.readFileSync(t.file, 'utf8'), GOOD);
  assert.strictEqual(readMeta(t).rev, 1);
});

test('init writes the literal Dockerfile for a known bootstrap and records its ancestry', () => {
  const t = mkTeam({ bootstrap: { packages: ['jq', 'git'], setup: 'npm i -g pnpm\r\necho done\n', start: 'echo start' } });
  assert.match(t.fire(t.lead, 'init'), /^\[agent:team\] box definition rev 1 · definition hash [0-9a-f]{64} — generated from bootstrap [0-9a-f]{12}, saved to .*; checked for form; not built$/);
  assert.deepStrictEqual(fs.readFileSync(t.file, 'utf8'), [
    'ARG CLODEX_BASE',
    'FROM ${CLODEX_BASE}',
    'USER root',
    'RUN apt-get update -qq \\',
    ' && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends jq git \\',
    ' && rm -rf /var/lib/apt/lists/*',
    "RUN <<'CLODEX_SETUP'",
    'set -e',
    'npm i -g pnpm',
    'echo done',
    'CLODEX_SETUP',
    'USER clodex',
    '',
  ].join('\n'));
  const setupSh = '#!/bin/sh\nset -e\nexport DEBIAN_FRONTEND=noninteractive\napt-get update -qq\n'
    + 'apt-get install -y -qq --no-install-recommends jq git\nnpm i -g pnpm\r\necho done\n';
  assert.strictEqual(readMeta(t).fromBootstrap, require('node:crypto').createHash('sha256').update(setupSh).digest('hex').slice(0, 12));
});

test('init refuses when a definition exists, and when the team has no sandbox box', () => {
  const t = mkTeam({ bootstrap: { packages: ['jq'] } });
  t.fire(t.lead, 'set', GOOD);
  assert.strictEqual(t.fire(t.lead, 'init'), '[agent:team] error: this team already has a box definition — [agent:team box clear] first');
  assert.strictEqual(fs.readFileSync(t.file, 'utf8'), GOOD);
  const n = mkTeam({ noBox: true });
  assert.strictEqual(n.fire(n.lead, 'init'), '[agent:team] error: this team has no sandbox box config to generate from — [agent:team box set] <Dockerfile> instead');
  assert.strictEqual(fs.existsSync(n.file), false);
});

test('show: rev and definition hash on line 1, the bootstrap line in all three states, one docker build line', () => {
  const t = mkTeam({ bootstrap: { packages: ['jq'] } });
  t.fire(t.lead, 'set', GOOD);
  const hash = tb.boxFingerprint(GOOD);
  const shown = t.fire(t.lead, 'show').split('\n');
  assert.strictEqual(shown[0], `[agent:team] box definition rev 1 · definition hash ${hash}`);
  assert.strictEqual(shown[1], 'not generated from bootstrap');
  assert.strictEqual(shown.filter((l) => l.includes('docker build')).length, 1);
  assert.match(shown[2], /^checked for form; not built — build it by hand: docker build -t clodex-box:f79656bcd1b6 --label clodex\.box=f79656bcd1b67f19a5ffe0ae5fe6dd9dff3db6f4476b500d5c4613834039fde4 --build-arg CLODEX_BASE=ghcr\.io\/avirtual\/clodex:\d+\.\d+\.\d+ - < .*\/box\/Dockerfile$/);

  t.fire(t.lead, 'clear');
  t.fire(t.lead, 'init');
  const from = readMeta(t).fromBootstrap;
  assert.match(from, /^[0-9a-f]{12}$/);
  assert.strictEqual(t.fire(t.lead, 'show').split('\n')[1], `generated from bootstrap ${from}; edited since: no`);
  assert.strictEqual(t.fire(t.lead, 'show'), t.fire(t.lead, ''), 'bare box is show');

  t.fire(t.lead, 'set', `${fs.readFileSync(t.file, 'utf8')}RUN true\n`);
  assert.strictEqual(t.fire(t.lead, 'show').split('\n')[1], `generated from bootstrap ${from}; edited since: yes`);
});

test('history keeps the 20 most recent prior definitions and drops the oldest', () => {
  const t = mkTeam();
  for (let i = 1; i <= 22; i += 1) t.fire(t.lead, 'set', `${GOOD}RUN echo ${i}\n`);
  const meta = readMeta(t);
  assert.strictEqual(meta.rev, 22);
  assert.strictEqual(meta.history.length, 20);
  assert.deepStrictEqual([meta.history[0].rev, meta.history[0].text], [2, `${GOOD}RUN echo 2\n`]);
  assert.deepStrictEqual([meta.history[19].rev, meta.history[19].text], [21, `${GOOD}RUN echo 21\n`]);
});

test('a hand gets the lead-only refusal and writes nothing', () => {
  const t = mkTeam();
  assert.strictEqual(t.fire(t.hand, 'set', GOOD), '[agent:team] error: only the team lead (lead) can edit team metadata');
  assert.strictEqual(fs.existsSync(path.join(t.dir, 'box')), false);
});

test('box parses: set carries a greedy body, the bare form is show', () => {
  assert.deepStrictEqual(parseIntent('[agent:team box]'), { type: 'team', sub: 'box', action: 'show', body: '' });
  assert.deepStrictEqual(parseIntent('[agent:team box set] FROM x'), { type: 'team', sub: 'box', action: 'set', body: 'FROM x' });
  assert.strictEqual(registry.bodyModeFor(parseIntent('[agent:team box set] x')), 'greedy');
  assert.strictEqual(registry.bodyModeFor(parseIntent('[agent:team box init]')), 'none');
});
