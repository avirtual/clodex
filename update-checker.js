// update-checker.js — the GitHub-release update poller (data layer). fetchJson
// (JSON GET with redirect follow + timeout) and isNewer (semver compare) are
// pure and move here byte-identical. refreshReleases + fetchLatestUpdate are the
// ONE sanctioned owner-side transform of M3: the originals wrote the updateInfo /
// releasesCache module vars in main.js; here they RETURN their results and main
// keeps that state plus every electron side effect (banner send, notification,
// tray). app.getVersion is injected into fetchLatestUpdate as getVersion.
//
// Only isNewer is unit-tested — everything else routes through the module-
// internal fetchJson (real GitHub API), so it's integration-only.

const https = require('https');

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    const req = https.request(url, {
      headers: {
        'User-Agent': 'Clodex-UpdateChecker',
        'Accept': 'application/vnd.github+json',
      },
    }, (res) => {
      // Follow redirects
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        resolve(fetchJson(res.headers.location));
        return;
      }
      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode}`));
        return;
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf-8'))); }
        catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.setTimeout(10000, () => req.destroy(new Error('timeout')));
    req.end();
  });
}

// Simple semver compare: returns true if `a` is newer than `b`
function isNewer(a, b) {
  const clean = (v) => String(v).replace(/^v/, '').split(/[.-]/).map(Number);
  const [aM = 0, am = 0, ap = 0] = clean(a);
  const [bM = 0, bm = 0, bp = 0] = clean(b);
  if (aM !== bM) return aM > bM;
  if (am !== bm) return am > bm;
  return ap > bp;
}


// TRANSFORM (M3, sanctioned): was the head of checkForUpdate, which wrote the
// updateInfo module var. Fetches the latest release and RETURNS { updateInfo,
// current } — updateInfo is { version, url } when newer, else null. getVersion
// is injected (electron app.getVersion). Throws on network failure exactly like
// the fetch it wraps, so the caller keeps its existing try/catch.
async function fetchLatestUpdate(repo, getVersion) {
  const release = await fetchJson(
    `https://api.github.com/repos/${repo}/releases/latest`,
  );
  const latestTag = release.tag_name || '';
  const latestVersion = latestTag.replace(/^v/, '');
  const current = getVersion();
  const updateInfo = isNewer(latestVersion, current)
    ? { version: latestVersion, url: release.html_url }
    : null;
  return { updateInfo, current };
}


// TRANSFORM (M3, sanctioned): was refreshReleases() writing the releasesCache
// module var. Now takes the repo and RETURNS the newest-first release list, or
// null on failure / a non-array body so the caller keeps whatever it had cached.
async function refreshReleases(repo) {
  try {
    const rels = await fetchJson(
      `https://api.github.com/repos/${repo}/releases?per_page=100`,
    );
    if (Array.isArray(rels)) {
      return rels.map((r) => ({
        tag: r.tag_name || '',
        published_at: r.published_at || '',
      }));
    }
  } catch (err) {
    // Return null so the caller keeps its prior cache.
  }
  return null;
}

module.exports = { fetchJson, isNewer, refreshReleases, fetchLatestUpdate };
