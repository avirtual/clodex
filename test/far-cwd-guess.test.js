'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const { farCwdGuess } = require('../renderer/lib/far-cwd-guess');

const NOTE_LINUX = 'The peer runs linux; the folder was guessed from yours — check it exists there.';
const NOTE_DARWIN = 'The peer runs darwin; the folder was guessed from yours — check it exists there.';

test('the far folder is the local one with the home prefix swapped, and only across platforms', () => {
  const rows = [
    {
      why: 'the incident: darwin → linux, the path under home',
      arg: {
        cwd: '/Users/bogdan/projects/agentic-crypto',
        farPlatform: 'linux', platform: 'darwin',
        homedir: '/Users/bogdan', username: 'bogdan',
      },
      want: { cwd: '/home/bogdan/projects/agentic-crypto', note: NOTE_LINUX },
    },
    {
      why: 'the other direction: linux → darwin',
      arg: {
        cwd: '/home/bogdan/projects/agentic-crypto',
        farPlatform: 'darwin', platform: 'linux',
        homedir: '/home/bogdan', username: 'bogdan',
      },
      want: { cwd: '/Users/bogdan/projects/agentic-crypto', note: NOTE_DARWIN },
    },
    {
      why: 'home itself, with nothing under it',
      arg: {
        cwd: '/Users/bogdan', farPlatform: 'linux', platform: 'darwin',
        homedir: '/Users/bogdan', username: 'bogdan',
      },
      want: { cwd: '/home/bogdan', note: NOTE_LINUX },
    },
    {
      why: 'not under home: nothing to swap, but the platform note still warns',
      arg: {
        cwd: '/srv/shared/app', farPlatform: 'linux', platform: 'darwin',
        homedir: '/Users/bogdan', username: 'bogdan',
      },
      want: { cwd: '/srv/shared/app', note: NOTE_LINUX },
    },
    {
      why: 'a sibling of home whose name merely starts the same way',
      arg: {
        cwd: '/Users/bogdan-old/projects', farPlatform: 'linux', platform: 'darwin',
        homedir: '/Users/bogdan', username: 'bogdan',
      },
      want: { cwd: '/Users/bogdan-old/projects', note: NOTE_LINUX },
    },
    {
      why: 'same platform: verbatim, and no note at all',
      arg: {
        cwd: '/Users/bogdan/projects/agentic-crypto',
        farPlatform: 'darwin', platform: 'darwin',
        homedir: '/Users/bogdan', username: 'bogdan',
      },
      want: { cwd: '/Users/bogdan/projects/agentic-crypto', note: null },
    },
    {
      why: 'a peer too old to advertise a platform: guess nothing, say nothing',
      arg: {
        cwd: '/Users/bogdan/projects/agentic-crypto',
        farPlatform: null, platform: 'darwin',
        homedir: '/Users/bogdan', username: 'bogdan',
      },
      want: { cwd: '/Users/bogdan/projects/agentic-crypto', note: null },
    },
    {
      why: 'a platform with no home root we know: warn, do not invent one',
      arg: {
        cwd: '/Users/bogdan/projects/agentic-crypto',
        farPlatform: 'win32', platform: 'darwin',
        homedir: '/Users/bogdan', username: 'bogdan',
      },
      want: {
        cwd: '/Users/bogdan/projects/agentic-crypto',
        note: 'The peer runs win32; the folder was guessed from yours — check it exists there.',
      },
    },
  ];
  assert.deepStrictEqual(rows.map((r) => farCwdGuess(r.arg)), rows.map((r) => r.want));
});
