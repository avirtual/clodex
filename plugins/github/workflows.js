'use strict';

/**
 * github — the workflows.
 *
 * Each exported function is ONE thing an agent wants to know or do, assembled
 * from the five-to-ten `git` and `gh` calls it actually takes. That assembly is
 * the entire product: an agent that has `[agent:gh status]` spends one line
 * where it would otherwise spend six commands, four parses and two wrong
 * guesses. Nothing here is a wrapper around a single endpoint — if a function
 * ever collapses to one `gh` call plus a rename, it should be deleted and the
 * agent told to run `gh` itself.
 *
 * Rules that hold throughout:
 *  - NOTHING here rejects. Every function resolves to { ok, text } where `text`
 *    is what the agent will read. A failure is a normal result with an honest
 *    sentence in it, because "the call failed" is information the agent must
 *    act on, not an exception to swallow.
 *  - READ before WRITE, always. `openPr` re-checks for an existing PR after it
 *    has decided to create one is unnecessary; it checks BEFORE, and it refuses
 *    rather than guessing whenever the repository is not in the state the
 *    workflow assumes.
 *  - No credentials anywhere. See proc.js.
 */

const { git, gh, ghJson, explain, firstLine } = require('./proc');

// Injected text becomes a turn in the agent's input. These caps stop a CI log
// from eating a context window; the agent is told when it is reading a tail
// rather than the whole thing, because silently truncated evidence is how an
// agent concludes the wrong thing confidently.
const MAX_REPLY_CHARS = 3000;
const MAX_LOG_LINES_PER_JOB = 14;
const MAX_LOG_LINE_CHARS = 220;
const MAX_FAILING_JOBS = 3;
// Per-job budget inside the reply cap, so three jobs each get a real share
// instead of the first one spending the whole allowance and the other two
// arriving as "… (truncated)".
const MAX_LOG_CHARS_PER_JOB = 750;
const MAX_THREADS = 12;
const MAX_COMMITS_LISTED = 20;

// ---------------------------------------------------------------------------
// Text helpers
// ---------------------------------------------------------------------------

/**
 * Quoted content (a CI log line, a reviewer's comment) can itself begin with
 * `[agent:` at column 1. Intents are scanned from ASSISTANT text and this is
 * arriving as USER text, so it cannot fire — but an agent that reads a stray
 * `[agent:dm ops]` in a log tail may well copy it into its own reply, which
 * would. The documented `\[agent:` escape costs one character and removes the
 * question.
 */
function neuter(text) {
  return String(text == null ? '' : text).replace(/^(\s*)\[agent:/gm, '$1\\[agent:');
}

function clip(text, max) {
  const s = String(text == null ? '' : text);
  if (s.length <= max) return s;
  return `${s.slice(0, max - 40)}\n… (truncated, ${s.length - max + 40} more chars)`;
}

/** One long log line, truncated in place — no newline, no verbose marker. */
function clipLine(text, max) {
  const s = String(text == null ? '' : text);
  return s.length <= max ? s : `${s.slice(0, max)}…`;
}

/** Every reply the agent sees is built here: one prefix, one size cap. */
function reply(lines) {
  const body = (Array.isArray(lines) ? lines.filter((l) => l != null).join('\n') : String(lines)).trim();
  return clip(`[gh] ${body}`, MAX_REPLY_CHARS);
}

const fail = (lines) => ({ ok: false, text: reply(lines) });
const done = (lines) => ({ ok: true, text: reply(lines) });

function tailLines(text, n) {
  const all = String(text || '').split('\n').filter((l) => l.trim());
  if (all.length <= n) return all.join('\n');
  return `… ${all.length - n} earlier lines omitted …\n${all.slice(-n).join('\n')}`;
}

/**
 * `gh run view --log-failed` prefixes every line with
 * `<job>\t<step>\t<ISO timestamp> ` — three columns of noise repeated on each
 * of tens of thousands of lines. Strip them; the job name is already the
 * section header.
 */
function stripLogPrefix(line) {
  return String(line)
    .replace(/^[^\t]*\t[^\t]*\t/, '')
    .replace(/^\d{4}-\d\d-\d\dT[\d:.]+Z\s?/, '')
    .trimEnd();
}

/** Lines that name an actual failure, in rough order of usefulness. */
const ERROR_RE = /\b(FAIL(ED|URE)?|Error:|error:|ERROR|AssertionError|Exception|panic:|Traceback|not ok \d|✗|✖|npm ERR!|make(\[\d+\])?: \*\*\*|exit(ed with)? (code|status) [1-9]|undefined reference|cannot find|No such file|SyntaxError|TypeError|Segmentation fault)/;

/** Compiler/toolchain chatter that matches ERROR_RE only incidentally. */
const NOISE_RE = /^(\s*(sccache|ccache|g\+\+|gcc|clang|cc1plus|ld|ar|ranlib|python3?|node|make)\b|.*-D[A-Z_]+=|.*\.o\.d\.raw)/;

/**
 * THE POINT OF THE `ci` VERB. `--log-failed` is a build transcript: on a real
 * repository its tail is whatever the toolchain printed last, which is almost
 * never the error. An agent handed that tail reads four thousand compiler
 * invocations and learns nothing — and, worse, concludes something.
 *
 * So: strip the column noise, keep the lines that NAME a failure plus a little
 * context around each, and fall back to the tail only when nothing looks like
 * an error at all. State which of the two happened, because "here are the error
 * lines" and "here is the end of the log, I could not find an error" warrant
 * different next moves from the agent.
 */
function distillLog(raw, maxLines) {
  const lines = String(raw || '').split('\n').map(stripLogPrefix).filter((l) => l.trim());
  if (!lines.length) return null;

  const hits = [];
  for (let i = 0; i < lines.length; i++) {
    if (ERROR_RE.test(lines[i]) && !NOISE_RE.test(lines[i])) hits.push(i);
  }

  if (!hits.length) {
    return { mode: 'tail', text: tailLines(lines.map((l) => clipLine(l, MAX_LOG_LINE_CHARS)).join('\n'), maxLines) };
  }

  // Keep the LAST few hits — a build that fails late has its real error at the
  // end — with one line of context each, merged into runs.
  //
  // Context is filtered through the same noise rule as the hits themselves. An
  // error line sandwiched between two compiler invocations is the common case
  // (the failure interrupts an otherwise-chatty build), and unfiltered context
  // spends half the budget re-showing exactly what the hit filter just removed.
  const keep = new Set();
  for (const i of hits.slice(-Math.ceil(maxLines / 2))) {
    keep.add(i);
    for (const j of [i - 1, i + 1]) {
      if (j < 0 || j >= lines.length) continue;
      if (NOISE_RE.test(lines[j])) continue;
      keep.add(j);
    }
  }

  const idx = [...keep].sort((a, b) => a - b).slice(-maxLines);
  const out = [];
  let prev = -2;
  for (const i of idx) {
    if (i !== prev + 1 && out.length) out.push('  …');
    out.push(clipLine(lines[i], MAX_LOG_LINE_CHARS));
    prev = i;
  }
  return { mode: 'errors', text: out.join('\n'), hits: hits.length, total: lines.length };
}

// ---------------------------------------------------------------------------
// Repository context — the block every workflow starts from
// ---------------------------------------------------------------------------

/**
 * -> { ok:true, cwd, branch, detached, repo, base, remote } | { ok:false, text }
 *
 * Four failure modes get four different sentences, because they have four
 * different remedies: not a repo, no GitHub remote, gh missing, gh not logged
 * in. Collapsing them into "could not read the repo" is the failure this
 * function exists to avoid.
 */
async function context(cwd) {
  const head = await git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']);
  let branch = head.ok ? head.stdout.trim() : '';
  let unborn = false;

  if (!head.ok) {
    const m = `${head.stderr}`;
    if (/not a git repository/i.test(m)) {
      return fail('this session\'s working directory is not inside a git repository.');
    }
    // A repo with no commits yet: HEAD names a branch ref that has no object,
    // so rev-parse cannot resolve it even though the branch name is real. That
    // is a legitimate state with its own remedy, not a broken repository.
    if (/ambiguous argument|unknown revision|needed a single revision/i.test(m)) {
      const sym = await git(cwd, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
      if (!sym.ok || !sym.stdout) return fail(explain(head, 'reading the current branch'));
      branch = sym.stdout.trim();
      unborn = true;
    } else {
      return fail(explain(head, 'reading the current branch'));
    }
  }

  const detached = !unborn && (!branch || branch === 'HEAD');

  const view = await ghJson(cwd, ['repo', 'view', '--json', 'nameWithOwner,defaultBranchRef,isFork,viewerPermission']);
  if (!view.ok || !view.data) {
    return fail(explain(view, 'asking gh which repository this is'));
  }

  const repo = view.data.nameWithOwner || null;
  const base = (view.data.defaultBranchRef && view.data.defaultBranchRef.name) || null;
  if (!repo) return fail('gh did not report a repository for this directory.');

  return {
    ok: true,
    cwd,
    branch: detached ? null : branch,
    detached,
    unborn,
    repo,
    base,
    permission: view.data.viewerPermission || null,
    isFork: !!view.data.isFork,
  };
}

/**
 * The base ref to diff against, preferring the remote-tracking copy and SAYING
 * WHICH IT USED. `origin/main` may be hours stale because we deliberately do
 * not fetch (a fetch inside a status call is a surprise network write against
 * the operator's repo), so an agent that is told "vs origin/main (local copy,
 * not fetched)" can decide whether that matters. One that is told "vs main"
 * cannot.
 */
async function baseRef(cwd, base) {
  if (!base) return null;
  const remote = await git(cwd, ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${base}`]);
  if (remote.ok && remote.stdout) return `origin/${base}`;
  const local = await git(cwd, ['rev-parse', '--verify', '--quiet', `refs/heads/${base}`]);
  if (local.ok && local.stdout) return base;
  return null;
}

async function aheadBehind(cwd, ref) {
  if (!ref) return null;
  const r = await git(cwd, ['rev-list', '--left-right', '--count', `${ref}...HEAD`]);
  if (!r.ok) return null;
  const m = r.stdout.trim().split(/\s+/);
  if (m.length !== 2) return null;
  return { behind: Number(m[0]) || 0, ahead: Number(m[1]) || 0 };
}

async function dirtyFiles(cwd) {
  const r = await git(cwd, ['status', '--porcelain', '--untracked-files=no']);
  if (!r.ok) return null;
  return r.stdout.split('\n').map((l) => l.slice(3).trim()).filter(Boolean);
}

const PR_FIELDS = 'number,title,url,state,isDraft,baseRefName,headRefName,additions,deletions,changedFiles,reviewDecision,mergeable,mergeStateStatus';

/**
 * The PR for a branch, or null. `gh pr view` exits non-zero for "no PR", which
 * is not an error — distinguishing that from a real failure is the only reason
 * this is a function.
 */
async function prFor(cwd, branch) {
  const args = ['pr', 'view', '--json', PR_FIELDS];
  if (branch) args.push(branch);
  const r = await ghJson(cwd, args);
  if (r.ok) return { ok: true, pr: r.data || null };
  if (/no pull requests found|no open pull requests/i.test(`${r.stderr}${r.stdout}`)) {
    return { ok: true, pr: null };
  }
  return { ok: false, error: explain(r, 'looking up the pull request') };
}

/** Check buckets for a branch. `gh pr checks` exits 8 while checks are pending
 *  and 1 when a branch has no checks at all — both are answers, not errors. */
async function checksFor(cwd, branch) {
  const args = ['pr', 'checks', '--json', 'name,state,bucket,link,workflow'];
  if (branch) args.push(branch);
  const r = await ghJson(cwd, args);
  if (r.ok || (Array.isArray(r.data) && r.data.length)) {
    return { ok: true, checks: Array.isArray(r.data) ? r.data : [] };
  }
  const m = `${r.stderr}${r.stdout}`;
  if (/no checks reported|no pull requests found/i.test(m)) return { ok: true, checks: [] };
  // Exit 8 = pending; gh still printed the JSON, which ghJson parsed into data.
  if (r.code === 8 && Array.isArray(r.data)) return { ok: true, checks: r.data };
  return { ok: false, error: explain(r, 'reading CI checks') };
}

function bucketCounts(checks) {
  const c = { pass: 0, fail: 0, pending: 0, skipping: 0, cancel: 0 };
  for (const ch of checks) if (c[ch.bucket] != null) c[ch.bucket]++;
  return c;
}

// ---------------------------------------------------------------------------
// [agent:gh status]
// ---------------------------------------------------------------------------

/**
 * Collapses: git rev-parse · git status · git rev-list · gh repo view ·
 * gh pr view · gh pr checks · a GraphQL reviewThreads query — into one answer
 * an agent can act on. This is the verb that shortens a transcript most, and it
 * is the one an agent should reach for BEFORE deciding to open, update or merge
 * anything.
 */
async function status(cwd) {
  const ctx = await context(cwd);
  if (!ctx.ok) return ctx;

  if (ctx.unborn) {
    return done([
      `${ctx.repo} · branch ${ctx.branch} · default ${ctx.base || '?'}`,
      'this repository has no commits yet, so there is nothing to compare, no PR and no CI.',
    ]);
  }

  const [ref, dirty] = await Promise.all([baseRef(cwd, ctx.base), dirtyFiles(cwd)]);
  const ab = await aheadBehind(cwd, ref);

  const lines = [`${ctx.repo} · branch ${ctx.detached ? '(detached HEAD)' : ctx.branch} · default ${ctx.base || '?'}`];

  if (ab && ref) {
    const stale = ref.startsWith('origin/') ? ' (local copy of the remote ref; not fetched just now)' : ' (local branch)';
    lines.push(`${ab.ahead} commit(s) ahead / ${ab.behind} behind ${ref}${stale}`);
  } else if (ctx.base) {
    lines.push(`could not compare against ${ctx.base} — no local or remote-tracking ref for it`);
  }

  if (dirty && dirty.length) {
    lines.push(`uncommitted changes in ${dirty.length} file(s): ${dirty.slice(0, 8).join(', ')}${dirty.length > 8 ? ', …' : ''}`);
  } else if (dirty) {
    lines.push('working tree clean');
  }

  if (ctx.detached) {
    lines.push('detached HEAD — no branch, so there is no PR to look for.');
    return done(lines);
  }

  const prR = await prFor(cwd, ctx.branch);
  if (!prR.ok) { lines.push(prR.error); return done(lines); }

  if (!prR.pr) {
    lines.push('no pull request for this branch. `[agent:gh pr]` opens one.');
    return done(lines);
  }

  const pr = prR.pr;
  lines.push(`PR #${pr.number} ${pr.isDraft ? '(draft) ' : ''}${pr.state} — ${pr.title}`);
  lines.push(`  ${pr.url}`);
  lines.push(`  ${pr.baseRefName} ← ${pr.headRefName} · +${pr.additions}/-${pr.deletions} across ${pr.changedFiles} file(s)`);
  if (pr.reviewDecision) lines.push(`  review: ${pr.reviewDecision}`);
  if (pr.mergeable && pr.mergeable !== 'MERGEABLE') lines.push(`  mergeable: ${pr.mergeable}${pr.mergeStateStatus ? ` (${pr.mergeStateStatus})` : ''}`);

  const [chR, threads] = await Promise.all([
    checksFor(cwd, ctx.branch),
    unresolvedThreads(cwd, ctx.repo, pr.number).catch(() => null),
  ]);

  if (!chR.ok) {
    lines.push(`  CI: ${chR.error}`);
  } else if (!chR.checks.length) {
    lines.push('  CI: no checks reported for this branch');
  } else {
    const c = bucketCounts(chR.checks);
    lines.push(`  CI: ${c.pass} passing, ${c.fail} failing, ${c.pending} pending${c.skipping ? `, ${c.skipping} skipped` : ''}${c.cancel ? `, ${c.cancel} cancelled` : ''}`
      + (c.fail ? ' — `[agent:gh ci]` for the failing logs' : ''));
  }

  if (threads && threads.ok && threads.list.length) {
    lines.push(`  ${threads.list.length} unresolved review thread(s) — \`[agent:gh review]\` to read them`);
  }

  return done(lines);
}

// ---------------------------------------------------------------------------
// [agent:gh pr]
// ---------------------------------------------------------------------------

/** Commit subjects on this branch and not on the base, oldest first. */
async function commitsAhead(cwd, ref) {
  const r = await git(cwd, ['log', '--reverse', '--no-merges', '--format=%s', `${ref}..HEAD`]);
  if (!r.ok) return null;
  return r.stdout.split('\n').map((s) => s.trim()).filter(Boolean);
}

async function diffStat(cwd, ref) {
  const r = await git(cwd, ['diff', '--stat', `${ref}...HEAD`]);
  if (!r.ok) return null;
  const lines = r.stdout.split('\n').filter(Boolean);
  return lines.length ? lines[lines.length - 1].trim() : null;
}

async function changedFileList(cwd, ref) {
  const r = await git(cwd, ['diff', '--name-only', `${ref}...HEAD`]);
  if (!r.ok) return [];
  return r.stdout.split('\n').map((s) => s.trim()).filter(Boolean);
}

function humanizeBranch(branch) {
  return String(branch || '')
    .replace(/^(feat|feature|fix|bugfix|chore|docs|refactor|test)\//i, '')
    .replace(/[-_/]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^./, (c) => c.toUpperCase());
}

/**
 * The description an agent would otherwise write badly or not at all: a title
 * from the commits (or the branch, if the commits are a mess of "wip"), the
 * agent's own stated intent as the summary, and the commit list and diffstat as
 * evidence.
 *
 * Deliberately NOT a template the agent has to fill in. The agent's body is
 * optional; when it supplies one it leads, because a human-written "why" beats
 * a generated one and the generated part is only ever the "what".
 */
function assembleDescription({ branch, commits, stat, files, body }) {
  const meaningful = commits.filter((c) => !/^(wip|fixup!|squash!|amend)\b/i.test(c));
  const title = meaningful.length === 1 ? meaningful[0]
    : (humanizeBranch(branch) || (meaningful[0] || commits[0] || 'Changes'));

  const parts = [];
  if (body) parts.push(body.trim(), '');
  parts.push('## Commits', '');
  for (const c of commits.slice(0, MAX_COMMITS_LISTED)) parts.push(`- ${c}`);
  if (commits.length > MAX_COMMITS_LISTED) parts.push(`- … and ${commits.length - MAX_COMMITS_LISTED} more`);
  if (stat) parts.push('', '## Changes', '', stat);
  if (files.length && files.length <= 20) {
    parts.push('', ...files.map((f) => `- \`${f}\``));
  }
  return { title: title.slice(0, 240), body: parts.join('\n') };
}

/**
 * Collapses the whole open-a-PR dance: work out the base, confirm there is
 * something to review, refuse the states that would produce a misleading PR,
 * write a real description from the commits, push with an upstream, create, and
 * hand back the URL.
 *
 * `dry` runs everything up to and including the description and STOPS — no
 * push, no create. That is not a debugging affordance: it is how an agent shows
 * an operator what it is about to open.
 *
 * The refusals are the interesting part. Each one is a state in which the PR
 * would exist but be wrong, and an agent cannot tell the difference afterwards:
 *   - on the default branch      → the PR would be main←main
 *   - detached HEAD              → there is no branch to push
 *   - nothing ahead of base      → an empty PR
 *   - uncommitted changes        → a PR missing the work it is named after
 *   - a PR already open          → a duplicate, and the second one wins reviews
 */
async function openPr(cwd, { body, dry }) {
  const ctx = await context(cwd);
  if (!ctx.ok) return ctx;

  if (ctx.unborn) return fail(`${ctx.branch} has no commits yet — commit something before opening a PR.`);
  if (ctx.detached) return fail('detached HEAD — check out a branch before opening a PR.');
  if (!ctx.base) return fail('could not determine this repository\'s default branch, so there is no base to open a PR against.');
  if (ctx.branch === ctx.base) {
    return fail(`you are on ${ctx.base}, the default branch. Create a feature branch and commit to it first — a PR from ${ctx.base} to itself is not possible.`);
  }

  const existing = await prFor(cwd, ctx.branch);
  if (!existing.ok) return fail(existing.error);
  if (existing.pr) {
    return done([
      `a pull request for ${ctx.branch} already exists — not opening a second one.`,
      `PR #${existing.pr.number} ${existing.pr.isDraft ? '(draft) ' : ''}${existing.pr.state}: ${existing.pr.title}`,
      `  ${existing.pr.url}`,
      'Push more commits to update it; `[agent:gh status]` for its CI and review state.',
    ]);
  }

  const ref = await baseRef(cwd, ctx.base);
  if (!ref) return fail(`no local or remote-tracking ref for the base branch ${ctx.base}, so the PR contents cannot be determined.`);

  const commits = await commitsAhead(cwd, ref);
  if (!commits) return fail(`could not list the commits between ${ref} and HEAD.`);
  if (!commits.length) {
    return fail(`${ctx.branch} has no commits that ${ref} does not — there is nothing to open a PR for. Commit your work first.`);
  }

  const dirty = await dirtyFiles(cwd);
  if (dirty && dirty.length && !dry) {
    return fail([
      `${dirty.length} file(s) have uncommitted changes: ${dirty.slice(0, 8).join(', ')}${dirty.length > 8 ? ', …' : ''}`,
      'Those changes would NOT be in the PR. Commit them (or stash them) and ask again.',
    ]);
  }

  const [stat, files] = await Promise.all([diffStat(cwd, ref), changedFileList(cwd, ref)]);
  const desc = assembleDescription({ branch: ctx.branch, commits, stat, files, body });

  if (dry) {
    return done([
      `draft PR for ${ctx.repo}: ${ctx.base} ← ${ctx.branch} (${commits.length} commit(s))`,
      dirty && dirty.length ? `NOTE: ${dirty.length} file(s) are uncommitted and would be left out.` : null,
      '',
      `title: ${desc.title}`,
      '',
      neuter(desc.body),
      '',
      'Nothing was pushed or created. `[agent:gh pr]` opens it for real.',
    ]);
  }

  // Push. `-u origin HEAD` both creates the remote branch and sets the upstream,
  // which is what makes `gh pr create` able to infer the head ref. A branch that
  // already has an upstream is pushed the same way; git is idempotent here.
  const push = await git(cwd, ['push', '--set-upstream', 'origin', `HEAD:${ctx.branch}`], { timeout: 60000 });
  if (!push.ok) {
    return fail([
      `pushing ${ctx.branch} to origin failed, so no PR was created.`,
      explain(push, 'git push'),
    ]);
  }

  const created = await gh(cwd, [
    'pr', 'create',
    '--base', ctx.base,
    '--head', ctx.branch,
    '--title', desc.title,
    '--body', desc.body,
  ], { timeout: 60000 });

  if (!created.ok) {
    return fail([
      `the branch was pushed, but creating the PR failed: ${explain(created, 'gh pr create')}`,
      'The commits are on origin — retry, or open the PR in the browser.',
    ]);
  }

  const url = (created.stdout.match(/https:\/\/\S+/) || [])[0] || created.stdout.trim();
  return done([
    `opened ${ctx.base} ← ${ctx.branch} (${commits.length} commit(s), ${files.length} file(s))`,
    `title: ${desc.title}`,
    url,
  ]);
}

// ---------------------------------------------------------------------------
// [agent:gh ci]
// ---------------------------------------------------------------------------

/** The workflow-run id embedded in a check's link, if there is one. */
function runIdFromLink(link) {
  const m = String(link || '').match(/\/actions\/runs\/(\d+)/);
  return m ? m[1] : null;
}

/**
 * Collapses "why is CI red": find the checks, pick the failing ones, resolve
 * each to its workflow run, pull ONLY the failed steps' logs, and tail them.
 *
 * The tail is the point. `gh run view --log-failed` on a real repo is tens of
 * thousands of lines; an agent that pipes that into its own context has spent
 * its budget to learn one assertion name. Three jobs, forty lines each, capped
 * again at the reply — and the omission is stated so the agent knows to ask for
 * more rather than assuming it read everything.
 */
async function ci(cwd) {
  const ctx = await context(cwd);
  if (!ctx.ok) return ctx;
  if (ctx.unborn) return fail(`${ctx.branch} has no commits yet, so there is no CI to report.`);
  if (ctx.detached) return fail('detached HEAD — no branch, so there are no checks to look up.');

  const chR = await checksFor(cwd, ctx.branch);
  if (!chR.ok) return fail(chR.error);

  if (!chR.checks.length) {
    // No PR checks: fall back to the branch's own workflow runs, which is where
    // a pre-PR agent's CI actually lives.
    const runs = await ghJson(cwd, ['run', 'list', '--branch', ctx.branch, '--limit', '3',
      '--json', 'databaseId,conclusion,status,displayTitle,url,workflowName']);
    if (!runs.ok) return fail(explain(runs, 'listing workflow runs'));
    const list = Array.isArray(runs.data) ? runs.data : [];
    if (!list.length) return done(`no CI checks and no workflow runs for ${ctx.branch}.`);
    const bad = list.filter((r) => r.conclusion && r.conclusion !== 'success' && r.conclusion !== 'skipped');
    if (!bad.length) {
      return done([`no PR checks for ${ctx.branch}; its most recent workflow run(s) are ${list.map((r) => `${r.workflowName}: ${r.status}/${r.conclusion || 'running'}`).join(', ')}.`]);
    }
    return failingRunReport(cwd, ctx, bad.slice(0, MAX_FAILING_JOBS).map((r) => ({
      name: r.workflowName || r.displayTitle, runId: String(r.databaseId), link: r.url,
    })));
  }

  const c = bucketCounts(chR.checks);
  const failing = chR.checks.filter((ch) => ch.bucket === 'fail');

  if (!failing.length) {
    return done([
      `${ctx.repo} ${ctx.branch}: ${c.pass} passing, ${c.pending} pending${c.skipping ? `, ${c.skipping} skipped` : ''}${c.cancel ? `, ${c.cancel} cancelled` : ''} — nothing failing.`,
      c.pending ? 'Some checks are still running; ask again when they settle.' : null,
    ]);
  }

  const jobs = [];
  const seen = new Set();
  for (const ch of failing) {
    const runId = runIdFromLink(ch.link);
    const key = runId || ch.name;
    if (seen.has(key)) continue;
    seen.add(key);
    jobs.push({ name: ch.name, workflow: ch.workflow, runId, link: ch.link });
    if (jobs.length >= MAX_FAILING_JOBS) break;
  }

  return failingRunReport(cwd, ctx, jobs, { counts: c, total: failing.length });
}

async function failingRunReport(cwd, ctx, jobs, meta) {
  const head = meta && meta.counts
    ? `${ctx.repo} ${ctx.branch}: ${meta.total} check(s) failing (${meta.counts.pass} passing, ${meta.counts.pending} pending).`
    : `${ctx.repo} ${ctx.branch}: failing workflow run(s).`;

  const out = [head];
  if (meta && meta.total > jobs.length) out.push(`Showing the first ${jobs.length}.`);

  for (const job of jobs) {
    out.push('', `--- ${job.name}${job.workflow ? ` (${job.workflow})` : ''} ---`);
    if (job.link) out.push(job.link);
    if (!job.runId) { out.push('(no workflow run behind this check — logs are not available through gh)'); continue; }

    const log = await gh(cwd, ['run', 'view', job.runId, '--log-failed'], { timeout: 90000 });
    if (!log.ok) { out.push(`could not fetch its log: ${firstLine(log)}`); continue; }

    const d = distillLog(log.stdout, MAX_LOG_LINES_PER_JOB);
    if (!d) { out.push('(gh reported no failed-step output for this run — the job may have been cancelled or timed out rather than failing a step)'); continue; }
    out.push(d.mode === 'errors'
      ? `error lines (${d.hits} of ${d.total} log lines matched):`
      : 'no line in this log names an error; showing its tail:');
    out.push(neuter(clip(d.text, MAX_LOG_CHARS_PER_JOB)));
  }

  return done(out);
}

// ---------------------------------------------------------------------------
// [agent:gh review]
// ---------------------------------------------------------------------------

const THREADS_QUERY = `query($o:String!,$r:String!,$n:Int!){
  repository(owner:$o,name:$r){
    pullRequest(number:$n){
      reviewThreads(first:50){nodes{
        isResolved isOutdated path line originalLine
        comments(first:5){nodes{author{login} body}}
      }}
    }
  }
}`;

/** -> { ok:true, list } | { ok:false, error } */
async function unresolvedThreads(cwd, nameWithOwner, number) {
  const [owner, name] = String(nameWithOwner || '').split('/');
  if (!owner || !name) return { ok: false, error: 'could not split the repository into owner/name.' };

  const r = await ghJson(cwd, ['api', 'graphql', '-f', `query=${THREADS_QUERY}`,
    '-F', `o=${owner}`, '-F', `r=${name}`, '-F', `n=${number}`]);
  if (!r.ok) return { ok: false, error: explain(r, 'querying review threads') };

  const nodes = (((r.data || {}).data || {}).repository || {}).pullRequest;
  const threads = (nodes && nodes.reviewThreads && nodes.reviewThreads.nodes) || [];
  return { ok: true, list: threads.filter((t) => t && !t.isResolved) };
}

/**
 * Collapses "what does the review actually want": the GraphQL query an agent
 * will otherwise get wrong twice, plus the top-level reviews, rendered as a
 * compact worklist rather than an API response.
 *
 * Resolved threads are dropped and outdated ones are flagged: an agent that
 * re-fixes a resolved comment wastes a round trip, and one that acts on an
 * outdated line number edits the wrong place.
 */
async function review(cwd) {
  const ctx = await context(cwd);
  if (!ctx.ok) return ctx;
  if (ctx.unborn) return fail(`${ctx.branch} has no commits yet, so there is no PR to read reviews from.`);
  if (ctx.detached) return fail('detached HEAD — no branch, so no PR to read reviews from.');

  const prR = await prFor(cwd, ctx.branch);
  if (!prR.ok) return fail(prR.error);
  if (!prR.pr) return fail(`no pull request for ${ctx.branch}, so there is nothing to review.`);

  const pr = prR.pr;
  const [threads, reviews] = await Promise.all([
    unresolvedThreads(cwd, ctx.repo, pr.number),
    ghJson(cwd, ['pr', 'view', String(pr.number), '--json', 'reviews']),
  ]);

  const out = [`PR #${pr.number} ${pr.title}`, `  ${pr.url}`];
  if (pr.reviewDecision) out.push(`  decision: ${pr.reviewDecision}`);

  if (reviews.ok && reviews.data && Array.isArray(reviews.data.reviews)) {
    const notable = reviews.data.reviews.filter((rv) => rv && rv.state === 'CHANGES_REQUESTED' && rv.body && rv.body.trim());
    for (const rv of notable.slice(-3)) {
      out.push('', `${(rv.author && rv.author.login) || 'reviewer'} requested changes:`);
      out.push(neuter(clip(rv.body.trim(), 600)));
    }
  }

  if (!threads.ok) {
    out.push('', threads.error);
    return done(out);
  }
  if (!threads.list.length) {
    out.push('', 'No unresolved review threads.');
    return done(out);
  }

  out.push('', `${threads.list.length} unresolved thread(s):`);
  for (const t of threads.list.slice(0, MAX_THREADS)) {
    const where = `${t.path || '(no file)'}${t.line || t.originalLine ? `:${t.line || t.originalLine}` : ''}`;
    const first = ((t.comments && t.comments.nodes) || [])[0];
    const who = (first && first.author && first.author.login) || 'reviewer';
    const what = clip(String((first && first.body) || '').trim().replace(/\s*\n\s*/g, ' '), 240);
    out.push(`- ${where}${t.isOutdated ? ' [OUTDATED — the line has moved since]' : ''} — ${who}: ${neuter(what)}`);
  }
  if (threads.list.length > MAX_THREADS) out.push(`… and ${threads.list.length - MAX_THREADS} more.`);

  return done(out);
}

module.exports = {
  status, openPr, ci, review,
  // exported for the test harness
  _internals: { assembleDescription, humanizeBranch, neuter, tailLines, distillLog, stripLogPrefix, clip, clipLine, runIdFromLink, context, prFor, checksFor, bucketCounts, reply, MAX_REPLY_CHARS },
};
