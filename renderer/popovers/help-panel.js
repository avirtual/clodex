'use strict';

const { renderDoc } = require('../lib/render-doc');
const { parseDoc, buildSearchIndex, search } = require('../../doc-parse');
const { isExternallyOpenable } = require('../../external-link');

const DEFAULT_PAGE = 'how-to';
const SEARCH_MIN = 2;
const SEARCH_LIMIT = 30;
const REPO_BLOB = 'https://github.com/avirtual/clodex/blob/master/';
const RECIPE_PREFIX = 'recipe-';
const PAGE_DIRS = {
  cli: 'cli',
  'plugin-api': 'plugins',
  'plugin-sources': 'plugins',
  'what-plugins-can-do': 'plugins',
};
const SAFE_SLUG = /^[A-Za-z0-9_-]+$/;
const ABSOLUTE_SCHEME = /^[a-z][a-z0-9+.-]*:/i;

function dirOfPage(name) {
  const key = String(name == null ? '' : name);
  if (key.startsWith(RECIPE_PREFIX)) return 'docs/recipes';
  return PAGE_DIRS[key] || 'docs';
}

function joinRepoPath(base, relative) {
  const parts = String(base).split('/').filter(Boolean);
  for (const seg of String(relative).split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') { parts.pop(); continue; }
    parts.push(seg);
  }
  const joined = parts.join('/');
  return String(relative).endsWith('/') && joined ? `${joined}/` : joined;
}

function pageOfRepoPath(repoPath) {
  const p = String(repoPath);
  if (p === 'cli/README.md') return 'cli';
  const recipe = /^docs\/recipes\/(.+)\.md$/.exec(p);
  if (recipe) return `${RECIPE_PREFIX}${recipe[1]}`;
  const doc = /^docs\/([^/]+)\.md$/.exec(p);
  if (doc) return doc[1];
  const plugin = /^plugins\/([^/]+)\.md$/.exec(p);
  if (plugin) return plugin[1];
  return null;
}

function initHelpPanel({ api }) {
  const overlay = document.getElementById('help-overlay');
  const titleEl = document.getElementById('help-title');
  const navEl = document.getElementById('help-nav');
  const bodyEl = document.getElementById('help-body');
  const searchEl = document.getElementById('help-search');
  const backBtn = document.getElementById('help-back');
  const fwdBtn = document.getElementById('help-fwd');

  const pageCache = new Map();
  const pageNames = new Set();
  const trail = [];
  let indexData = null;
  let indexPromise = null;
  let searchIndexPromise = null;
  let currentName = null;
  let currentHeadings = [];
  let at = -1;
  let showSeq = 0;

  async function loadIndex() {
    const res = await api.helpIndex();
    if (!res || !res.ok || !Array.isArray(res.sections)) {
      indexPromise = null;
      return indexData || { sections: [] };
    }
    indexData = res;
    for (const section of indexData.sections) {
      for (const page of (section && section.pages) || []) pageNames.add(page.name);
    }
    return indexData;
  }

  function getIndex() {
    if (!indexPromise) indexPromise = loadIndex();
    return indexPromise;
  }

  async function loadPage(name) {
    const res = await api.helpPage(name);
    if (!res || !res.ok) pageCache.delete(name);
    return res;
  }

  function getPage(name) {
    if (!pageCache.has(name)) pageCache.set(name, loadPage(name));
    return pageCache.get(name);
  }

  function clearNode(el) {
    el.textContent = '';
  }

  function resolveHref(href) {
    const raw = String(href == null ? '' : href);
    if (!raw) return null;
    if (ABSOLUTE_SCHEME.test(raw)) {
      return isExternallyOpenable(raw) ? { kind: 'external', url: raw } : null;
    }
    if (raw.startsWith('#')) return { kind: 'anchor', slug: raw.slice(1) };
    const hash = raw.indexOf('#');
    const target = hash < 0 ? raw : raw.slice(0, hash);
    const frag = hash < 0 ? '' : raw.slice(hash + 1);
    if (!target) return null;
    const repoPath = joinRepoPath(dirOfPage(currentName), target);
    if (!repoPath) return null;
    const name = pageOfRepoPath(repoPath);
    if (name && pageNames.has(name)) return { kind: 'page', name, slug: frag || null };
    return { kind: 'external', url: `${REPO_BLOB}${repoPath}` };
  }

  function row(tag, cls, text) {
    const el = document.createElement(tag);
    el.className = cls;
    if (text != null) el.textContent = String(text);
    return el;
  }

  function renderNav() {
    clearNode(navEl);
    for (const section of (indexData && indexData.sections) || []) {
      navEl.appendChild(row('div', 'help-sec-head', section.title));
      for (const page of section.pages || []) {
        const isCurrent = page.name === currentName;
        const pageRow = row('div', isCurrent ? 'help-nav-page current' : 'help-nav-page', page.title || page.name);
        pageRow.setAttribute('data-page', String(page.name));
        pageRow.addEventListener('click', () => openHelpPanel(page.name, null));
        navEl.appendChild(pageRow);
        if (!isCurrent) continue;
        for (const heading of currentHeadings) {
          if (heading.level !== 2) continue;
          const subRow = row('div', 'help-nav-h2', heading.text);
          subRow.setAttribute('data-slug', String(heading.slug));
          subRow.addEventListener('click', () => { scrollToSlug(heading.slug); });
          navEl.appendChild(subRow);
        }
      }
    }
  }

  function renderHits(hits) {
    clearNode(navEl);
    for (const hit of hits) {
      const hitRow = row('div', 'help-hit', null);
      hitRow.setAttribute('data-page', String(hit.name));
      hitRow.setAttribute('data-slug', String(hit.slug));
      hitRow.appendChild(row('span', 'help-hit-title', `${hit.title} › ${hit.heading}`));
      hitRow.appendChild(row('span', 'help-hit-snippet', hit.snippet));
      hitRow.addEventListener('click', () => openHelpPanel(hit.name, hit.slug));
      navEl.appendChild(hitRow);
    }
  }

  function scrollToSlug(slug) {
    if (!slug || !SAFE_SLUG.test(String(slug))) return;
    const target = bodyEl.querySelector(`[id="${slug}"]`);
    if (target && target.scrollIntoView) target.scrollIntoView();
  }

  function renderMissing(name) {
    clearNode(bodyEl);
    const p = document.createElement('p');
    p.textContent = `No such help page: ${name}`;
    bodyEl.appendChild(p);
    currentHeadings = [];
  }

  function updateHistoryButtons() {
    backBtn.disabled = at <= 0;
    fwdBtn.disabled = at >= trail.length - 1;
  }

  async function show(name, slug) {
    const mine = ++showSeq;
    await getIndex();
    if (mine !== showSeq) return;
    const res = await getPage(name);
    if (mine !== showSeq) return;
    currentName = name;
    if (!res || !res.ok) {
      renderMissing(name);
      titleEl.textContent = 'Clodex Help';
    } else {
      const parsed = parseDoc(res.content);
      currentHeadings = parsed.headings || [];
      clearNode(bodyEl);
      bodyEl.appendChild(renderDoc(parsed, { resolveHref }));
      titleEl.textContent = res.title ? `Clodex Help — ${res.title}` : 'Clodex Help';
    }
    renderNav();
    if (slug) scrollToSlug(slug);
    else bodyEl.scrollTop = 0;
    updateHistoryButtons();
  }

  async function openHelpPanel(name = DEFAULT_PAGE, slug = null) {
    const page = name || DEFAULT_PAGE;
    const here = trail[at];
    if (!here || here.name !== page || here.slug !== (slug || null)) {
      trail.splice(at + 1, trail.length);
      trail.push({ name: page, slug: slug || null });
      at = trail.length - 1;
    }
    overlay.classList.remove('hidden');
    if (searchEl.focus) searchEl.focus();
    await show(page, slug || null);
  }

  function closeHelpPanel() {
    overlay.classList.add('hidden');
  }

  async function step(delta) {
    const next = at + delta;
    if (next < 0 || next >= trail.length) return;
    at = next;
    await show(trail[at].name, trail[at].slug);
  }

  async function buildIndex() {
    const idx = await getIndex();
    const pages = [];
    let missing = 0;
    for (const section of idx.sections || []) {
      for (const page of section.pages || []) {
        const res = await getPage(page.name);
        if (res && res.ok) pages.push({ name: page.name, text: res.content });
        else missing += 1;
      }
    }
    if (missing || !pages.length) searchIndexPromise = null;
    return buildSearchIndex(pages);
  }

  function ensureSearchIndex() {
    if (!searchIndexPromise) searchIndexPromise = buildIndex();
    return searchIndexPromise;
  }

  async function runSearch() {
    const q = String(searchEl.value == null ? '' : searchEl.value).trim();
    if (q.length < SEARCH_MIN) { renderNav(); return; }
    const idx = await ensureSearchIndex();
    if (String(searchEl.value == null ? '' : searchEl.value).trim() !== q) return;
    renderHits(search(idx, q, { limit: SEARCH_LIMIT }));
  }

  backBtn.addEventListener('click', () => step(-1));
  fwdBtn.addEventListener('click', () => step(1));
  document.getElementById('help-close').addEventListener('click', closeHelpPanel);
  overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) closeHelpPanel(); });
  searchEl.addEventListener('input', () => runSearch());
  searchEl.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (!searchEl.value) return;
      e.stopPropagation();
      searchEl.value = '';
      renderNav();
      if (searchEl.focus) searchEl.focus();
      return;
    }
    if (e.key !== 'Enter') return;
    const first = navEl.querySelector('.help-hit');
    if (!first) return;
    return openHelpPanel(first.getAttribute('data-page'), first.getAttribute('data-slug'));
  });
  bodyEl.addEventListener('click', (e) => {
    const link = e.target.closest && e.target.closest('a');
    if (!link) return;
    const page = link.getAttribute('data-page');
    const slug = link.getAttribute('data-slug');
    if (page) {
      e.preventDefault();
      return openHelpPanel(page, slug);
    }
    if (slug) {
      e.preventDefault();
      scrollToSlug(slug);
      return;
    }
    const href = link.getAttribute('href');
    if (isExternallyOpenable(href)) {
      e.preventDefault();
      api.openExternal(href);
    }
  });

  return { openHelpPanel, closeHelpPanel };
}

module.exports = { initHelpPanel };
