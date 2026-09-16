'use strict';

const CURRENT_SUBRESOURCES = {
  transcript: ['get'], query: ['post'], attach: ['get'], control: ['post'], input: ['post'], resize: ['post'],
};
const OLD_SUBRESOURCES = { transcript: ['get'], query: ['post'] };

function helloBody(caps = ['resources'], version = '1') {
  return { ok: true, app: 'clodex', host: 'h', version, caps };
}

function resourcesBody(subresources) {
  return {
    ok: true,
    version: 1,
    resources: [
      { name: 'sessions', singular: 'session', scope: 'workspace', verbs: ['list', 'get'], subresources },
      { name: 'workspaces', singular: 'workspace', scope: 'node', verbs: ['list'] },
    ],
  };
}

function serveDialect(p, res, dialect = 'current', version = '1') {
  const json = (body) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  if (p === '/api/peer/hello') {
    json(helloBody(dialect === 'none' ? [] : ['resources'], version));
    return true;
  }
  if (p === '/api/resources') {
    if (dialect === 'none') { res.writeHead(404).end(); return true; }
    json(resourcesBody(dialect === 'old' ? OLD_SUBRESOURCES : CURRENT_SUBRESOURCES));
    return true;
  }
  return false;
}

module.exports = { CURRENT_SUBRESOURCES, OLD_SUBRESOURCES, helloBody, resourcesBody, serveDialect };
