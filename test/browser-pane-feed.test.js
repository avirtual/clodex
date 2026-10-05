'use strict';

const test = require('node:test');
const assert = require('node:assert');
const scripts = require('../plugins/browser-pane/page-scripts');
const { feedLines } = require('../plugins/browser-pane/read-format');

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
    tagName: tag.toUpperCase(), attrs: attrs || {}, children: [], kids, parentElement: null, nodeType: 1,
    get childNodes() { return el.kids.map((k) => (typeof k === 'string' ? { nodeType: 3, nodeValue: k } : k)); },
    get previousElementSibling() { const sib = el.parentElement ? el.parentElement.children : []; return sib[sib.indexOf(el) - 1] || null; },
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
    getBoundingClientRect: () => {
      const [x, y, w, hh] = ['x', 'y', 'w', 'h'].map((k) => Number(el.attrs[k] || 0));
      return { left: x, top: y, right: x + w, bottom: y + hh, width: w, height: hh };
    },
  };
  for (const k of kids) if (typeof k !== 'string') { k.parentElement = el; el.children.push(k); }
  return el;
}

function createRange() {
  let start = null;
  let end = null;
  return {
    setStart: (node) => { start = node; },
    setEndBefore: (node) => { end = node; },
    toString: () => {
      const out = [];
      let done = false;
      const walk = (e) => {
        for (const k of e.kids) {
          if (done) return;
          if (k === end) { done = true; return; }
          if (typeof k === 'string') out.push(k);
          else walk(k);
        }
      };
      walk(start);
      return out.join('');
    },
  };
}

function runFeed(doc, numbered, cats, main = false) {
  doc.createRange = createRange;
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
        quote: { n: null, handle: 'cy', rel: '4d', text: 'the quoted words', path: null, media: { videos: 0, duration: null, photos: 0 } },
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

function adFixture() {
  const views = h('a', { href: '/marco__marsano/status/2104987795370750155/analytics' }, '268,217 views');
  const shop = h('a', { href: 'https://t.co/abc' }, 'From millerandhill.com');
  const wrapper = h('div', {},
    h('div', {}, h('span', {}, 'Marco Marsano Milano'), h('span', {}, '@marco__marsano')),
    h('div', {}, 'Ad'),
    h('div', { lang: 'en' }, 'Discover our denim jacket'),
    shop, views);
  const art = h('article', {}, wrapper);
  return { doc: h('main', {}, art), art, wrapper, views, shop };
}

test('FEED: an ad (no time link) takes the clickable wrapper number, the analytics link minus /analytics, the @handle span, the Ad line under the header and the domain in the link text', () => {
  const f = adFixture();
  const [p] = runFeed(f.doc, { 1020: f.wrapper, 1025: f.views, 1026: f.shop }, {}).posts;
  assert.strictEqual(p.n, 1020);
  assert.strictEqual(p.path, '/marco__marsano/status/2104987795370750155');
  assert.deepStrictEqual([p.handle, p.name, p.flags.ad, p.media.card], ['marco__marsano', 'Marco Marsano Milano', true, 'millerandhill.com']);
});

function xHeader(handle, name, statusPath, timeAttrs, rel) {
  const timeLink = h('a', { href: statusPath, ...timeAttrs }, h('time', { datetime: '2026-10-05T10:22:00.000Z' }, rel));
  const row = h('div', {},
    h('div', {}, h('a', { href: `/${handle}` }, name), h('svg', { 'aria-label': 'Verified account' })),
    h('div', {}, h('a', { href: `/${handle}` }, `@${handle}`), h('span', {}, '·'), timeLink));
  return { row, timeLink };
}

test('FEED: a two-level header gives handle, name and ✓ from the author links; the time link is the permalink and never a count; a /photo/N link before it is not the path', () => {
  const { row, timeLink } = xHeader('coinbureau', 'Coin Bureau', '/coinbureau/status/7', { 'aria-label': '10 minutes' }, '10m');
  const photo = h('a', { href: '/coinbureau/status/7/photo/1' }, h('img', { w: 40, h: 40 }));
  const art = h('article', {},
    photo,
    h('div', {}, h('a', { href: '/coinbureau' }, h('img', { w: 40, h: 40 })), row),
    h('div', { lang: 'en' }, 'Do not ignore this.'),
    h('button', { 'aria-label': '11 Replies. Reply' }, '11'));
  const [p] = runFeed(h('main', {}, art), { 1007: timeLink, 1001: photo }, {}).posts;
  assert.deepStrictEqual([p.n, p.path, p.handle, p.name, p.verified], [1007, '/coinbureau/status/7', 'coinbureau', 'Coin Bureau', true]);
  assert.deepStrictEqual(p.counts, [{ num: '11', word: 'replies' }]);
});

test('FEED: a self-repost line above the header sets repostedBy; the name comes from the author link nearest the handle', () => {
  const { row } = xHeader('analee', 'Ana Lee', '/analee/status/8', {}, '2h');
  const art = h('article', {},
    h('div', {}, h('a', { href: '/analee' }, 'Ana Lee reposted')),
    h('div', {}, row),
    h('div', { lang: 'en' }, 'hello again'));
  const [p] = runFeed(h('main', {}, art), {}, {}).posts;
  assert.deepStrictEqual([p.handle, p.name, p.flags.repostedBy], ['analee', 'Ana Lee', 'Ana Lee']);
});

test('FEED: a video poster at the video\'s rect is not a photo; a parody label is a flag, not a card; a card image is not a photo', () => {
  const { row } = xHeader('vip', 'Vip', '/vip/status/9', {}, '15h');
  const cardLink = h('a', { href: 'https://shop.test/p' }, h('img', { w: 300, h: 300 }));
  const art = h('article', {},
    row,
    h('a', { href: 'https://help.x.com/rules-and-policies/authenticity' }, 'Parody account'),
    h('div', { lang: 'en' }, 'laughing'),
    h('div', {}, h('div', {}, h('div', {}, h('div', {}, h('div', {}, h('video', { w: 300, h: 200 })))))),
    h('img', { w: 300, h: 200 }),
    cardLink);
  const [p] = runFeed(h('main', {}, art), {}, {}).posts;
  assert.deepStrictEqual(p.media, { videos: 1, duration: null, photos: 0, card: 'shop.test' });
  assert.strictEqual(p.flags.parody, true);
});

test('FEED: the quote link carries a different status id than the post; its number, path and media go on the quote; an Article quote takes its box number', () => {
  const { row } = xHeader('qwinsi0x', 'Qwinsi', '/qwinsi0x/status/5', {}, '15h');
  const qlink = h('a', { href: '/RohOnChain/status/6' }, 'Article');
  const qbox = h('div', { role: 'link' },
    h('a', { href: '/qwinsi0x/status/5/photo/1' }, h('img', { w: 40, h: 40 })),
    h('div', {}, h('span', {}, 'Roan'), h('span', {}, '@RohOnChain'), h('time', { datetime: '2026-09-19T00:00:00.000Z' }, 'Sep 19')),
    h('div', { lang: 'en' }, 'Jev is fast'),
    h('div', {}, h('video', {}), h('div', { 'aria-label': 'Play Video. 12 seconds long' })),
    qlink);
  const art = h('article', {}, row, h('div', { lang: 'en' }, 'A quant'), qbox);
  const [p] = runFeed(h('main', {}, art), { 1284: qlink }, {}).posts;
  assert.deepStrictEqual(p.quote, { n: 1284, handle: 'RohOnChain', rel: 'Sep 19', text: 'Jev is fast', path: '/RohOnChain/status/6', media: { videos: 1, duration: '0:12', photos: 0 } });
  const a2 = xHeader('hayatomaruu', 'Hayato', '/hayatomaruu/status/4', {}, '15h');
  const abox = h('div', {}, h('div', {}, h('span', {}, 'Beam'), h('span', {}, '@beamnxw'), h('time', {}, 'Jul 25')));
  const art2 = h('article', {}, a2.row, h('div', { lang: 'en' }, 'Creator'), abox);
  const got = runFeed(h('main', {}, art2), { 1040: abox }, {});
  assert.strictEqual(feedLines(got)[1], '  ↳ [1040] quoting @beamnxw · Jul 25');
});

test('FEED: on a focal post the own time link sits below a quote whose linked time comes first; the post keeps its own number, path and time', () => {
  const row = h('div', {},
    h('div', {}, h('a', { href: '/coinbureau' }, 'Coin Bureau')),
    h('div', {}, h('a', { href: '/coinbureau' }, '@coinbureau')));
  const qlink = h('a', { href: '/RohOnChain/status/6' }, h('span', {}, '@RohOnChain'), h('time', { datetime: '2026-09-19T00:00:00.000Z' }, 'Sep 19'));
  const qbox = h('div', { role: 'link' }, h('div', {}, h('span', {}, 'Roan'), qlink), h('div', { lang: 'en' }, 'Jev is fast'));
  const own = h('a', { href: '/coinbureau/status/7' }, h('time', { datetime: '2026-10-05T10:22:00.000Z' }, '1:22 PM · Oct 5, 2026'));
  const art = h('article', {}, row, h('div', { lang: 'en' }, 'Do not ignore this.'), qbox, h('div', {}, own), h('button', { 'aria-label': '11 Replies. Reply' }, '11'));
  const [p] = runFeed(h('main', {}, art), { 1122: own, 1284: qlink }, {}).posts;
  assert.deepStrictEqual([p.n, p.path, p.time.rel], [1122, '/coinbureau/status/7', '1:22 PM · Oct 5, 2026']);
  assert.deepStrictEqual([p.quote.n, p.quote.path, p.quote.rel], [1284, '/RohOnChain/status/6', 'Sep 19']);
});

test('FEED: a quote [n] is its card, never its /photo/N link — a clean status link, else the box number, else the numbered @handle header', () => {
  const quoteOf = (qbox, numbered) => {
    const { row } = xHeader('ana', 'Ana', '/ana/status/5', {}, '2h');
    const art = h('article', {}, row, h('div', { lang: 'en' }, 'my take'), qbox);
    return runFeed(h('main', {}, art), numbered, {}).posts[0].quote;
  };
  const head = () => h('div', {}, h('span', {}, 'Cy'), h('span', {}, '@cy'), h('time', {}, '4d'));
  const photo = h('a', { href: '/cy/status/2/photo/1' }, h('img', { w: 300, h: 200 }));
  const clean = h('a', { href: '/cy/status/2' }, 'Show more');
  const q1 = quoteOf(h('div', { role: 'link' }, photo, head(), h('div', { lang: 'en' }, 'quoted'), clean), { 1321: photo, 1322: clean });
  assert.deepStrictEqual([q1.n, q1.path], [1322, '/cy/status/2']);
  const photo2 = h('a', { href: '/cy/status/2/photo/1' }, h('img', { w: 300, h: 200 }));
  const card2 = h('div', { role: 'link' }, head(), photo2);
  const q2 = quoteOf(h('div', {}, card2), { 1320: card2, 1321: photo2 });
  assert.deepStrictEqual([q2.n, q2.path], [1320, '/cy/status/2']);
  const photo3 = h('a', { href: '/cy/status/2/photo/1' }, h('img', { w: 300, h: 200 }));
  const hdr = h('a', { href: '/cy' }, h('span', {}, 'Cy'), h('span', {}, '@cy · 19h'));
  const q4 = quoteOf(h('div', {}, h('div', { role: 'link' }, hdr, h('time', {}, '19h'), photo3)), { 1336: hdr, 1337: photo3 });
  assert.deepStrictEqual([q4.n, q4.path], [1336, '/cy/status/2']);
  const card3 = h('div', { role: 'link' }, head(), h('div', { lang: 'en' }, 'NO EVIDENCE'));
  const q3 = quoteOf(h('div', {}, card3), { 1336: card3 });
  assert.deepStrictEqual([q3.n, q3.path], [1336, null]);
});

test('FEED: a playing video keeps its duration from video.duration; the body joins an https:// split from its host', () => {
  const { row } = xHeader('burry', 'Burry', '/burry/status/9', {}, '1h');
  const video = h('video', {});
  video.duration = 13.2;
  const art = h('article', {}, row, h('div', { lang: 'en' }, 'read https:// michaeljburry.substack.com/p/x now, https://michaeljburry .substack.com/p/y'),
    h('div', {}, video, h('div', { 'aria-label': 'Pause' })));
  const [p] = runFeed(h('main', {}, art), {}, {}).posts;
  assert.strictEqual(p.media.duration, '0:13');
  assert.strictEqual(p.text, 'read https://michaeljburry.substack.com/p/x now, https://michaeljburry.substack.com/p/y');
});

test('FEED: durations of an hour or more read h:mm:ss from video.duration and from the aria-label; a minutes-only time link is no duration', () => {
  const durOf = (video, label, timeAttrs = {}) => {
    const { row } = xHeader('ana', 'Ana', '/ana/status/9', timeAttrs, '1h');
    const art = h('article', {}, row, h('div', { lang: 'en' }, 'watch'), h('div', {}, video, h('div', { 'aria-label': label })));
    return runFeed(h('main', {}, art), {}, {}).posts[0].media.duration;
  };
  const rows = [
    [7007, 'Pause', '1:56:47'],
    [null, 'Play Video. 1 hour 56 minutes 47 seconds long', '1:56:47'],
    [null, 'Play Video. 2 hours long', '2:00:00'],
    [null, 'Play Video. 1 minute 5 seconds long', '1:05'],
    [null, 'Play Video. 13 seconds long', '0:13'],
    [65, 'Pause', '1:05'],
  ];
  for (const [secs, label, want] of rows) {
    const video = h('video', {});
    if (secs != null) video.duration = secs;
    assert.strictEqual(durOf(video, label), want, `${secs} / ${label}`);
  }
  assert.strictEqual(durOf(h('video', {}), 'Play Video. 13 seconds long', { 'aria-label': '10 minutes' }), '0:13');
});

test('FEED: the quote box is the outermost role=link card around the quote time; the post\'s own video and media-tags link beside it stay on the post', () => {
  const { row } = xHeader('me', 'Me', '/me/status/1', {}, '11h');
  const video = h('video', {});
  video.duration = 65;
  const card = h('div', { role: 'link' },
    h('div', {}, h('span', {}, 'Other'), h('span', {}, '@other'), h('time', {}, '2d')),
    h('div', { lang: 'en' }, 'quoted words'));
  const art = h('article', {}, row, h('div', { lang: 'en' }, 'my words'),
    h('div', {}, video, h('a', { href: '/me/status/1/media_tags' }, 'Leo Snow'), card));
  const [p] = runFeed(h('main', {}, art), { 1500: card }, {}).posts;
  assert.deepStrictEqual([p.media.videos, p.media.duration], [1, '1:05']);
  assert.deepStrictEqual([p.quote.media.videos, p.quote.handle, p.quote.n], [0, 'other', 1500]);
});

test('FEED: a nested quote card keeps its own status link; the quote path comes only from a link under the quote handle', () => {
  const quoteOf = (extra) => {
    const { row } = xHeader('ana', 'Ana', '/ana/status/5', {}, '2h');
    const inner = h('div', { role: 'link' }, h('span', {}, '@pak'), h('a', { href: '/pak/status/5/video/1' }, h('img', { w: 300, h: 200 })));
    const card = h('div', { role: 'link' },
      h('div', {}, h('span', {}, 'Uj'), h('span', {}, '@uj'), h('time', {}, '3h')),
      h('div', { lang: 'en' }, 'look'), inner, ...extra);
    const art = h('article', {}, row, h('div', { lang: 'en' }, 'my take'), card);
    return runFeed(h('main', {}, art), { 1400: card }, {}).posts[0].quote;
  };
  const q1 = quoteOf([]);
  assert.deepStrictEqual([q1.n, q1.path], [1400, null]);
  const q2 = quoteOf([h('a', { href: '/uj/status/7' }, 'Show more')]);
  assert.deepStrictEqual([q2.n, q2.path], [1400, '/uj/status/7']);
  const q3 = quoteOf([h('a', { href: '/pak/status/8' }, 'pak')]);
  assert.deepStrictEqual([q3.n, q3.path], [1400, null]);
  const own = h('div', { role: 'link' }, h('span', {}, '@uj'), h('a', { href: '/uj/status/9/video/1' }, h('img', { w: 300, h: 200 })));
  const q4 = quoteOf([own]);
  assert.deepStrictEqual([q4.n, q4.path], [1400, null]);
});

test('FEED: an Article quote card carries its title from the line after "Article" or the rest of an "Article …" line; a bare trailing "Article" is no title', () => {
  const quoteOf = (...body) => {
    const { row } = xHeader('ana', 'Ana', '/ana/status/5', {}, '2h');
    const card = h('div', { role: 'link' }, h('div', {}, h('span', {}, 'Jev'), h('span', {}, '@jev'), h('time', {}, 'Sep 25')), ...body);
    const art = h('article', {}, row, h('div', { lang: 'en' }, 'my take'), card);
    return runFeed(h('main', {}, art), {}, {}).posts[0].quote;
  };
  assert.strictEqual(quoteOf(h('div', {}, 'Article'), h('div', {}, '10 Projects You Should Build with Jev')).article, '10 Projects You Should Build with Jev');
  assert.strictEqual(quoteOf(h('div', {}, 'Article 10 Projects You Should Build with Jev')).article, '10 Projects You Should Build with Jev');
  assert.strictEqual('article' in quoteOf(h('div', { lang: 'en' }, 'plain words'), h('div', {}, 'Article')), false);
});

test('FEED: a post with only a photo has no text; the header row is never its clip', () => {
  const { row } = xHeader('EvanKirstel', 'Evan Kirstel', '/EvanKirstel/status/4', {}, '14h');
  const art = h('article', {}, h('div', {}, row), h('div', {}, h('img', { w: 300, h: 200 })));
  const got = runFeed(h('main', {}, art), {}, {});
  assert.strictEqual(got.posts[0].text, '');
  assert.strictEqual(feedLines(got)[0], '[?] @EvanKirstel (Evan Kirstel ✓) · 14h (2026-10-05T10:22Z) · photo · → /EvanKirstel/status/4');
});

test('FEED: the quote text joins an https:// split from its host', () => {
  const { row } = xHeader('ana', 'Ana', '/ana/status/5', {}, '2h');
  const card = h('div', { role: 'link' }, h('div', {}, h('span', {}, '@cy'), h('time', {}, '4d')), h('div', { lang: 'en' }, 'watch ( https:// youtu.be/x)'));
  const art = h('article', {}, row, h('div', { lang: 'en' }, 'my take'), card);
  assert.strictEqual(runFeed(h('main', {}, art), {}, {}).posts[0].quote.text, 'watch ( https://youtu.be/x)');
});
