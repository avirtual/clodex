'use strict';

const SIDECAR_NAME = '.clodex-source.json';

function parseSourceSpec(text) {
  const raw = typeof text === 'string' ? text.trim() : '';
  if (!raw) return { ok: false, error: 'empty source' };
  if (/^git@/i.test(raw) || /^ssh:\/\//i.test(raw)) {
    return { ok: false, error: 'ssh remotes are not supported — use owner/repo or an https://github.com URL' };
  }

  let owner; let repo; let ref = null; let subpath = null;

  if (/^https?:\/\//i.test(raw)) {
    let u;
    try { u = new URL(raw); } catch (e) {
      return { ok: false, error: `not a valid URL: ${(e && e.message) || e}` };
    }
    if (u.protocol !== 'https:') return { ok: false, error: 'only https:// URLs are supported' };
    if (u.hostname.toLowerCase() !== 'github.com') {
      return { ok: false, error: `only github.com URLs are supported, got ${JSON.stringify(u.hostname)}` };
    }
    const parts = u.pathname.split('/').filter(Boolean);
    if (parts.length < 2) return { ok: false, error: 'a github.com URL must name an owner and a repo' };
    [owner, repo] = parts;
    const rest = parts.slice(2);
    if (rest.length) {
      if (rest[0] !== 'tree' || rest.length < 2) {
        return { ok: false, error: 'expected /tree/<ref>/<path> after the repo' };
      }
      ref = rest[1];
      subpath = rest.length > 2 ? rest.slice(2).join('/') : null;
    }
  } else {
    const m = /^([^/@:]+)\/([^/@:]+)(?:@([^:]+))?(?::(.+))?$/.exec(raw);
    if (!m) return { ok: false, error: `not a recognized source spec: ${JSON.stringify(raw)}` };
    [, owner, repo, ref, subpath] = m;
    ref = ref || null;
    subpath = subpath || null;
  }

  repo = repo.replace(/\.git$/i, '');

  if (!owner || !/^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/.test(owner)) {
    return { ok: false, error: `invalid owner: ${JSON.stringify(owner)}` };
  }
  if (!repo || !/^[A-Za-z0-9._-]+$/.test(repo) || repo === '.' || repo === '..') {
    return { ok: false, error: `invalid repo name: ${JSON.stringify(repo)}` };
  }
  if (subpath != null) {
    subpath = subpath.trim();
    if (subpath.startsWith('/')) return { ok: false, error: 'subpath must be relative, not absolute' };
    if (subpath.split('/').some((seg) => seg === '.' || seg === '..')) {
      return { ok: false, error: 'subpath must not contain . or .. segments' };
    }
    if (!subpath) subpath = null;
  }

  return { ok: true, repo: `${owner}/${repo}`, ref: ref || null, subpath: subpath || null };
}

function encodeRefPath(ref) {
  return String(ref).split('/').map(encodeURIComponent).join('/');
}

function createPluginSource(deps) {
  const { fs, path, https, execFile } = deps || {};

  function fetchTarball({ repo, ref }, destFile, { maxBytes = 20 * 1024 * 1024 } = {}) {
    if (!https) return Promise.resolve({ ok: false, error: 'no https dependency injected' });
    return new Promise((resolve) => {
      const base = `https://api.github.com/repos/${repo}/tarball`;
      const url = ref ? `${base}/${encodeRefPath(ref)}` : base;
      const get = (u, redirectsLeft) => {
        const req = https.get(u, { headers: { 'User-Agent': 'Clodex-PluginSource' } }, (res) => {
          if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            res.resume();
            if (redirectsLeft <= 0) { resolve({ ok: false, error: 'too many redirects' }); return; }
            try {
              get(res.headers.location, redirectsLeft - 1);
            } catch (e) {
              resolve({ ok: false, error: `bad redirect location — ${(e && e.message) || e}` });
            }
            return;
          }
          if (res.statusCode !== 200) {
            res.resume();
            resolve({ ok: false, error: `HTTP ${res.statusCode} fetching ${u}` });
            return;
          }
          let total = 0;
          let settled = false;
          const done = (result) => { if (!settled) { settled = true; resolve(result); } };
          const out = fs.createWriteStream(destFile);
          res.on('data', (chunk) => {
            total += chunk.length;
            if (total > maxBytes) {
              res.destroy();
              out.destroy();
              try { fs.unlinkSync(destFile); } catch {}
              done({ ok: false, error: `tarball exceeds the ${maxBytes}-byte cap` });
            }
          });
          res.on('error', (e) => done({ ok: false, error: String((e && e.message) || e) }));
          out.on('error', (e) => done({ ok: false, error: String((e && e.message) || e) }));
          out.on('finish', () => done({ ok: true, file: destFile }));
          res.pipe(out);
        });
        req.setTimeout(30_000, () => req.destroy(new Error('timed out')));
        req.on('error', (e) => resolve({ ok: false, error: String((e && e.message) || e) }));
      };
      get(url, 5);
    });
  }

  function extractPlugin(tarFile, workDir, subpath) {
    if (!execFile) return Promise.resolve({ ok: false, error: 'no execFile dependency injected' });
    return new Promise((resolve) => {
      try { fs.mkdirSync(workDir, { recursive: true }); } catch (e) {
        resolve({ ok: false, error: `could not create ${workDir} — ${(e && e.message) || e}` });
        return;
      }
      execFile('tar', ['-xzf', tarFile, '-C', workDir], (err, stdout, stderr) => {
        if (err) {
          resolve({ ok: false, error: `tar extraction failed — ${(stderr && String(stderr).trim()) || (err && err.message) || err}` });
          return;
        }
        let entries;
        try {
          entries = fs.readdirSync(workDir, { withFileTypes: true }).filter((e) => e.isDirectory());
        } catch (e) {
          resolve({ ok: false, error: `could not read ${workDir} — ${(e && e.message) || e}` });
          return;
        }
        if (entries.length !== 1) {
          resolve({ ok: false, error: `expected exactly one top-level directory in the tarball, found ${entries.length}` });
          return;
        }
        const topDir = path.join(workDir, entries[0].name);
        const shaMatch = /-([0-9a-f]{7,40})$/i.exec(entries[0].name);
        const commit = shaMatch ? shaMatch[1] : null;
        const dir = subpath ? path.join(topDir, subpath) : topDir;
        if (dir !== topDir && !dir.startsWith(topDir + path.sep)) {
          resolve({ ok: false, error: 'subpath escapes the extracted directory' });
          return;
        }
        resolve({ ok: true, dir, commit });
      });
    });
  }

  function fetchCommitSha({ repo, ref }) {
    if (!https || !ref) return Promise.resolve(null);
    return new Promise((resolve) => {
      const url = `https://api.github.com/repos/${repo}/commits/${encodeRefPath(ref)}`;
      const req = https.get(url, {
        headers: { 'User-Agent': 'Clodex-PluginSource', Accept: 'application/vnd.github+json' },
      }, (res) => {
        if (res.statusCode !== 200) { res.resume(); resolve(null); return; }
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          try {
            const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            resolve(typeof parsed.sha === 'string' ? parsed.sha : null);
          } catch { resolve(null); }
        });
        res.on('error', () => resolve(null));
      });
      req.setTimeout(30_000, () => req.destroy(new Error('timed out')));
      req.on('error', () => resolve(null));
    });
  }

  function readSidecar(dir) {
    try {
      const parsed = JSON.parse(fs.readFileSync(path.join(dir, SIDECAR_NAME), 'utf8'));
      return (parsed && typeof parsed === 'object') ? parsed : null;
    } catch { return null; }
  }

  function writeSidecar(dir, meta) {
    const file = path.join(dir, SIDECAR_NAME);
    const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
    fs.writeFileSync(tmp, JSON.stringify(meta, null, 2));
    fs.renameSync(tmp, file);
  }

  return { parseSourceSpec, fetchTarball, extractPlugin, fetchCommitSha, readSidecar, writeSidecar };
}

module.exports = { createPluginSource, parseSourceSpec, SIDECAR_NAME };
