'use strict';
// deploy-helm.test.js — the `deploy helm <name>` flavor: one command from the
// packaged chart to a verified k8s node. Pure argv builders (token FILES in
// argv, values never), release-name validation, the existing-release
// token-reuse branch, ctx-entry shape, dry-run, and the verify-failure exit —
// all against a scripted execFn (helm/kubectl are never really spawned) and an
// injected io.probeHelm (no kubectl port-forward is ever opened).
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const D = require('../src/deploy');
const { EXIT } = require('../src/errors');
const { run } = require('../src/main');

// ── pure: helmArgv ───────────────────────────────────────────────────────────

test('helmArgv: exact argv — set-file PATHS present, --wait/--timeout, no token value', () => {
  const a = D.helmArgv({ name: 'mynode', chart: '/pkg/helm/clodex', namespace: 'clodex', kubeContext: 'docker-desktop', wireTokenFile: '/tmp/x/wire-token' });
  assert.deepStrictEqual(a, [
    'helm', 'upgrade', '--install', 'mynode', '/pkg/helm/clodex',
    '--namespace', 'clodex',
    '--kube-context', 'docker-desktop',
    '--set-file', 'secrets.wireToken=/tmp/x/wire-token',
    '--wait', '--timeout', D.HELM_TIMEOUT,
  ]);
});

test('helmArgv: oauth set-file, non-default port, --set/--values passthrough in order', () => {
  const a = D.helmArgv({
    name: 'n', chart: '/c', namespace: 'ns', port: 8100,
    wireTokenFile: '/t/wire', oauthTokenFile: '/t/oauth',
    sets: ['persistence.enabled=false', 'image.tag=v9'], valuesFiles: ['/v/f.yaml'],
  });
  const j = a.join(' ');
  assert.match(j, /--set-file secrets\.wireToken=\/t\/wire/);
  assert.match(j, /--set-file secrets\.oauthToken=\/t\/oauth/);
  assert.match(j, /--set wirePort=8100/);
  assert.match(j, /--set persistence\.enabled=false --set image\.tag=v9/);
  assert.match(j, /--values \/v\/f\.yaml/);
  // default port → no wirePort override at all.
  const b = D.helmArgv({ name: 'n', chart: '/c', namespace: 'ns', wireTokenFile: '/t/wire' });
  assert.doesNotMatch(b.join(' '), /wirePort/);
  // no kube-context → flag absent (helm uses the current context).
  assert.doesNotMatch(b.join(' '), /--kube-context/);
});

test('helmStatusArgs / releaseSecretArgs: shapes', () => {
  assert.deepStrictEqual(D.helmStatusArgs({ name: 'n', namespace: 'ns', kubeContext: 'c' }),
    ['helm', 'status', 'n', '--namespace', 'ns', '--kube-context', 'c']);
  assert.deepStrictEqual(D.releaseSecretArgs({ name: 'n', namespace: 'ns', kubeContext: 'c' }),
    ['kubectl', '--context', 'c', '-n', 'ns', 'get', 'secret', 'n-secrets', '-o', 'jsonpath={.data.wire-token}']);
  // key selects the Secret field (oauth preservation reads oauth-token).
  assert.deepStrictEqual(D.releaseSecretArgs({ name: 'n', namespace: 'ns', key: 'oauth-token' }).slice(-1),
    ['jsonpath={.data.oauth-token}']);
  // context optional on both.
  assert.ok(!D.helmStatusArgs({ name: 'n', namespace: 'ns' }).includes('--kube-context'));
  assert.ok(!D.releaseSecretArgs({ name: 'n', namespace: 'ns' }).includes('--context'));
});

test('helmChartPath: resolves to the packaged chart (Chart.yaml exists)', () => {
  assert.ok(fs.existsSync(path.join(D.helmChartPath(), 'Chart.yaml')));
});

test('deploy helm --no-wirescope: warned as ignored (chart value is the route), not silent', async () => {
  const { code, stdout } = await cli(['deploy', 'helm', 'n', '--no-wirescope', '--dry-run'], {
    execFn: async () => { throw new Error('nothing runs on --dry-run'); },
  });
  assert.strictEqual(code, 0);
  assert.match(stdout, /--no-wirescope is ignored by the helm flavor — use --set wirescope\.enabled=false/);
});

test('chart: wirescope.enabled value (T49) — default true; false renders CLODEX_WIRESCOPE=off in the pod env', () => {
  // No helm-template harness in this suite — string assertions on the chart
  // files (the spec's fallback): the value exists with a true default, and the
  // statefulset guards a CLODEX_WIRESCOPE=off env entry on `not enabled`.
  const values = fs.readFileSync(path.join(D.helmChartPath(), 'values.yaml'), 'utf8');
  assert.match(values, /^wirescope:\n  enabled: true$/m, 'values.yaml default is enabled: true');
  const sts = fs.readFileSync(path.join(D.helmChartPath(), 'templates', 'statefulset.yaml'), 'utf8');
  assert.match(sts, /\{\{- if not \.Values\.wirescope\.enabled \}\}/);
  const block = sts.slice(sts.indexOf('{{- if not .Values.wirescope.enabled }}'));
  assert.match(block.slice(0, block.indexOf('{{- end }}')), /name: CLODEX_WIRESCOPE\n\s+value: "off"/);
});

test('HELM_RELEASE_RE: DNS-1123 — rejects dots, underscores, uppercase, edges', () => {
  for (const ok of ['a', 'mynode', 'node-1', 'a1-b2']) assert.ok(D.HELM_RELEASE_RE.test(ok), ok);
  for (const bad of ['My.Node', 'a_b', 'UPPER', '-lead', 'trail-', '', 'a'.repeat(54)]) {
    assert.ok(!D.HELM_RELEASE_RE.test(bad), `should reject "${bad}"`);
  }
  assert.ok(D.HELM_RELEASE_RE.test('a'.repeat(53)));
});

// ── flow: scripted execFn ────────────────────────────────────────────────────

// A scripted helm/kubectl execFn. Records every call; on `helm upgrade` it
// captures the --set-file argv AND the token-file CONTENTS + modes + paths at
// exec time (the verb wipes the tempdir in a finally, so this is the only
// window — the *Paths let tests assert the cleanup happened).
// `oauthB64`: value of the Secret's oauth-token key; null mirrors kubectl's
// real missing-jsonpath-key behavior (EMPTY stdout, exit 0), not an error.
// `statusFail`: override the helm-status stderr (default: the not-found shape).
function fakeK8s(rec, { releaseExists = false, secretB64 = null, oauthB64 = null, nsExists = true, nsCreateFail = null, helmFail = null, statusFail = null } = {}) {
  rec.calls = [];
  return async (cmd, args) => {
    rec.calls.push([cmd, ...args]);
    const j = cmd + ' ' + args.join(' ');
    if (cmd === 'helm' && args[0] === 'version') return { stdout: 'v3.14.0+g0000000' };
    if (cmd === 'kubectl' && args[0] === 'version') return { stdout: 'clientVersion:\n  gitVersion: v1.29.0' };
    if (j.includes('config current-context')) return { stdout: 'docker-desktop\n' };
    if (cmd === 'kubectl' && args.includes('get') && args.includes('namespace')) {
      if (nsExists) return { stdout: 'NAME  STATUS  AGE' };
      const e = new Error('ns get failed'); e.stderr = 'Error from server (NotFound): namespaces "clodex" not found'; throw e;
    }
    if (cmd === 'kubectl' && args.includes('create') && args.includes('namespace')) {
      if (nsCreateFail) { const e = new Error('ns create failed'); e.stderr = nsCreateFail; throw e; }
      return { stdout: 'namespace/clodex created' };
    }
    if (cmd === 'helm' && args[0] === 'status') {
      if (releaseExists) return { stdout: 'STATUS: deployed' };
      const e = new Error('helm status failed'); e.stderr = statusFail || 'Error: release: not found'; throw e;
    }
    if (cmd === 'kubectl' && args.includes('secret')) {
      if (j.includes('oauth-token')) return { stdout: oauthB64 == null ? '' : oauthB64 };
      if (secretB64 != null) return { stdout: secretB64 };
      const e = new Error('secret get failed'); e.stderr = 'Error from server (NotFound): secrets "n-secrets" not found'; throw e;
    }
    if (cmd === 'helm' && args[0] === 'upgrade') {
      rec.helmArgs = args.slice();
      rec.setFiles = {}; rec.setFileModes = {}; rec.setFilePaths = {};
      args.forEach((a, i) => {
        if (args[i - 1] !== '--set-file') return;
        const eq = a.indexOf('=');
        const key = a.slice(0, eq), file = a.slice(eq + 1);
        rec.setFiles[key] = fs.readFileSync(file, 'utf8');
        rec.setFileModes[key] = fs.statSync(file).mode & 0o777;
        rec.setFilePaths[key] = file;
      });
      if (helmFail) { const e = new Error('helm upgrade failed'); e.stderr = helmFail; throw e; }
      return { stdout: 'Release has been upgraded. Happy Helming!' };
    }
    throw new Error('unexpected call: ' + j);
  };
}

async function cli(argv, io = {}) {
  let stdout = '', stderr = '';
  const code = await run(argv, {
    stdout: (s) => (stdout += s), stderr: (s) => (stderr += s),
    env: {},
    contextsFile: io.contextsFile || path.join(os.tmpdir(), 'nonexistent-clodexctl', 'contexts.json'),
    ...io,
  });
  return { code, stdout, stderr };
}
function tmpCtxFile() { return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'clodexctl-helm-t-')), 'contexts.json'); }

test('deploy helm happy path: preflight→mint→helm→ctx (kubectl kind + token)→verify', async () => {
  const rec = {};
  const contextsFile = tmpCtxFile();
  let verifiedWith = null;
  const { code, stdout } = await cli(['deploy', 'helm', 'mynode'], {
    execFn: fakeK8s(rec),
    probeHelm: async (entry, token) => { verifiedWith = { entry, token }; return { app: 'clodex', host: 'mynode', version: '9.9.9', caps: [] }; },
    contextsFile,
  });
  assert.strictEqual(code, 0);
  // preflight named the cluster (current-context resolved, echoed).
  assert.match(stdout, /kube context "docker-desktop", namespace "clodex"/);
  assert.match(stdout, /minted a fresh wire token/);
  assert.match(stdout, /context "mynode" saved/);
  assert.match(stdout, /verified — clodex host=mynode version=9\.9\.9/);
  // helm argv: packaged chart, release name, set-file PATH — and the token
  // VALUE appears NOWHERE in the argv.
  assert.strictEqual(rec.helmArgs[2], 'mynode');
  assert.strictEqual(rec.helmArgs[3], D.helmChartPath());
  const wireTok = rec.setFiles['secrets.wireToken'];
  assert.match(wireTok, /^[0-9a-f]{48}$/);
  assert.ok(!rec.helmArgs.some((a) => a.includes(wireTok)), 'token value never in argv');
  assert.strictEqual(rec.setFileModes['secrets.wireToken'], 0o600);
  // token value never printed either.
  assert.ok(!stdout.includes(wireTok), 'token value never in output');
  // verify used the FRESH kubectl entry + the minted token.
  assert.deepStrictEqual(verifiedWith.entry.kubectl, { target: 'svc/mynode', namespace: 'clodex', context: 'docker-desktop' });
  assert.strictEqual(verifiedWith.token, wireTok);
  // saved ctx: kubectl kind, svc target, token; default port → no remotePort.
  const saved = JSON.parse(fs.readFileSync(contextsFile, 'utf8'));
  assert.deepStrictEqual(saved.contexts.mynode, {
    kubectl: { target: 'svc/mynode', namespace: 'clodex', context: 'docker-desktop' },
    token: wireTok,
  });
  assert.strictEqual(saved.current, 'mynode');
  // only vendor CLIs were ever exec'd.
  assert.ok(!rec.calls.some(([c]) => c !== 'helm' && c !== 'kubectl'), 'only vendor CLIs called');
  // token tempfile is GONE after success (finally cleanup).
  assert.ok(!fs.existsSync(rec.setFilePaths['secrets.wireToken']), 'wire-token tempfile removed');
});

test('deploy helm: namespace created when absent; --namespace/--kube-context/--port flow through', async () => {
  const rec = {};
  const contextsFile = tmpCtxFile();
  const { code, stdout } = await cli(['deploy', 'helm', 'n', '--namespace', 'agents', '--kube-context', 'prod', '--port', '8100'], {
    execFn: fakeK8s(rec, { nsExists: false }),
    probeHelm: async () => ({ app: 'clodex' }),
    contextsFile,
  });
  assert.strictEqual(code, 0);
  // create namespace ran (get failed first).
  assert.ok(rec.calls.some((c) => c[0] === 'kubectl' && c.includes('create') && c.includes('agents')));
  assert.match(stdout, /namespace "agents" created/);
  // --kube-context given → NO current-context lookup.
  assert.ok(!rec.calls.some((c) => c.join(' ').includes('current-context')));
  assert.match(rec.helmArgs.join(' '), /--namespace agents/);
  assert.match(rec.helmArgs.join(' '), /--kube-context prod/);
  assert.match(rec.helmArgs.join(' '), /--set wirePort=8100/);
  const saved = JSON.parse(fs.readFileSync(contextsFile, 'utf8'));
  assert.deepStrictEqual(saved.contexts.n.kubectl, { target: 'svc/n', namespace: 'agents', context: 'prod' });
  assert.strictEqual(saved.contexts.n.remotePort, 8100);
});

test('deploy helm: existing release REUSES its Secret token (no rotation under a live ctx)', async () => {
  const rec = {};
  const contextsFile = tmpCtxFile();
  const existing = 'e'.repeat(48);
  const { code, stdout } = await cli(['deploy', 'helm', 'n'], {
    // secret value carries the trailing newline a real token file usually has —
    // the reuse path must trim it (the bearer-corruption trap).
    execFn: fakeK8s(rec, { releaseExists: true, secretB64: Buffer.from(existing + '\n').toString('base64') }),
    probeHelm: async () => ({ app: 'clodex' }),
    contextsFile,
  });
  assert.strictEqual(code, 0);
  assert.match(stdout, /reusing existing release token/);
  assert.doesNotMatch(stdout, /minted a fresh/);
  // the reused token (trimmed) rode the set-file and landed in the ctx.
  assert.strictEqual(rec.setFiles['secrets.wireToken'], existing);
  const saved = JSON.parse(fs.readFileSync(contextsFile, 'utf8'));
  assert.strictEqual(saved.contexts.n.token, existing);
});

test('deploy helm: flagless re-run PRESERVES the release oauth token (Secret would otherwise drop the key)', async () => {
  const rec = {};
  const contextsFile = tmpCtxFile();
  const wire = 'e'.repeat(48);
  const { code, stdout } = await cli(['deploy', 'helm', 'n'], {   // NO --claude-token-file
    execFn: fakeK8s(rec, {
      releaseExists: true,
      secretB64: Buffer.from(wire).toString('base64'),
      oauthB64: Buffer.from('sk-oauth-prev\n').toString('base64'),   // trailing newline trimmed
    }),
    probeHelm: async () => ({ app: 'clodex' }),
    contextsFile,
  });
  assert.strictEqual(code, 0);
  assert.match(stdout, /preserving existing claude oauth token/);
  // the preserved value re-rode --set-file (0600 tempfile), symmetric with wire.
  assert.strictEqual(rec.setFiles['secrets.oauthToken'], 'sk-oauth-prev');
  assert.strictEqual(rec.setFileModes['secrets.oauthToken'], 0o600);
  assert.ok(!rec.helmArgs.some((a) => a.includes('sk-oauth-prev')), 'oauth value never in argv');
  assert.doesNotMatch(stdout, /sk-oauth-prev/);
  assert.ok(!fs.existsSync(rec.setFilePaths['secrets.oauthToken']), 'oauth tempfile removed');
});

test('deploy helm: flagless re-run with NO oauth key in the Secret stages no oauth (empty jsonpath, no error)', async () => {
  const rec = {};
  const { code, stdout } = await cli(['deploy', 'helm', 'n', '--no-ctx'], {
    execFn: fakeK8s(rec, { releaseExists: true, secretB64: Buffer.from('e'.repeat(48)).toString('base64'), oauthB64: null }),
    probeHelm: async () => ({ app: 'clodex' }),
  });
  assert.strictEqual(code, 0);
  assert.strictEqual(rec.setFiles['secrets.oauthToken'], undefined);
  assert.doesNotMatch(rec.helmArgs.join(' '), /oauthToken/);
  assert.doesNotMatch(stdout, /preserving existing claude oauth/);
});

test('deploy helm: --claude-token-file on re-run WINS over the release oauth (rotation path)', async () => {
  const rec = {};
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clodexctl-helm-tok-'));
  const tf = path.join(dir, 'tok'); fs.writeFileSync(tf, 'sk-oauth-new\n');
  const { code } = await cli(['deploy', 'helm', 'n', '--claude-token-file', tf, '--no-ctx'], {
    execFn: fakeK8s(rec, {
      releaseExists: true,
      secretB64: Buffer.from('e'.repeat(48)).toString('base64'),
      oauthB64: Buffer.from('sk-oauth-prev').toString('base64'),
    }),
    probeHelm: async () => ({ app: 'clodex' }),
  });
  assert.strictEqual(code, 0);
  assert.strictEqual(rec.setFiles['secrets.oauthToken'], 'sk-oauth-new');
  // the flagged run never even reads the oauth key (flag wins outright) —
  // check kubectl secret-get calls only (the helm argv's tempfile is named
  // oauth-token too).
  assert.ok(!rec.calls.some((c) => c[0] === 'kubectl' && c.includes('secret') && c.join(' ').includes('{.data.oauth-token}')),
    'no oauth Secret read when flag present');
});

test('deploy helm: helm status failing for a NON-not-found reason → hard error, never a silent fresh mint', async () => {
  const rec = {};
  const { code, stderr } = await cli(['deploy', 'helm', 'n'], {
    execFn: fakeK8s(rec, { statusFail: 'Error: Kubernetes cluster unreachable: Get "https://…": dial tcp: connect: connection refused' }),
    probeHelm: async () => { throw new Error('should not verify'); },
  });
  assert.strictEqual(code, EXIT.CONNECT);
  assert.match(stderr, /could not determine whether release "n" exists/);
  assert.match(stderr, /check cluster access/);
  // never reached helm upgrade — no fresh token rode anywhere.
  assert.strictEqual(rec.helmArgs, undefined);
  assert.doesNotMatch(stderr, /[0-9a-f]{48}/);
});

test('deploy helm: release exists but its Secret is unreadable → SERVER error naming the operator-managed mode', async () => {
  const rec = {};
  const { code, stderr } = await cli(['deploy', 'helm', 'n'], {
    execFn: fakeK8s(rec, { releaseExists: true, secretB64: null }),
    probeHelm: async () => { throw new Error('should not verify'); },
  });
  assert.strictEqual(code, EXIT.SERVER);
  assert.match(stderr, /wire token could not be read/);
  assert.match(stderr, /existingSecret/);
  // never reached helm upgrade (no silent rotation attempt).
  assert.strictEqual(rec.helmArgs, undefined);
});

test('deploy helm --claude-token-file: extracted value staged 0600 → --set-file, never argv/stdout', async () => {
  const rec = {};
  const contextsFile = tmpCtxFile();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clodexctl-helm-tok-'));
  const tf = path.join(dir, 'tok');
  // env-file format: the EXTRACTED value must ride, not the raw file bytes.
  fs.writeFileSync(tf, '# auth\nCLAUDE_CODE_OAUTH_TOKEN=sk-oauth-secret\n');
  const { code, stdout } = await cli(['deploy', 'helm', 'n', '--claude-token-file', tf], {
    execFn: fakeK8s(rec),
    probeHelm: async () => ({ app: 'clodex' }),
    contextsFile,
  });
  assert.strictEqual(code, 0);
  assert.strictEqual(rec.setFiles['secrets.oauthToken'], 'sk-oauth-secret');
  assert.strictEqual(rec.setFileModes['secrets.oauthToken'], 0o600);
  // the VALUE is nowhere in argv (only the tempfile path) nor in output.
  assert.ok(!rec.helmArgs.some((a) => a.includes('sk-oauth-secret')));
  assert.doesNotMatch(stdout, /sk-oauth-secret/);
  assert.match(stdout, /claude token staged .*redacted/);
});

test('deploy helm: bad release name (dots/underscore/uppercase) → USAGE, nothing runs', async () => {
  for (const bad of ['My.Node', 'a_b', 'UPPER']) {
    let ran = false;
    const { code, stderr } = await cli(['deploy', 'helm', bad], {
      execFn: async () => { ran = true; return { stdout: '' }; },
      probeHelm: async () => ({}),
    });
    assert.strictEqual(code, EXIT.USAGE, bad);
    assert.match(stderr, /bad release name/);
    assert.match(stderr, /DNS-1123/);
    assert.strictEqual(ran, false);
  }
});

test('deploy helm: no name → USAGE', async () => {
  const { code, stderr } = await cli(['deploy', 'helm'], { execFn: async () => ({ stdout: '' }) });
  assert.strictEqual(code, EXIT.USAGE);
  assert.match(stderr, /deploy helm needs a release name/);
});

test('deploy helm --dry-run: plan only — cluster/ns/release/chart/ctx entry, claude by presence, nothing runs', async () => {
  let ran = false;
  const contextsFile = tmpCtxFile();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clodexctl-helm-tok-'));
  const tf = path.join(dir, 'tok'); fs.writeFileSync(tf, 'sk-drysecret\n');
  const { code, stdout } = await cli(['deploy', 'helm', 'n', '--kube-context', 'prod', '--claude-token-file', tf, '--dry-run'], {
    execFn: async () => { ran = true; return { stdout: '' }; },
    probeHelm: async () => { throw new Error('should not verify'); },
    contextsFile,
  });
  assert.strictEqual(code, 0);
  assert.strictEqual(ran, false);
  assert.match(stdout, /dry-run — would deploy release "n"/);
  assert.match(stdout, /namespace {2}clodex/);
  assert.match(stdout, /kube-ctx {3}prod/);
  assert.match(stdout, new RegExp(`chart\\s+${D.helmChartPath().replace(/[/\\]/g, '.')}`));
  assert.match(stdout, /claude .*redacted/);
  assert.match(stdout, /context n \(kubectl svc\/n -n clodex/);
  assert.doesNotMatch(stdout, /sk-drysecret/);
  assert.strictEqual(fs.existsSync(contextsFile), false);
});

test('deploy helm: helm failure mid---wait → SERVER + "exists; fix and re-run" honesty, no ctx/verify', async () => {
  const rec = {};
  const contextsFile = tmpCtxFile();
  let verified = false;
  const { code, stderr } = await cli(['deploy', 'helm', 'n'], {
    execFn: fakeK8s(rec, { helmFail: 'Error: timed out waiting for the condition' }),
    probeHelm: async () => { verified = true; return {}; },
    contextsFile,
  });
  assert.strictEqual(code, EXIT.SERVER);
  assert.match(stderr, /timed out waiting/);           // helm's own stderr relayed
  assert.match(stderr, /partial state .*re-run/);      // no auto-rollback; upgrade in place
  assert.match(stderr, /helm status n -n clodex/);
  assert.doesNotMatch(stderr, /[0-9a-f]{48}/);         // token never rides the error
  assert.strictEqual(verified, false);
  assert.strictEqual(fs.existsSync(contextsFile), false);
  // token tempfile is GONE even on the failure path (finally cleanup).
  assert.ok(!fs.existsSync(rec.setFilePaths['secrets.wireToken']), 'wire-token tempfile removed on failure');
});

test('deploy helm: verify failure → nonzero exit; ctx already saved, message points at ctx test', async () => {
  const { CliError } = require('../src/errors');
  const contextsFile = tmpCtxFile();
  const { code, stdout, stderr } = await cli(['deploy', 'helm', 'n'], {
    execFn: fakeK8s({}),
    probeHelm: async () => { throw new CliError(EXIT.CONNECT, 'tunnel did not open a local port within 10s'); },
    contextsFile,
  });
  assert.strictEqual(code, EXIT.CONNECT);
  assert.match(stdout, /helm --wait passed.*did not answer through kubectl port-forward/);
  assert.match(stderr, /context was saved.*ctx test --verbose/);
  assert.doesNotMatch(stderr, /[0-9a-f]{48}/);   // token never rides the error
  // ctx upsert happened BEFORE verify — the release is live, keep the handle.
  const saved = JSON.parse(fs.readFileSync(contextsFile, 'utf8'));
  assert.ok(saved.contexts.n.kubectl);
});

test('deploy helm: verify failure with a SKIPPED ctx (collision, no --force) says NOT saved, not "saved"', async () => {
  const { CliError } = require('../src/errors');
  const contextsFile = tmpCtxFile();
  fs.mkdirSync(path.dirname(contextsFile), { recursive: true });
  fs.writeFileSync(contextsFile, JSON.stringify({ current: null, contexts: { n: { url: 'http://old' } } }));
  const { code, stderr } = await cli(['deploy', 'helm', 'n'], {
    execFn: fakeK8s({}),
    probeHelm: async () => { throw new CliError(EXIT.CONNECT, 'tunnel did not open a local port within 10s'); },
    contextsFile,
  });
  assert.strictEqual(code, EXIT.CONNECT);
  // the hint must NOT point at the (old) saved entry.
  assert.match(stderr, /context was NOT saved/);
  assert.match(stderr, /--force/);
  assert.doesNotMatch(stderr, /context was saved/);
  assert.doesNotMatch(stderr, /[0-9a-f]{48}/);
  // the old entry is untouched.
  assert.strictEqual(JSON.parse(fs.readFileSync(contextsFile, 'utf8')).contexts.n.url, 'http://old');
});

test('deploy helm --no-ctx: verifies but saves nothing', async () => {
  const contextsFile = tmpCtxFile();
  const { code, stdout } = await cli(['deploy', 'helm', 'n', '--no-ctx'], {
    execFn: fakeK8s({}), probeHelm: async () => ({ app: 'clodex' }), contextsFile,
  });
  assert.strictEqual(code, 0);
  assert.match(stdout, /verified/);
  assert.doesNotMatch(stdout, /context .* saved/);
  assert.strictEqual(fs.existsSync(contextsFile), false);
});

test('deploy helm: ctx collision kept unless --force (verify still runs on the fresh entry)', async () => {
  const contextsFile = tmpCtxFile();
  fs.mkdirSync(path.dirname(contextsFile), { recursive: true });
  fs.writeFileSync(contextsFile, JSON.stringify({ current: null, contexts: { n: { url: 'http://old' } } }));
  let probed = 0;
  const skip = await cli(['deploy', 'helm', 'n'], { execFn: fakeK8s({}), probeHelm: async () => { probed++; return { app: 'clodex' }; }, contextsFile });
  assert.strictEqual(skip.code, 0);
  assert.match(skip.stdout, /already exists — kept it/);
  assert.strictEqual(probed, 1);   // verify ran against the fresh entry regardless
  assert.strictEqual(JSON.parse(fs.readFileSync(contextsFile, 'utf8')).contexts.n.url, 'http://old');
  const force = await cli(['deploy', 'helm', 'n', '--force'], { execFn: fakeK8s({}), probeHelm: async () => ({ app: 'clodex' }), contextsFile });
  assert.strictEqual(force.code, 0);
  assert.match(force.stdout, /context "n" updated/);
  const saved = JSON.parse(fs.readFileSync(contextsFile, 'utf8')).contexts.n;
  assert.deepStrictEqual(saved.kubectl, { target: 'svc/n', namespace: 'clodex', context: 'docker-desktop' });
  assert.match(saved.token, /^[0-9a-f]{48}$/);
});

test('deploy helm --json: NDJSON step/ok/log + context + verify, no token leak', async () => {
  const contextsFile = tmpCtxFile();
  const { code, stdout } = await cli(['deploy', 'helm', 'n', '--json'], {
    execFn: fakeK8s({}), probeHelm: async () => ({ app: 'clodex', host: 'n', version: '1.0', caps: [] }), contextsFile,
  });
  assert.strictEqual(code, 0);
  const objs = stdout.trim().split('\n').map((l) => JSON.parse(l));
  for (const n of ['preflight', 'token', 'helm', 'verify']) {
    assert.ok(objs.some((o) => o.type === 'step' && o.name === n), `step ${n}`);
    assert.ok(objs.some((o) => o.type === 'ok' && o.name === n), `ok ${n}`);
  }
  assert.ok(objs.some((o) => o.type === 'context' && o.action === 'added' && o.name === 'n'));
  assert.deepStrictEqual(objs[objs.length - 1], { type: 'verify', ok: true, host: 'n', version: '1.0', caps: [] });
  assert.doesNotMatch(stdout, /[0-9a-f]{48}/);
});

test('deploy helm --set repeatable + --values repeatable ride through to helm', async () => {
  const rec = {};
  const { code } = await cli(['deploy', 'helm', 'n', '--set', 'persistence.enabled=false', '--set', 'image.tag=v9', '--values', '/v/f.yaml', '--values', '/v/g.yaml', '--no-ctx'], {
    execFn: fakeK8s(rec), probeHelm: async () => ({ app: 'clodex' }),
  });
  assert.strictEqual(code, 0);
  const j = rec.helmArgs.join(' ');
  assert.match(j, /--set persistence\.enabled=false/);
  assert.match(j, /--set image\.tag=v9/);
  assert.match(j, /--values \/v\/f\.yaml --values \/v\/g\.yaml/);
});

test('deploy helm --set secrets.* is rejected (argv secret + minted-token override footgun)', async () => {
  for (const bad of ['secrets.wireToken=abc', 'secrets.oauthToken=xyz', 'secrets.existingSecret=mine']) {
    let ran = false;
    const { code, stderr } = await cli(['deploy', 'helm', 'n', '--set', bad], {
      execFn: async () => { ran = true; return { stdout: '' }; },
      probeHelm: async () => ({}),
    });
    assert.strictEqual(code, EXIT.USAGE, bad);
    assert.match(stderr, /--set secrets\./);
    assert.match(stderr, /never ride argv/);
    // the VALUE half never echoes back (only the key is named).
    assert.doesNotMatch(stderr, /abc|xyz|mine/);
    assert.strictEqual(ran, false);
  }
});

test('deploy helm: a lost namespace-create race (AlreadyExists) is tolerated', async () => {
  const rec = {};
  const { code } = await cli(['deploy', 'helm', 'n', '--no-ctx'], {
    execFn: fakeK8s(rec, { nsExists: false, nsCreateFail: 'Error from server (AlreadyExists): namespaces "clodex" already exists' }),
    probeHelm: async () => ({ app: 'clodex' }),
  });
  assert.strictEqual(code, 0);   // the namespace exists — the state we wanted
  assert.ok(rec.helmArgs, 'helm upgrade still ran');
});

test('deploy helm: missing helm binary (ENOENT) → CONNECT with the vendor-CLI hint', async () => {
  const { code, stderr } = await cli(['deploy', 'helm', 'n'], {
    execFn: async (cmd) => { const e = new Error(`spawn ${cmd} ENOENT`); e.code = 'ENOENT'; throw e; },
    probeHelm: async () => ({}),
  });
  assert.strictEqual(code, EXIT.CONNECT);
  assert.match(stderr, /helm: command not found — is helm installed and on PATH\?/);
});

// ── dispatch: `deploy helm` routes; `deploy ssh helm` stays the ssh flavor ────

test('deploy helm routes to the helm flavor', async () => {
  // "My.Node" IS a valid ssh dest (DEST_RE allows uppercase + dots) but an
  // invalid helm release name — so the "bad release name" USAGE error proves
  // the helm validator ran, i.e. dispatch routed to the helm flavor.
  const { code, stderr } = await cli(['deploy', 'helm', 'My.Node'], { execFn: async () => ({ stdout: '' }) });
  assert.strictEqual(code, EXIT.USAGE);
  assert.match(stderr, /bad release name/);
});

test('deploy ssh helm still routes to the ssh flavor (host literally named helm)', async () => {
  const { code } = await cli(['deploy', 'ssh', 'helm'], {
    spawnFn: () => { const e = new Error('spawn ssh ENOENT'); e.code = 'ENOENT'; throw e; },
  });
  assert.strictEqual(code, EXIT.CONNECT);   // ssh flavor's "could not start ssh"
});
