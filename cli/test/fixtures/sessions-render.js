'use strict';
const SESSIONS = [
  {
    "name": "bob",
    "type": "claude",
    "activity": "idle",
    "cwd": "/w/one",
    "workspace": "main"
  },
  {
    "name": "builder-long",
    "type": "codex",
    "activity": "working",
    "cwd": "/w/two/deeper",
    "workspace": "side"
  },
  {
    "name": "sh",
    "type": "bash",
    "activity": "",
    "cwd": "/",
    "workspace": "main"
  }
];

const RENDERED = "NAME          TYPE    ACTIVITY  CWD\nbob           claude  idle      /w/one\nbuilder-long  codex   working   /w/two/deeper\nsh            bash              /";

module.exports = { SESSIONS, RENDERED };
