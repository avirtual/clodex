'use strict';

function evalRendererModule(source, id) {
  const module = { exports: {} };
  const requireShim = () => {
    throw new Error(`${id}: a renderer half cannot require() in the browser — it is evaluated from source text`);
  };
  const fn = new Function('module', 'exports', 'require',
    `${source}\n//# sourceURL=clodex-plugin:${id}/renderer.js`);
  fn(module, module.exports, requireShim);
  return module.exports;
}

module.exports = { evalRendererModule };
