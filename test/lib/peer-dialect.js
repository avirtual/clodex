'use strict';

// The two hello/resources shapes a PeerConnection can meet on the wire.
// CURRENT serves the sessions subresource wire; OLD is any node before it —
// either one whose document lacks the attach row, or one with no `resources`
// cap at all, which is a node too old to carry the document.
const CURRENT_SUBRESOURCES = {
  transcript: ['get'], query: ['post'], attach: ['get'], control: ['post'], input: ['post'], resize: ['post'],
};
const OLD_SUBRESOURCES = { transcript: ['get'], query: ['post'] };

function helloBody(caps = ['resources']) {
  return { ok: true, app: 'clodex', host: 'h', version: '1', caps };
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

// Answers hello + /api/resources for `dialect`; returns false for anything
// else so a caller keeps its own routes. 'none' omits the resources cap.
function serveDialect(p, res, dialect = 'current') {
  const json = (body) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  if (p === '/api/peer/hello') {
    json(helloBody(dialect === 'none' ? [] : ['resources']));
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
