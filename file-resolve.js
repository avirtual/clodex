// file-resolve.js — turn a path as it was DISPLAYED into a path that exists.
// Pure leaf (no electron, fs injected), like path-confine / clodex-paths, and
// NOT in the leak-scanner SCANNED lists for the same reason.
//
// Every path a user clicks was written for a human: relative to the repo, to
// the file it appears in, or shortened to fit a terminal. Passing that string
// to `fetchFilePeek` resolves it against the MAIN PROCESS's cwd, which is
// whatever directory Clodex was launched from — it appears to work in dev
// (launched from the project) and fails from Finder. This is the missing step.
//
// Candidates are tried in order of how strongly each implies the user's intent,
// and the FIRST that stats as a regular file wins. No globbing, no walking a
// tree: a wrong file opened confidently is worse than an honest miss.
//
// Deliberately NOT confined to the session cwd. Reading bytes into a modal is
// not an authority (`fetchFilePeek` already takes any absolute path), and a
// click on `~/.clodex/run/x/agent.json` should work. WRITING is confined —
// file-edit.js refuses anything outside the cwd — so the Edit tab is simply
// unavailable on a file resolved outside it. Read anywhere, write in the repo.

const CANDIDATE_CAP = 40; // touched-files suffix matching is O(n); bound it

// `raw` as displayed; `cwd` the session's; `baseDir` the directory of the file
// the text appeared IN (the peek's own path — null for a terminal click);
// `touched` the session's touched-file absolutes (file-touch.js), used as a
// suffix-match candidate list for paths too shortened to resolve otherwise.
//
// Returns { ok: true, path, via } — `via` naming which rule matched, so a
// surprising result is explainable — or { ok: false, error }.
function resolveDisplayedPath({ raw, cwd, baseDir = null, touched = [], home, path, statFile }) {
  const trimmed = (raw || '').trim();
  if (!trimmed) return { ok: false, error: 'Empty path' };

  const isFile = (p) => {
    try { return !!p && statFile(p); } catch { return false; }
  };

  // `~` is a shell-ism the CLI prints and no fs call understands.
  const expanded = trimmed === '~' || trimmed.startsWith('~/')
    ? path.join(home || '', trimmed.slice(1))
    : trimmed;

  // `@file.md` is the CLI's load-this-file syntax: the `@` is a sigil, not part
  // of the name. The scanner keeps it because `@` is a legal path character and
  // dropping it would break `@babel/core/index.js`, so the ambiguity lands here.
  // Both readings are tried, LITERAL FIRST — a file actually named `@x.md` is a
  // fact, the sigil reading is an inference, and only one of them can be wrong.
  const forms = [expanded];
  if (expanded.length > 1 && expanded.startsWith('@')) forms.push(expanded.slice(1));

  const tries = [];
  for (const form of forms) {
    if (path.isAbsolute(form)) {
      tries.push(['absolute', form]);
    } else {
      // The file's own directory FIRST: a relative path written inside a file is
      // relative to that file far more often than to the repo root, and when both
      // exist the local one is what the author meant.
      if (baseDir) tries.push(['relative to the open file', path.resolve(baseDir, form)]);
      if (cwd) tries.push(['relative to the session directory', path.resolve(cwd, form)]);
    }
  }

  for (const [via, p] of tries) {
    if (isFile(p)) return { ok: true, path: p, via };
  }

  // Last resort, and the one that earns its keep on TRUNCATED paths (`…/foo.js`
  // as the terminal shortened it): match the tail against files this session is
  // known to have touched. A unique suffix match is a strong signal; an
  // ambiguous one is refused rather than guessed, because picking arbitrarily
  // between two real files is exactly the confident-wrong-answer failure.
  // Strip whatever the shortener left in front — `…`, `...`, `./`, `../` — and
  // then any leading slash, so the remainder is a clean run of segments. The
  // slash strip must come LAST: `…/a/b.js` still starts with `/` after the
  // ellipsis goes, and a tail beginning with `/` can never match `'/' + tail`.
  // `@` leads the strip list for the same reason it is tried above: a sigil the
  // CLI prints, never part of the name once the shortener has already cut the
  // front off the path.
  const tail = expanded.replace(/^[@….]+/, '').replace(/^(?:\.{0,2}\/)+/, '').replace(/^\/+/, '');
  if (tail) {
    const hits = [];
    for (const t of (touched || []).slice(0, CANDIDATE_CAP)) {
      const abs = typeof t === 'string' ? t : (t && t.path);
      if (!abs) continue;
      if (abs === tail || abs.endsWith('/' + tail)) hits.push(abs);
    }
    const unique = [...new Set(hits)];
    if (unique.length === 1 && isFile(unique[0])) {
      return { ok: true, path: unique[0], via: 'a file this session touched' };
    }
    if (unique.length > 1) {
      return { ok: false, error: `Ambiguous: ${unique.length} touched files end with "${tail}"` };
    }
  }

  return { ok: false, error: `Can't find "${trimmed}"` };
}

module.exports = { resolveDisplayedPath, CANDIDATE_CAP };
