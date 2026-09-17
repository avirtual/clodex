'use strict';

const { CliError, EXIT } = require('./errors');

const TABLE = [
  { plural: 'sessions', singular: 'session' },
  { plural: 'nodes', singular: 'node' },
  { plural: 'workspaces', singular: 'workspace' },
  { plural: 'peers', singular: 'peer' },
  { plural: 'teams', singular: 'team' },
  { plural: 'tickets', singular: 'ticket' },
  { plural: 'sandboxes', singular: 'sandbox' },
  { plural: 'agents', singular: 'agent' },
  { plural: 'docs', singular: 'doc' },
  { plural: 'worktrees', singular: 'worktree' },
  { plural: 'catalogs', singular: 'catalogs' },
];

const SPELLINGS = new Map();
for (const r of TABLE) {
  SPELLINGS.set(r.plural, r);
  SPELLINGS.set(r.singular, r);
}

function resolveResource(token) {
  return SPELLINGS.get(token) || null;
}

function knownSpellings() {
  return [...new Set(TABLE.flatMap((r) => [r.plural, r.singular]))];
}

function singulars() {
  return [...new Set(TABLE.map((r) => r.singular))];
}

function didYouMean(verb, word, supported) {
  const slot = supported.length === 1 ? supported[0] : `<${supported.join('|')}>`;
  return `${verb} ${word}: "${word}" is not a resource — did you mean: ${verb} ${slot} ${word}`;
}

function parseTarget(args, verb) {
  const first = args[0];
  if (!first) {
    throw new CliError(EXIT.USAGE, `${verb} needs a resource (${knownSpellings().join('|')})`);
  }
  let token = first;
  let name = args[1] || null;
  const slash = first.indexOf('/');
  if (slash > 0) {
    token = first.slice(0, slash);
    const tail = first.slice(slash + 1);
    if (!tail) throw new CliError(EXIT.USAGE, `${verb}: "${first}" names no object`);
    if (name) throw new CliError(EXIT.USAGE, `${verb}: "${first}" already carries a name, "${name}" is extra`);
    name = tail;
  }
  const entry = resolveResource(token);
  if (!entry) {
    if (slash > 0) {
      throw new CliError(EXIT.USAGE, `unknown resource: ${token} (${knownSpellings().join('|')})`);
    }
    throw new CliError(EXIT.USAGE, didYouMean(verb, token, singulars()));
  }
  const extra = args.slice(slash > 0 ? 1 : 2);
  if (extra.length) {
    throw new CliError(EXIT.USAGE, `${verb} ${token}: unexpected argument "${extra[0]}"`);
  }
  return { resource: entry.plural, singular: entry.singular, plural: entry.plural, named: token === entry.singular, name };
}

async function fetchResources(client) {
  try {
    return await client.get('/api/resources', 'api-resources');
  } catch (e) {
    if (e instanceof CliError && e.exitCode === EXIT.NOTFOUND) return null;
    throw e;
  }
}

async function failUpgrade(client, resource, verb, ctxName) {
  let host = '?';
  let version = '?';
  try {
    const hello = await client.get('/api/peer/hello', 'version');
    host = hello.host || '?';
    version = hello.version || '?';
  } catch {}
  throw new CliError(EXIT.SERVER,
    `node ${host} (${version}) does not serve ${resource} ${verb}; run: clodexctl upgrade node ${ctxName}`);
}

async function requireResource(client, resource, verb, ctxName, sub = null) {
  const doc = await fetchResources(client);
  const entry = doc && (doc.resources || []).find((r) => r.name === resource);
  const label = sub ? `${resource}/${sub}` : resource;
  const served = sub
    ? !!(entry && entry.subresources && (entry.subresources[sub] || []).includes(verb))
    : !!(entry && (entry.verbs || []).includes(verb));
  if (!served) await failUpgrade(client, label, verb, ctxName);
  return doc;
}

function ctxLabel(ctx, flags) {
  const name = ctx && ctx.name;
  if (name && name !== '(flags)' && name !== '(env)') return name;
  const url = (flags && flags.url) || (ctx && ctx.url);
  if (url) return String(url);
  return name || '<ctx>';
}

module.exports = { TABLE, resolveResource, knownSpellings, singulars, didYouMean, parseTarget, fetchResources, failUpgrade, requireResource, ctxLabel };
