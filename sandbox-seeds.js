'use strict';

async function readBody(res) {
  try { return String(await res.text()).trim().slice(0, 300); } catch { return ''; }
}

async function seedSandboxSessions({ wireUrl, token, seeds, fetch } = {}) {
  const list = Array.isArray(seeds) ? seeds.filter(Boolean) : [];
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

  const seeded = [];
  for (const seed of list) {
    if (existing.has(seed.name)) { seeded.push(seed.name); continue; }
    const res = await doFetch(`${base}/api/sessions`, {
      method: 'POST', headers, body: JSON.stringify(seed),
    });
    if (res && res.status >= 200 && res.status < 300) { seeded.push(seed.name); continue; }
    const text = await readBody(res);
    if (res && res.status === 400 && /name taken/i.test(text)) { seeded.push(seed.name); continue; }
    return { ok: false, error: `seeding ${seed.name}: ${res ? res.status : 'no response'} ${text}`.trim(), seeded };
  }
  return { ok: true, seeded };
}

module.exports = { seedSandboxSessions };
