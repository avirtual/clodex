'use strict';

function createPopoverGroup() {
  const closers = new Map();

  function register(key, close) {
    if (closers.has(key)) throw new Error(`popover-group: duplicate key ${key}`);
    closers.set(key, close);
    return function closeSiblings() {
      for (const [k, fn] of closers) if (k !== key) fn();
    };
  }

  return { register };
}

module.exports = { createPopoverGroup };
