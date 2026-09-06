'use strict';

const INSTALL_REASONS = {
  unresolved: 'Resolve the repo first — Clodex reads its manifest before anything is downloaded.',
  failed: 'That resolve did not succeed — fix the spec and resolve again.',
  stale: 'The spec changed since the last resolve — resolve it again.',
  unchanged: 'The source still resolves to the commit already installed — there is nothing to update to.',
};

function shortCommit(commit) {
  return commit == null ? '' : String(commit).slice(0, 7);
}

function refLabel(resolved) {
  const ref = resolved && resolved.ref;
  return ref ? String(ref) : 'the default branch';
}

function sourceLabel(resolved) {
  const r = resolved || {};
  const repo = r.repo == null ? '' : String(r.repo);
  const ref = r.ref ? `@${r.ref}` : '';
  const sub = r.subpath ? `:${r.subpath}` : '';
  return `${repo}${ref}${sub}`;
}

function previewLines(resolved) {
  if (!resolved || !resolved.ok) return [];
  const m = resolved.manifest || {};
  const id = m.id || resolved.id || '';
  const name = m.name || id;
  const version = m.version ? `v${m.version}` : 'no version';
  return [
    `${name} — ${id} ${version}`,
    `${sourceLabel(resolved)} at commit ${shortCommit(resolved.commit) || 'unknown'}`,
  ];
}

function warningText(resolved, opts) {
  if (!resolved || !resolved.ok) return '';
  const where = opts && opts.remote
    ? 'This code will run on the Clodex host this browser is connected to, with the app\'s full authority, the same as Clodex itself. '
    : `This code will run inside Clodex with the app's full authority, the same as Clodex itself. `;
  return where
    + `It comes from github.com/${resolved.repo} at ${refLabel(resolved)} (commit ${shortCommit(resolved.commit)}). `
    + 'Clodex cannot check what it does — install it only if you trust its author.';
}

function webRendererNote(resolved) {
  const entry = resolved && resolved.manifest && resolved.manifest.entry;
  if (!entry || !entry.renderer) return '';
  return ' Its renderer half shows in the desktop app only — this browser\'s bundle is built from the plugins shipped with Clodex.';
}

function sourceLine(source) {
  if (!source || !source.repo) return '';
  const sub = source.subpath ? `:${source.subpath}` : '';
  const at = shortCommit(source.commit) || 'an unknown commit';
  return `From github.com/${source.repo}@${refLabel(source)}${sub} at ${at}`;
}

function updatePreviewLines(resolved) {
  if (!resolved || !resolved.ok) return [];
  const m = resolved.manifest || {};
  const id = m.id || resolved.id || '';
  const name = m.name || id;
  const was = resolved.previousVersion ? `v${resolved.previousVersion}` : 'no version';
  const now = m.version ? `v${m.version}` : 'no version';
  return [
    `${name} — ${id} ${was} → ${now}`,
    `${shortCommit(resolved.previousCommit) || 'unknown'} → ${shortCommit(resolved.commit) || 'unknown'}`,
  ];
}

function installState({ resolved, fieldValue, mode } = {}) {
  if (!resolved) return { enabled: false, reason: INSTALL_REASONS.unresolved };
  if (!resolved.ok) return { enabled: false, reason: INSTALL_REASONS.failed };
  if (mode === 'update') {
    return resolved.changed
      ? { enabled: true, reason: '' }
      : { enabled: false, reason: INSTALL_REASONS.unchanged };
  }
  const typed = String(fieldValue == null ? '' : fieldValue).trim();
  if (resolved.spec !== typed) return { enabled: false, reason: INSTALL_REASONS.stale };
  return { enabled: true, reason: '' };
}

module.exports = {
  INSTALL_REASONS,
  shortCommit,
  refLabel,
  sourceLabel,
  sourceLine,
  previewLines,
  updatePreviewLines,
  warningText,
  webRendererNote,
  installState,
};
