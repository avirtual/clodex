'use strict';

const { adapterFor } = require('../../cli-adapters');

function effortOptions(type, current) {
  const rows = [{ value: '', label: '(CLI default)' }];
  const a = adapterFor(type);
  if (!a || !a.effort || !Array.isArray(a.effort.values)) return rows;
  const values = a.effort.values;
  for (const v of values) rows.push({ value: v, label: v });
  if (typeof current === 'string' && current && !values.includes(current)) {
    rows.push({ value: current, label: `${current} (not valid for ${a.label})` });
  }
  return rows;
}

module.exports = { effortOptions };
