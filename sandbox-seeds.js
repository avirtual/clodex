'use strict';

async function readBody(res) {
  try { return String(await res.text()).trim().slice(0, 300); } catch { return ''; }
}

async function seedSandboxSessions({ wireUrl, token, seeds, optional, fetch } = {}) {
  const list = Array.isArray(seeds) ? seeds.filter(Boolean) : [];
  const mayFail = new Set(Array.isArray(optional) ? optional : []);
  if (!wireUrl) return { ok: false, error: 'box has no wire port to seed over' };
  const doFetch = fetch || globalThis.fetch;
  const base = String(wireUrl).replace(/\/+$/, '');
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

  const listed = await doFetch(`${base}/api/sessions`, { headers });
  if (!listed || !(listed.status >= 200 && listed.status < 300)) {
    return { ok: false, error: `listing box sessions: ${listed ? listed.status : 'no response'} ${await readBody(listed)}`.trim() };
  }
  let existing = new Set();
  try {
    const body = await listed.json();
    for (const s of (body && body.sessions) || []) if (s && s.name) existing.add(s.name);
  } catch { existing = new Set(); }

  const results = [];
  for (const seed of list) {
    if (existing.has(seed.name)) { results.push({ name: seed.name, state: 'present' }); continue; }
    const res = await doFetch(`${base}/api/sessions`, {
      method: 'POST', headers, body: JSON.stringify(seed),
    });
    if (res && res.status >= 200 && res.status < 300) { results.push({ name: seed.name, state: 'seeded' }); continue; }
    const text = await readBody(res);
    if (res && res.status === 400 && /name taken/i.test(text)) { results.push({ name: seed.name, state: 'present' }); continue; }
    const why = `${res ? res.status : 'no response'} ${String(text).split('\n')[0].trim()}`.trim();
    results.push({ name: seed.name, state: 'failed', error: why });
    if (!mayFail.has(seed.name)) return { ok: false, error: `seeding ${seed.name}: ${why}`, results };
  }
  return { ok: true, results };
}

module.exports = { seedSandboxSessions };
