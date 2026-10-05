'use strict';

const test = require('node:test');
const assert = require('node:assert');
const scripts = require('../plugins/browser-pane/page-scripts');

const BLOCK = new Set(['DIV', 'P', 'ARTICLE', 'MAIN', 'SECTION']);
const SIMPLE_RE = /^([a-z]*)((?:\[[^\]]+\])*)$/;
const ATTR_RE = /\[([\w-]+)(?:(\*?=)"?([^"\]]*)"?)?\]/g;

function matches(el, sel) {
  return sel.split(',').map((s) => s.trim()).some((one) => {
    const m = SIMPLE_RE.exec(one);
    if (!m) throw new Error(`stub selector unsupported: ${one}`);
    if (m[1] && el.tagName !== m[1].toUpperCase()) return false;
    for (const [, name, op, val] of m[2].matchAll(ATTR_RE)) {
      const v = el.getAttribute(name);
      if (v == null) return false;
      if (op === '=' && v !== val) return false;
      if (op === '*=' && !v.includes(val)) return false;
    }
    return true;
  });
}

function h(tag, attrs, ...kids) {
  const el = {
    tagName: tag.toUpperCase(), attrs: attrs || {}, children: [], kids, parentElement: null,
    getAttribute: (k) => (k in el.attrs ? String(el.attrs[k]) : null),
    get innerText() {
      return el.kids.map((k) => (typeof k === 'string' ? k : k.innerText)).filter((t) => t !== '').join(BLOCK.has(el.tagName) ? '\n' : ' ');
    },
    contains: (o) => { for (let e = o; e; e = e.parentElement) if (e === el) return true; return false; },
    closest: (sel) => { for (let e = el; e; e = e.parentElement) if (matches(e, sel)) return e; return null; },
    querySelectorAll: (sel) => {
      const out = [];
      const walk = (e) => { for (const c of e.children) { if (matches(c, sel)) out.push(c); walk(c); } };
      walk(el);
      return out;
    },
    querySelector: (sel) => el.querySelectorAll(sel)[0] || null,
    getBoundingClientRect: () => ({ width: Number(el.attrs.w || 0), height: Number(el.attrs.h || 0) }),
  };
  for (const k of kids) if (typeof k !== 'string') { k.parentElement = el; el.children.push(k); }
  return el;
}

function runFeed(doc, numbered, cats, main = false) {
  const window = { __cxEls: Object.fromEntries(Object.entries(numbered).map(([n, e]) => [n, { deref: () => e }])) };
  const location = { href: 'https://site.test/home', origin: 'https://site.test' };
  return new Function('document', 'window', 'location', `return ${scripts.FEED(main, cats)}`)(doc, window, location);
}

function fixture() {
  const link = h('a', { href: '/ana/status/111' }, h('time', { datetime: '2026-10-05T04:12:00.000Z' }, '9h'));
  const more = h('button', {}, 'Show more');
  const reply = h('button', { 'aria-label': '1058 Replies. Reply' }, '1K');
  const like = h('button', { 'aria-label': '3.1K Likes. Like' }, '3.1K');
  const views = h('a', { href: '/ana/status/111/analytics' }, '1.2M views');
  const avatar = h('a', { href: '/ana' }, h('img', { w: 40, h: 40 }));
  const a1 = h('article', {},
    h('div', {}, 'Ana reposted'),
    avatar,
    h('div', {}, h('span', {}, 'Ana Lee'), h('svg', { 'aria-label': 'Verified account' }), h('span', {}, '@ana'), h('span', {}, '·'), link),
    h('div', { lang: 'en' }, 'Hello   world from the feed'),
    more,
    h('div', {}, h('video', {}), h('img', { w: 300, h: 200 }), h('div', { 'aria-label': 'Play Video. 1 minute 6 seconds long' })),
    h('img', { w: 300, h: 200 }),
    reply, like, views);
  const link2 = h('a', { href: '/bo/status/222' }, h('time', { datetime: '2026-10-03T10:00:00.000Z' }, 'Oct 3'));
  const quoteBox = h('div', { role: 'link' },
    h('div', {}, h('span', {}, 'Cy'), h('span', {}, '@cy'), h('time', { datetime: '2026-10-01T00:00:00.000Z' }, '4d')),
    h('div', { lang: 'en' }, 'the quoted words'));
  const card = h('a', { href: 'https://www.example.com/x' }, 'example.com article');
  const publish = h('button', { 'aria-label': '5 Reposts. Repost' });
  const a2 = h('article', {},
    h('div', {}, h('span', {}, 'Bo'), h('span', {}, '@bo'), link2),
    h('div', {}, 'Replying to @ana'),
    h('div', { lang: 'en' }, 'my take'),
    quoteBox, card, publish);
  const outside = h('a', { href: '/explore' }, 'Explore');
  const doc = h('main', {}, outside, a1, a2);
  return { doc, a1, a2, link, link2, more, reply, like, publish, outside };
}

test('FEED: one entry per article — permalink number, header, lang body, Show more, aria counts, media, flags, nested quote, folded ⚠', () => {
  const f = fixture();
  const numbered = { 3: f.outside, 10: f.a1, 11: f.link, 12: f.more, 13: f.reply, 14: f.like, 20: f.link2, 21: f.publish };
  const got = runFeed(f.doc, numbered, { 13: 'publish', 14: 'publish', 21: 'publish', 3: 'other' });
  assert.deepStrictEqual(got, {
    posts: [
      {
        n: 11, path: '/ana/status/111', handle: 'ana', name: 'Ana Lee', verified: true,
        time: { rel: '9h', iso: '2026-10-05T04:12:00.000Z' }, text: 'Hello world from the feed', more: 12,
        counts: [{ num: '1058', word: 'replies' }, { num: '3.1K', word: 'likes' }, { num: '1.2M', word: 'views' }],
        media: { videos: 1, duration: '1:06', photos: 1, card: null },
        flags: { repostedBy: 'Ana' }, quote: null,
      },
      {
        n: 20, path: '/bo/status/222', handle: 'bo', name: 'Bo', verified: false,
        time: { rel: 'Oct 3', iso: '2026-10-03T10:00:00.000Z' }, text: 'my take', more: null,
        counts: [{ num: '5', word: 'reposts' }],
        media: { videos: 0, duration: null, photos: 0, card: 'example.com' },
        flags: { replyTo: '@ana' },
        quote: { handle: 'cy', rel: '4d', text: 'the quoted words', path: null },
      },
    ],
    numbers: [10, 11, 12, 13, 14, 20, 21],
    folded: { publish: 3 },
  });
});

test('FEED: an article whose permalink was not numbered reports n null; nested articles are not separate posts', () => {
  const f = fixture();
  const got = runFeed(f.doc, { 12: f.more }, {});
  assert.deepStrictEqual(got.posts.map((p) => p.n), [null, null]);
  assert.strictEqual(got.posts[0].more, 12);
  const inner = h('article', {}, h('a', { href: '/z/status/9' }, h('time', {}, '1m')));
  const doc = h('main', {}, h('article', {}, h('div', {}, '@q', h('a', { href: '/q/status/8' }, h('time', {}, '2m'))), inner));
  assert.strictEqual(runFeed(doc, {}, {}).posts.length, 1);
});
