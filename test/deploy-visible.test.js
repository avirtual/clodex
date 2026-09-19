'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { registerIpcHandlers } = require('../ipc-handlers');
const { fixDirFor } = require('../clodex-paths');
const { diagLines } = require('../engine');
const { mk } = require('./lib/session-fixtures');
const { mkTmpRoot } = require('./lib/tmp-roots');

const REPO = path.join(__dirname, '..');

function mkLog() {
  const lines = [];
  return {
    lines,
    log: {
      info: (tag, msg) => lines.push(['info', tag, msg]),
      warn: (tag, msg) => lines.push(['warn', tag, msg]),
      error: (tag, msg) => lines.push(['error', tag, msg]),
    },
  };
}

function mkDeployHandlers({ sshRun, log, registryDir = '/nope', manager, fsDep = fs }) {
  const handlers = new Map();
  registerIpcHandlers({
    handle: (ch, fn) => handlers.set(ch, fn),
    on: (ch, fn) => handlers.set(ch, fn),
    log,
    fs: fsDep,
    path,
    os: require('node:os'),
    sshRun,
    manager,
    persistence: { list: () => [], get: () => null },
    REGISTRY_DIR: registryDir,
    DEPLOY_FIX_INJECT_DELAY_MS: 1,
    UPDATE_REPO: 'avirtual/clodex',
    uiSettings: { get: () => ({ remotePort: 7900 }) },
    classifyDeployFolder: require('../peer-deploy').classifyDeployFolder,
    fixSessionName: require('../peer-deploy').fixSessionName,
    buildDeployFixBriefing: require('../peer-deploy').buildDeployFixBriefing,
    workspaceOfSender: () => 'ws-1',
  });
  return handlers;
}

const SENDER = { sender: { isDestroyed: () => true, send: () => {} } };


test('peer:deploy logs a begin line and an outcome line carrying the last :: marker', async () => {
  const { lines, log } = mkLog();
  const sshRun = async (host, body, opts) => {
    opts.onLine('installing packages');
    opts.onLine('::step preflight');
    opts.onLine('::fail preflight node-not-found');
    opts.onLine('plain trailing chatter');
    return { code: 1, timedOut: false, stderr: 'ssh: connect banner\nSECRET-STDERR-TEXT' };
  };
  const handlers = mkDeployHandlers({ sshRun, log });
  const deploy = handlers.get('peer:deploy');
  assert.strictEqual(typeof deploy, 'function', 'ENTER: peer:deploy is registered');

  await deploy(SENDER, 'user@box', { port: 7911, branch: 'master' });

  const peer = lines.filter((l) => l[1] === 'peer').map((l) => l[2]);
  assert.ok(peer.some((m) => m === 'deploy to user@box port 7911 branch master begins'),
    `a begin line naming host, port and branch; got ${JSON.stringify(peer)}`);
  assert.ok(peer.some((m) => m === 'deploy to user@box: exit 1, last marker ::fail preflight node-not-found'),
    `the outcome line carries the LAST :: marker, not the last line; got ${JSON.stringify(peer)}`);
});

test('peer:deploy never logs the script body, the preamble or stderr', async () => {
  const { lines, log } = mkLog();
  let sentBody = '';
  const sshRun = async (host, body, opts) => {
    sentBody = body;
    opts.onLine('::ok preflight');
    return { code: 0, timedOut: false, stderr: 'SECRET-STDERR-TEXT' };
  };
  const handlers = mkDeployHandlers({ sshRun, log });
  await handlers.get('peer:deploy')(SENDER, 'user@box', { port: 7911 });

  assert.ok(sentBody.includes('export PORT='), 'ENTER: the preamble really rode the ssh body');
  const logged = lines.map((l) => l.join(' ')).join('\n');
  assert.ok(!logged.includes('SECRET-STDERR-TEXT'), `stderr text leaked into the log:\n${logged}`);
  assert.ok(!logged.includes('export PORT='), `the preamble leaked into the log:\n${logged}`);
  assert.ok(!logged.includes('#!/'), `the script body leaked into the log:\n${logged}`);
});

test('peer:deploy logs "timed out after 900s" and "last marker none" when nothing marked', async () => {
  const { lines, log } = mkLog();
  const sshRun = async () => ({ code: null, timedOut: true, stderr: '' });
  const handlers = mkDeployHandlers({ sshRun, log });
  await handlers.get('peer:deploy')(SENDER, 'user@box', {});

  const peer = lines.filter((l) => l[1] === 'peer').map((l) => l[2]);
  assert.ok(peer.some((m) => m === 'deploy to user@box: timed out after 900s, last marker none'),
    `got ${JSON.stringify(peer)}`);
});

test('peer:deploy logs an error line when ssh fails to start', async () => {
  const { lines, log } = mkLog();
  const sshRun = async () => { throw new Error('ssh binary missing'); };
  const handlers = mkDeployHandlers({ sshRun, log });
  const res = await handlers.get('peer:deploy')(SENDER, 'user@box', {});

  assert.strictEqual(res.ok, false);
  assert.ok(lines.some((l) => l[0] === 'error' && l[1] === 'peer'
    && l[2] === 'deploy to user@box failed to start: ssh binary missing'),
  `got ${JSON.stringify(lines)}`);
});


test('both deploy script copies chmod the config dir and settings file, and stay byte-identical', () => {
  const a = fs.readFileSync(path.join(REPO, 'peering', 'clodex-deploy.sh'), 'utf8');
  const b = fs.readFileSync(path.join(REPO, 'cli', 'deploy', 'clodex-deploy.sh'), 'utf8');
  assert.strictEqual(a, b, 'cli/deploy/clodex-deploy.sh must be a byte-for-byte copy of peering/');
  for (const [where, src] of [['peering', a], ['cli/deploy', b]]) {
    assert.ok(src.includes('chmod 700 "$HOME/.config/clodex" 2>/dev/null || true'),
      `${where}: the config dir is not chmod 700'd`);
    assert.ok(src.includes('chmod 600 "$HOME/.config/clodex/ui-settings.json" 2>/dev/null || true'),
      `${where}: ui-settings.json is not chmod 600'd`);
    const enableAt = src.indexOf('systemctl --user enable clodex.service');
    const restartAt = src.indexOf('systemctl --user restart clodex.service');
    const chmodAt = src.indexOf('chmod 700 "$HOME/.config/clodex"');
    assert.ok(enableAt > 0 && restartAt > enableAt, `${where}: ENTER: enable precedes restart`);
    assert.ok(chmodAt > enableAt && chmodAt < restartAt,
      `${where}: the chmod must sit between enable and restart so the restart reads the tightened file`);
  }
});

test('bash -n accepts both deploy script copies', () => {
  const { execFileSync } = require('node:child_process');
  for (const rel of ['peering/clodex-deploy.sh', 'cli/deploy/clodex-deploy.sh']) {
    execFileSync('bash', ['-n', path.join(REPO, rel)]);
  }
});


function captureDiag(platform) {
  const d = {
    platform, procArch: 'x64', rosetta: false, electron: '30.0.0', node: '20.0.0',
    claude: '/usr/bin/claude', codex: null,
    helperPath: '/app/node_modules/node-pty/build/Release/spawn-helper',
    helperExists: false, helperExecutable: false, helperArch: 'unreadable (ENOENT)',
  };
  return diagLines(d).join('\n');
}

test('startup diagnostics omit the spawn-helper lines on linux and keep them on darwin', () => {
  const linux = captureDiag('linux');
  assert.ok(!linux.includes('spawn-helper'),
    `a linux node must not report the macOS-only helper; got:\n${linux}`);
  assert.ok(linux.includes('claude:'), 'ENTER: the rest of the block still prints on linux');
  assert.ok(linux.includes('linux/x64'), 'the process line still prints on linux');

  const darwin = captureDiag('darwin');
  assert.ok(darwin.includes('spawn-helper:'), `darwin still names the helper; got:\n${darwin}`);
  assert.ok(darwin.includes('exists=false'), 'darwin still reports the helper probe');
});


test('fixDirFor sanitizes a host into one leaf under <root>/fix/', () => {
  assert.strictEqual(fixDirFor('/r', 'bogdan@192.168.0.122'), path.join('/r', 'fix', 'bogdan-192.168.0.122'));
  assert.strictEqual(fixDirFor('/r', '@@@'), path.join('/r', 'fix', 'peer'));
  assert.strictEqual(fixDirFor('/r', ''), path.join('/r', 'fix', 'peer'));
  assert.strictEqual(fixDirFor('/r', null), path.join('/r', 'fix', 'peer'));
  assert.strictEqual(fixDirFor('/r', 'BOX.Example.COM'), path.join('/r', 'fix', 'box.example.com'));
});

test('fixDirFor can never produce a traversal, and caps the leaf at 64 chars', () => {
  const esc = fixDirFor('/r', 'a/../b');
  assert.ok(!esc.includes('..'), `no .. may survive sanitizing; got ${esc}`);
  assert.strictEqual(path.dirname(esc), path.join('/r', 'fix'), 'the result stays a direct child of fix/');
  assert.ok(!fixDirFor('/r', '..').includes('..'), 'a bare .. is not a leaf');

  const long = fixDirFor('/r', 'h'.repeat(200));
  assert.strictEqual(path.basename(long).length, 64, `leaf capped at 64; got ${path.basename(long).length}`);
  assert.strictEqual(path.dirname(long), path.join('/r', 'fix'));
});


test('peer:deployFix homes the seat in a 0700 dir under <root>/fix/ and marks the record fixFor', async () => {
  const root = mkTmpRoot('clx-t1002-fix-');
  const { log } = mkLog();
  const created = [];
  const persisted = [];
  const manager = {
    sessions: new Map(),
    create: async (...args) => { created.push(args); persisted.push({ name: args[0], cwd: args[2], fixFor: args[23] }); return { name: args[0] }; },
    _deliverMessage: () => {},
  };
  const handlers = mkDeployHandlers({ sshRun: async () => ({ code: 0 }), log, registryDir: root, manager });
  const res = await handlers.get('peer:deployFix')(SENDER, 'bogdan@192.168.0.122', 7911, 'desktop', '::fail preflight x');

  assert.strictEqual(res.ok, true, `mint failed: ${JSON.stringify(res)}`);
  assert.strictEqual(created.length, 1, 'ENTER: manager.create really ran');
  const cwd = created[0][2];
  assert.strictEqual(cwd, path.join(root, 'fix', 'bogdan-192.168.0.122'),
    `cwd must be the fix dir, not $HOME; got ${cwd}`);
  assert.ok(fs.existsSync(cwd), 'the dir exists before create() is called');
  assert.strictEqual(fs.statSync(cwd).mode & 0o777, 0o700, 'the fix dir is 0700');
  assert.strictEqual(persisted[0].fixFor, 'bogdan@192.168.0.122',
    'the host rides create() as fixFor and lands on the record');
  assert.strictEqual(res.fixFor, 'bogdan@192.168.0.122', 'the renderer is told the host so it can paint the chip');
  assert.strictEqual(res.cwd, cwd, 'the renderer is told the cwd for the sidebar row');
});

test('a fix session carries fixFor onto the live record and into session:list', async () => {
  const m = mk({});
  m.sessions.set('fix-a', { name: 'fix-a', type: 'claude', pty: { pid: 3 }, cwd: '/x', workspaceId: 'ws-1', agentType: null, fixFor: 'user@box' });
  m.sessions.set('plain-b', { name: 'plain-b', type: 'claude', pty: { pid: 4 }, cwd: '/x', workspaceId: 'ws-1', agentType: null });
  const rows = m.list();
  const fixRow = rows.find((r) => r.name === 'fix-a');
  const plainRow = rows.find((r) => r.name === 'plain-b');
  assert.strictEqual(fixRow.fixFor, 'user@box', 'session:list carries fixFor');
  assert.ok(!('fixFor' in plainRow), 'an ordinary seat has no fixFor key at all');
});


function loadApplyFixChip() {
  const src = fs.readFileSync(path.join(REPO, 'renderer', 'renderer.js'), 'utf8');
  const m = src.match(/^function applyFixChip\([\s\S]*?^\}$/m);
  assert.ok(m, 'ENTER: applyFixChip was found in renderer.js');
  return m[0];
}

function fakeBadgeItem() {
  const badges = { className: 'session-badges', children: [], appendChild(c) { badges.children.push(c); return c; } };
  return {
    dataset: {},
    querySelector: (sel) => (sel === '.session-badges' ? badges : null),
    badges,
  };
}

function runFixChip(item, host) {
  const made = [];
  const document = {
    createElement: () => {
      const node = { className: '', textContent: '', title: '', _html: null };
      Object.defineProperty(node, 'innerHTML', { get: () => node._html, set: (v) => { node._html = v; } });
      made.push(node);
      return node;
    },
  };
  const fn = new Function('document', `${loadApplyFixChip()}\nreturn applyFixChip;`)(document);
  fn(item, host);
  return made;
}

test('a session with fixFor renders a .session-fix chip naming the host, built without HTML', () => {
  const item = fakeBadgeItem();
  runFixChip(item, 'a<b@host');
  const chip = item.badges.children[0];
  assert.ok(chip, 'the chip was appended to .session-badges');
  assert.strictEqual(chip.className, 'session-fix');
  assert.strictEqual(chip.textContent, 'fix');
  assert.ok(chip.title.includes('a<b@host'), `the title names the host; got ${JSON.stringify(chip.title)}`);
  assert.match(chip.title, /runs ssh against that box/, 'the title says what the seat does');
  assert.strictEqual(chip._html, null, 'the chip was never built by assigning innerHTML');
  assert.ok(!String(chip.textContent).includes('<'), 'no host text reached the chip body');
});

test('a session without fixFor renders no chip at all', () => {
  for (const absent of [null, undefined, '', '   ']) {
    const item = fakeBadgeItem();
    runFixChip(item, absent);
    assert.strictEqual(item.badges.children.length, 0, `${JSON.stringify(absent)} must paint nothing`);
    assert.ok(!('fixFor' in item.dataset), 'and must not stamp the dataset');
  }
});

test('the .session-fix chip has a stylesheet rule beside .session-pr', () => {
  const css = fs.readFileSync(path.join(REPO, 'renderer', 'styles.css'), 'utf8');
  assert.match(css, /\.session-fix\s*\{/, 'styles.css defines .session-fix');
});


function el(tag = 'div') {
  const node = {
    tagName: tag,
    className: '',
    type: '',
    textContent: '',
    _html: null,
    children: [],
    parentNode: null,
    listeners: new Map(),
    addEventListener(t, fn) {
      if (!node.listeners.has(t)) node.listeners.set(t, []);
      node.listeners.get(t).push(fn);
    },
    appendChild(c) { c.parentNode = node; node.children.push(c); return c; },
    remove() {
      if (!node.parentNode) return;
      node.parentNode.children = node.parentNode.children.filter((c) => c !== node);
      node.parentNode = null;
    },
    querySelector(sel) {
      const want = sel.replace(/^\./, '');
      for (const c of node.children) {
        if (c.className.split(/\s+/).includes(want)) return c;
        const deep = c.querySelector(sel);
        if (deep) return deep;
      }
      return null;
    },
    async press() {
      for (const fn of node.listeners.get('click') || []) await fn({});
    },
  };
  Object.defineProperty(node, 'innerHTML', {
    get: () => node._html,
    set: (v) => { node._html = v; node.children = []; },
  });
  return node;
}

test('a successful fix mint creates the tab and makes it the active session', async () => {
  const src = fs.readFileSync(path.join(REPO, 'renderer', 'renderer.js'), 'utf8');
  const m = src.match(/^function appendDeployActions\([\s\S]*?^\}$/m);
  assert.ok(m, 'ENTER: appendDeployActions was found in renderer.js');

  const selected = [];
  const terminals = [];
  const rows = [];
  const stubs = {
    document: { createElement: (tag) => el(tag) },
    window: {
      api: {
        confirmDeployFix: async () => true,
        peerDeployFix: async () => ({ ok: true, name: 'fix-x', type: 'claude', cwd: '/root/fix/user-box', backend: null, fixFor: 'user@box' }),
      },
    },
    showToast: () => {},
    peerTestAndSetUp: () => {},
    sessions: new Map(),
    createTerminal: (n) => { terminals.push(n); },
    addSessionToSidebar: (...a) => { rows.push(a); },
    switchToNewSession: async (n, opts) => { selected.push([n, opts]); return true; },
  };
  const names = Object.keys(stubs);
  const appendDeployActions = new Function(...names, `${m[0]}\nreturn appendDeployActions;`)(...names.map((n) => stubs[n]));

  const tailBox = el();
  const labelInput = el('input');
  labelInput.className = 'peer-row-label';
  labelInput.value = 'desktop';
  const row = el();
  row.appendChild(labelInput);
  appendDeployActions(tailBox, row, {}, 'user@box', 7911, '::fail preflight node-not-found');
  await tailBox.querySelector('.peer-fix-btn').press();

  assert.deepStrictEqual(terminals, ['fix-x'], 'the new session got a terminal');
  assert.strictEqual(rows.length, 1, 'the new session got a sidebar row');
  assert.strictEqual(rows[0][0], 'fix-x');
  assert.strictEqual(rows[0][2], '/root/fix/user-box', 'the row carries the fix dir as its cwd');
  assert.strictEqual(rows[0][8], 'user@box', 'the row carries fixFor so the chip paints');
  assert.strictEqual(selected.length, 1, 'the select-session path ran exactly once');
  assert.strictEqual(selected[0][0], 'fix-x', 'it selected the minted session');
  assert.strictEqual(selected[0][1].agentInitiated, false, 'operator-pressed, so it may take focus');
  assert.ok(tailBox.querySelector('.peer-fix-working'), 'the t1000 working line is still left behind');
});


function mkArchiveFixture() {
  const archived = [];
  const added = [];
  const m = mk({
    getNotifications: () => ({ add: (rec) => { added.push(rec); return { id: 'nt01', ...rec }; } }),
    notifyOS: () => {},
    log: { info: () => {}, warn: () => {}, error: () => {} },
  });
  m._injectText = () => {};
  m._broadcast = () => {};
  m.archive = async (name) => { archived.push(name); };
  return { m, archived, added };
}

test('a DEPLOY OK note from a fixFor session archives it exactly once, by name', async () => {
  const { m, archived, added } = mkArchiveFixture();
  const session = { name: 'fix-desktop', agentType: 'claude', workspaceId: 'ws-1', fixFor: 'bogdan@example' };
  m._handleNotifyUserIntent(session, 'DEPLOY OK bogdan@example\napp=clodex version=5.77.0 host=box');
  await Promise.resolve();

  assert.deepStrictEqual(archived, ['fix-desktop'], 'archived once, with its own name');
  assert.strictEqual(added.length, 1, 'the note is still delivered to the inbox first');
});

test('the same DEPLOY OK body from a session without fixFor archives nothing', async () => {
  const { m, archived, added } = mkArchiveFixture();
  m._handleNotifyUserIntent({ name: 'ordinary', agentType: 'claude', workspaceId: 'ws-1' },
    'DEPLOY OK bogdan@example\napp=clodex version=5.77.0 host=box');
  await Promise.resolve();

  assert.deepStrictEqual(archived, [], 'an ordinary seat writing DEPLOY OK is never archived');
  assert.strictEqual(added.length, 1, 'its note is delivered like any other');
});

test('DEPLOY FAILED, or any other note, leaves the fix seat running', async () => {
  for (const body of [
    'DEPLOY FAILED bogdan@example\nnode is still missing',
    'blocked on which API to use',
    'the deploy is fine: DEPLOY OK bogdan@example',
    'deploy ok bogdan@example',
  ]) {
    const { m, archived, added } = mkArchiveFixture();
    m._handleNotifyUserIntent({ name: 'fix-desktop', agentType: 'claude', workspaceId: 'ws-1', fixFor: 'bogdan@example' }, body);
    await Promise.resolve();
    assert.deepStrictEqual(archived, [], `must not archive on: ${JSON.stringify(body)}`);
    assert.strictEqual(added.length, 1, 'the note is still delivered');
  }
});

test('the deploy-fix briefing pins the exact first lines and names the scratch dir', () => {
  const { buildDeployFixBriefing } = require('../peer-deploy');
  const b = buildDeployFixBriefing({ sshHost: 'user@box', port: 7911, label: 'desktop', logText: 'x', docsDir: '/app/peering' });
  assert.ok(b.includes('DEPLOY OK user@box'), 'the success first line is spelled out with the host');
  assert.ok(b.includes('DEPLOY FAILED user@box'), 'so is the failure one');
  assert.match(b, /scratch dir Clodex made for this fix; write notes there, not in \$HOME/,
    'the seat is told where to write notes');
});
