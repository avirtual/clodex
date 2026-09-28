'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const { registerIpcHandlers } = require('../ipc-handlers');

const LIST = [{ id: 'hand', name: 'hand' }];

function mkHandlers(templates) {
  const handlers = {};
  const menus = [];
  const stub = () => () => {};
  const deps = new Proxy({
    handle: (ch, fn) => { handlers[ch] = fn; },
    on: (ch, fn) => { handlers[ch] = fn; },
    templates: { list: () => LIST, ...templates },
    refreshAppMenu: () => { menus.push(1); },
    log: { info() {}, warn() {}, error() {} },
  }, { get: (t, p) => (p in t ? t[p] : stub()) });
  registerIpcHandlers(deps);
  return { handlers, menus };
}

const erofs = () => {
  const e = new Error("EROFS: read-only file system, open '/root/.clodex/library/templates/hand.json'");
  e.code = 'EROFS';
  throw e;
};

test('a library write that throws answers ok:false with the error and the list, for all three handlers', () => {
  const { handlers, menus } = mkHandlers({ save: erofs, saveByName: erofs, remove: erofs });
  for (const [ch, arg] of [
    ['templates:save', { id: 'hand', name: 'hand' }],
    ['templates:saveByName', { name: 'hand' }],
    ['templates:remove', 'hand'],
  ]) {
    let res;
    assert.doesNotThrow(() => { res = handlers[ch]({}, arg); }, `${ch} must not throw to the transport`);
    assert.deepStrictEqual(res, {
      ok: false,
      error: "EROFS: read-only file system, open '/root/.clodex/library/templates/hand.json'",
      templates: LIST,
    }, ch);
  }
  assert.strictEqual(menus.length, 0, 'a failed write refreshes no menu');
});

test('a library write that lands answers ok:true with the list', () => {
  const { handlers, menus } = mkHandlers({ save() {}, saveByName: (t) => ({ ...t, id: t.name }), remove() {} });
  assert.deepStrictEqual(handlers['templates:save']({}, { id: 'hand', name: 'hand' }), { ok: true, templates: LIST });
  assert.deepStrictEqual(handlers['templates:saveByName']({}, { name: 'hand' }),
    { ok: true, template: { name: 'hand', id: 'hand' }, templates: LIST });
  assert.deepStrictEqual(handlers['templates:remove']({}, 'hand'), { ok: true, templates: LIST });
  assert.strictEqual(menus.length, 3);
});
