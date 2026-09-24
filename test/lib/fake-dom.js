'use strict';

function detach(node) {
  if (node.parentNode) node.parentNode.removeChild(node);
}

function makeNode(props) {
  const node = {
    parentNode: null,
    childNodes: [],
    get firstChild() { return node.childNodes[0] || null; },
    get nextSibling() {
      const p = node.parentNode;
      if (!p) return null;
      return p.childNodes[p.childNodes.indexOf(node) + 1] || null;
    },
    appendChild(child) { return node.insertBefore(child, null); },
    insertBefore(child, ref) {
      if (child.isFragment) {
        for (const k of [...child.childNodes]) node.insertBefore(k, ref);
        return child;
      }
      detach(child);
      const at = ref ? node.childNodes.indexOf(ref) : -1;
      if (ref && at < 0) throw new Error('insertBefore: ref is not a child');
      if (at < 0) node.childNodes.push(child);
      else node.childNodes.splice(at, 0, child);
      child.parentNode = node;
      return child;
    },
    removeChild(child) {
      const at = node.childNodes.indexOf(child);
      if (at < 0) throw new Error('removeChild: not a child');
      node.childNodes.splice(at, 1);
      child.parentNode = null;
      return child;
    },
    replaceChild(next, old) {
      node.insertBefore(next, old);
      return node.removeChild(old);
    },
    replaceChildren(...kids) {
      for (const k of [...node.childNodes]) node.removeChild(k);
      for (const k of kids) node.appendChild(k);
    },
    remove() { detach(node); },
  };
  return Object.defineProperties(node, Object.getOwnPropertyDescriptors(props));
}

function textOf(node) {
  if (node.nodeType === 3) return node.data;
  return node.childNodes.map(textOf).join('');
}

function makeElement(tag) {
  const node = makeNode({
    nodeType: 1,
    tag,
    className: '',
    dataset: {},
    style: {},
    title: '',
    hidden: false,
    listeners: {},
    addEventListener(type, cb) { node.listeners[type] = cb; },
    removeEventListener(type, cb) { if (node.listeners[type] === cb) delete node.listeners[type]; },
    set innerHTML(v) { throw new Error(`innerHTML written: ${v}`); },
  });
  Object.defineProperty(node, 'textContent', {
    get: () => textOf(node),
    set: (v) => {
      for (const k of [...node.childNodes]) node.removeChild(k);
      if (v !== '' && v != null) node.appendChild(makeText(String(v)));
    },
  });
  return node;
}

function makeText(data) {
  return makeNode({ nodeType: 3, data });
}

function fakeDocument() {
  return {
    createElement: makeElement,
    createTextNode: makeText,
    createDocumentFragment: () => makeNode({ nodeType: 11, isFragment: true }),
  };
}

module.exports = { fakeDocument, textOf };
