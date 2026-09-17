'use strict';

const SESSIONS_ROW = {
  name: 'sessions', singular: 'session', scope: 'workspace', verbs: ['list', 'get', 'delete'],
  subresources: {
    transcript: ['get'], query: ['post'], attach: ['get'], control: ['post'], input: ['post'], resize: ['post'],
    dm: ['post'], restart: ['post'], args: ['get', 'patch'], skills: ['get', 'patch'],
  },
};

const RESOURCES_DOC = {
  ok: true,
  version: 1,
  resources: [
    SESSIONS_ROW,
    { name: 'workspaces', singular: 'workspace', scope: 'node', verbs: ['list'] },
    { name: 'catalogs', singular: 'catalogs', scope: 'node', verbs: ['get'] },
    { name: 'node/logs', singular: 'node/logs', scope: 'node', verbs: ['get'] },
  ],
};

function docWithoutResource(name) {
  return { ...RESOURCES_DOC, resources: RESOURCES_DOC.resources.filter((r) => r.name !== name) };
}

function docWithout(sub) {
  const subresources = { ...SESSIONS_ROW.subresources };
  delete subresources[sub];
  return { ...RESOURCES_DOC, resources: [{ ...SESSIONS_ROW, subresources }, ...RESOURCES_DOC.resources.slice(1)] };
}

function docWithoutVerb(verb) {
  const verbs = SESSIONS_ROW.verbs.filter((v) => v !== verb);
  return { ...RESOURCES_DOC, resources: [{ ...SESSIONS_ROW, verbs }, ...RESOURCES_DOC.resources.slice(1)] };
}

module.exports = { SESSIONS_ROW, RESOURCES_DOC, docWithout, docWithoutVerb, docWithoutResource };
