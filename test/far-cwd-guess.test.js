'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { farCwdGuess, localFromHome } = require('../renderer/lib/far-cwd-guess');

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

test('the local platform and user are DERIVED from homedir — the browser bundle has no process or os.userInfo', () => {
  const rows = [
    { home: '/Users/bogdan', want: { platform: 'darwin', username: 'bogdan' } },
    { home: '/home/bogdan', want: { platform: 'linux', username: 'bogdan' } },
    { home: '/', want: { platform: null, username: null } },
    { home: '', want: { platform: null, username: null } },
    { home: 'C:\\Users\\bogdan', want: { platform: null, username: null } },
    {
      why: 'a home nested deeper than <root>/<user> is not a home we can read a user out of',
      home: '/Users/corp/bogdan',
      want: { platform: 'darwin', username: null },
    },
  ];
  assert.deepStrictEqual(rows.map((r) => localFromHome(r.home)), rows.map((r) => r.want));

  assert.deepStrictEqual(
    farCwdGuess({
      cwd: '/Users/bogdan/projects/agentic-crypto',
      farPlatform: 'linux',
      ...localFromHome('/Users/bogdan'),
      homedir: '/Users/bogdan',
    }),
    { cwd: '/home/bogdan/projects/agentic-crypto', note: NOTE_LINUX },
    'the derived pair drives the same swap the electron seams used to',
  );

  assert.deepStrictEqual(
    farCwdGuess({
      cwd: '/srv/app',
      farPlatform: 'linux',
      ...localFromHome('/'),
      homedir: '/',
    }),
    { cwd: '/srv/app', note: null },
    'a browser that never got a welcome home guesses nothing and says nothing, rather than throwing',
  );
});

test('peers-ui reaches for no node global the browser bundle lacks', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'peers-ui.js'), 'utf8');
  assert.deepStrictEqual(src.match(/\bprocess\s*\./g) || [], [],
    'esbuild defines only process.env.NODE_ENV, so a bare process.<x> is a ReferenceError in a tab — '
    + 'and this dialog throws it BEFORE it unhides the overlay, which reads as a dead menu item');
  const shimmed = Object.keys(require('../renderer/web/os-shim'));
  const touched = [...src.matchAll(/\bos\.([A-Za-z_$][\w$]*)/g)].map((m) => m[1]);
  assert.deepStrictEqual(touched.filter((k) => !shimmed.includes(k)), [],
    `os is aliased to renderer/web/os-shim.js in the web build, which exports only ${shimmed.join(', ')}`);
  assert.ok(touched.length, 'ENTER: the file DOES use os, so the filter above is measuring something');
});
