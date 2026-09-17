'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { parseDoc, sectionSlice, buildSearchIndex, search } = require('./doc-parse');

const MANIFEST_PATH = 'docs/help.json';

function toAbsolute(root, relative) {
  return path.join(root, ...String(relative).split('/'));
}

function readManifest(root) {
  const file = toAbsolute(root, MANIFEST_PATH);
  if (!fs.existsSync(file)) throw new Error(`help corpus manifest not found: ${MANIFEST_PATH}`);
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  const sections = [];
  const order = [];
  const byName = new Map();
  for (const section of (data && data.sections) || []) {
    const title = section && section.title;
    const pages = [];
    for (const page of (section && section.pages) || []) {
      const entry = { name: page && page.name, path: page && page.path, section: title };
      pages.push(entry);
      order.push(entry);
      byName.set(entry.name, entry);
    }
    sections.push({ title, pages });
  }
  return { sections, order, byName };
}

function readPage(root, entry) {
  const file = toAbsolute(root, entry.path);
  if (!fs.existsSync(file)) throw new Error(`help corpus page not found: ${entry.path}`);
  const content = fs.readFileSync(file, 'utf8');
  const parsed = parseDoc(content);
  const h1 = parsed.headings.find((h) => h.level === 1);
  return {
    name: entry.name,
    section: entry.section,
    title: h1 ? h1.text : parsed.title,
    content,
    headings: parsed.headings.map((h) => ({ level: h.level, text: h.text, slug: h.slug })),
  };
}

function loadHelpCorpus(root) {
  const base = String(root == null ? '' : root);
  const pages = new Map();
  let manifest = null;
  let searchIndex = null;

  function getManifest() {
    if (!manifest) manifest = readManifest(base);
    return manifest;
  }

  function pageOf(name) {
    const entry = getManifest().byName.get(name);
    if (!entry) return null;
    const cached = pages.get(entry.name);
    if (cached) return cached;
    const page = readPage(base, entry);
    pages.set(entry.name, page);
    return page;
  }

  function list() {
    return getManifest().order.map((entry) => {
      const page = pageOf(entry.name);
      return { name: page.name, title: page.title, section: page.section };
    });
  }

  function get(name) {
    const page = pageOf(name);
    if (!page) return null;
    return { name: page.name, title: page.title, section: page.section, content: page.content };
  }

  function sectionOf(name, slug) {
    const page = pageOf(name);
    if (!page) return null;
    const content = sectionSlice(page.content, slug);
    if (content == null) return null;
    return { name: page.name, title: page.title, section: page.section, slug, content };
  }

  function searchCorpus(q, limit) {
    if (!String(q == null ? '' : q).trim()) return [];
    if (!searchIndex) {
      searchIndex = buildSearchIndex(getManifest().order.map((entry) => {
        const page = pageOf(entry.name);
        return { name: page.name, text: page.content };
      }));
    }
    return search(searchIndex, q, { limit }).map((hit) => ({
      name: hit.name,
      title: hit.title,
      heading: hit.heading,
      slug: hit.slug,
      snippet: hit.snippet,
    }));
  }

  function index() {
    return {
      sections: getManifest().sections.map((section) => ({
        title: section.title,
        pages: section.pages.map((entry) => {
          const page = pageOf(entry.name);
          return {
            name: page.name,
            title: page.title,
            headings: page.headings.map((h) => ({ level: h.level, text: h.text, slug: h.slug })),
          };
        }),
      })),
    };
  }

  return { list, get, section: sectionOf, search: searchCorpus, index };
}

module.exports = { loadHelpCorpus };
