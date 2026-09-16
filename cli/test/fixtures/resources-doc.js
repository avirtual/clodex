'use strict';

const SESSIONS_ROW = {
  name: 'sessions', singular: 'session', scope: 'workspace', verbs: ['list', 'get'],
  subresources: { transcript: ['get'], query: ['post'], attach: ['get'], control: ['post'], input: ['post'], resize: ['post'] },
};

const RESOURCES_DOC = {
  ok: true,
  version: 1,
  resources: [
    SESSIONS_ROW,
    { name: 'workspaces', singular: 'workspace', scope: 'node', verbs: ['list'] },
    { name: 'catalogs', singular: 'catalogs', scope: 'node', verbs: ['get'] },
  ],
};

function docWithout(sub) {
  const subresources = { ...SESSIONS_ROW.subresources };
  delete subresources[sub];
  return { ...RESOURCES_DOC, resources: [{ ...SESSIONS_ROW, subresources }, ...RESOURCES_DOC.resources.slice(1)] };
}

module.exports = { SESSIONS_ROW, RESOURCES_DOC, docWithout };
