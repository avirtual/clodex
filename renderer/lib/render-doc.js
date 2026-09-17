'use strict';

const HEADING_TAGS = { 1: 'h1', 2: 'h2', 3: 'h3', 4: 'h4', 5: 'h5', 6: 'h6' };
const EXTERNAL_REL = 'noreferrer noopener';

function makeText(doc, value) {
  return doc.createTextNode(String(value == null ? '' : value));
}

function makeEl(doc, tag) {
  return doc.createElement(tag);
}

function renderInline(nodes, parent, ctx) {
  for (const node of nodes || []) {
    if (!node || typeof node !== 'object') continue;
    if (node.type === 'text') {
      parent.appendChild(makeText(ctx.doc, node.text));
    } else if (node.type === 'code') {
      const el = makeEl(ctx.doc, 'code');
      el.textContent = String(node.text == null ? '' : node.text);
      parent.appendChild(el);
    } else if (node.type === 'strong' || node.type === 'em') {
      const el = makeEl(ctx.doc, node.type === 'strong' ? 'strong' : 'em');
      renderInline(node.children, el, ctx);
      parent.appendChild(el);
    } else if (node.type === 'link') {
      renderLink(node, parent, ctx);
    }
  }
}

function renderLink(node, parent, ctx) {
  const target = ctx.resolveHref ? ctx.resolveHref(node.href) : null;
  if (!target || typeof target !== 'object') {
    renderInline(node.children, parent, ctx);
    return;
  }
  const a = makeEl(ctx.doc, 'a');
  if (target.kind === 'external') {
    a.setAttribute('href', String(target.url == null ? '' : target.url));
    a.setAttribute('target', '_blank');
    a.setAttribute('rel', EXTERNAL_REL);
  } else if (target.kind === 'page' || target.kind === 'anchor') {
    a.setAttribute('href', '#');
    if (target.name != null) a.setAttribute('data-page', String(target.name));
    if (target.slug != null) a.setAttribute('data-slug', String(target.slug));
  } else {
    renderInline(node.children, parent, ctx);
    return;
  }
  renderInline(node.children, a, ctx);
  parent.appendChild(a);
}

function renderCells(cells, row, tag, ctx) {
  for (const cell of cells || []) {
    const el = makeEl(ctx.doc, tag);
    renderInline(cell, el, ctx);
    row.appendChild(el);
  }
}

function renderTable(block, parent, ctx) {
  const table = makeEl(ctx.doc, 'table');
  const thead = makeEl(ctx.doc, 'thead');
  const headRow = makeEl(ctx.doc, 'tr');
  renderCells(block.header, headRow, 'th', ctx);
  thead.appendChild(headRow);
  table.appendChild(thead);
  const tbody = makeEl(ctx.doc, 'tbody');
  for (const row of block.rows || []) {
    const tr = makeEl(ctx.doc, 'tr');
    renderCells(row, tr, 'td', ctx);
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  parent.appendChild(table);
}

function renderBlocks(blocks, parent, ctx) {
  for (const block of blocks || []) {
    if (!block || typeof block !== 'object') continue;
    if (block.type === 'heading') {
      const tag = HEADING_TAGS[block.level] || 'h6';
      const el = makeEl(ctx.doc, tag);
      if (block.slug) el.setAttribute('id', String(block.slug));
      renderInline(block.text, el, ctx);
      parent.appendChild(el);
    } else if (block.type === 'paragraph') {
      const el = makeEl(ctx.doc, 'p');
      renderInline(block.children, el, ctx);
      parent.appendChild(el);
    } else if (block.type === 'code') {
      const pre = makeEl(ctx.doc, 'pre');
      const code = makeEl(ctx.doc, 'code');
      if (block.lang) code.setAttribute('data-lang', String(block.lang));
      code.textContent = String(block.text == null ? '' : block.text);
      pre.appendChild(code);
      parent.appendChild(pre);
    } else if (block.type === 'list') {
      const list = makeEl(ctx.doc, block.ordered ? 'ol' : 'ul');
      if (block.ordered && Number(block.start) > 1) list.setAttribute('start', String(block.start));
      for (const item of block.items || []) {
        const li = makeEl(ctx.doc, 'li');
        renderBlocks(item.children, li, ctx);
        list.appendChild(li);
      }
      parent.appendChild(list);
    } else if (block.type === 'blockquote') {
      const el = makeEl(ctx.doc, 'blockquote');
      renderBlocks(block.children, el, ctx);
      parent.appendChild(el);
    } else if (block.type === 'table') {
      renderTable(block, parent, ctx);
    } else if (block.type === 'hr') {
      parent.appendChild(makeEl(ctx.doc, 'hr'));
    } else if (block.type === 'anchor') {
      const el = makeEl(ctx.doc, 'span');
      el.setAttribute('id', String(block.id == null ? '' : block.id));
      parent.appendChild(el);
    }
  }
}

function renderDoc(parsed, options) {
  const opts = options || {};
  const doc = opts.document || globalThis.document;
  const ctx = { doc, resolveHref: typeof opts.resolveHref === 'function' ? opts.resolveHref : null };
  const frag = doc.createDocumentFragment();
  const blocks = parsed && Array.isArray(parsed.blocks) ? parsed.blocks
    : (Array.isArray(parsed) ? parsed : []);
  renderBlocks(blocks, frag, ctx);
  return frag;
}

module.exports = { renderDoc };
