'use strict';

const INSTALL_REASONS = {
  unresolved: 'Resolve the repo first — Clodex reads its manifest before anything is downloaded.',
  failed: 'That resolve did not succeed — fix the spec and resolve again.',
  stale: 'The spec changed since the last resolve — resolve it again.',
};

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
    `${sourceLabel(resolved)} at commit ${resolved.commit || 'unknown'}`,
  ];
}

function warningText(resolved) {
  if (!resolved || !resolved.ok) return '';
  return `This code will run inside Clodex with the app's full authority, the same as Clodex itself. `
    + `It comes from github.com/${resolved.repo} at ${refLabel(resolved)} (commit ${resolved.commit}). `
    + 'Clodex cannot check what it does — install it only if you trust its author.';
}

function installState({ resolved, fieldValue } = {}) {
  if (!resolved) return { enabled: false, reason: INSTALL_REASONS.unresolved };
  if (!resolved.ok) return { enabled: false, reason: INSTALL_REASONS.failed };
  const typed = String(fieldValue == null ? '' : fieldValue).trim();
  if (resolved.spec !== typed) return { enabled: false, reason: INSTALL_REASONS.stale };
  return { enabled: true, reason: '' };
}

module.exports = {
  INSTALL_REASONS,
  refLabel,
  sourceLabel,
  previewLines,
  warningText,
  installState,
};
