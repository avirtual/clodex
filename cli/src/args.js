// args.js — a tiny, dependency-free argv parser.
//
// Splits an argv array into { _: positionals, ...flags }. Rules:
//   --flag value   → flags.flag = value        (unless declared boolean)
//   --flag=value   → flags.flag = value
//   --bool         → flags.bool = true         (declared in `booleans`)
//   -x             → treated as a long flag alias only if in `aliases`
//   --             → everything after is positional (verbatim, for `send`)
//   repeatable     → flags declared in `multi` accumulate into an array
//
// Deliberately NOT a full getopt: verbs know their own shapes and pull what
// they need. `stopAtPositional` lets a verb (ctx add --tunnel …) grab a greedy
// rest without the parser stealing later tokens (see options).
'use strict';

const { CliError, EXIT } = require('./errors');

function parse(argv, opts = {}) {
  const booleans = new Set(opts.booleans || []);
  const multi = new Set(opts.multi || []);
  const aliases = opts.aliases || {};
  const out = { _: [] };
  const setFlag = (name, val) => {
    if (multi.has(name)) { (out[name] = out[name] || []).push(val); }
    else out[name] = val;
  };

  for (let i = 0; i < argv.length; i++) {
    let tok = argv[i];
    if (tok === '--') { for (i++; i < argv.length; i++) out._.push(argv[i]); break; }
    if (typeof tok === 'string' && tok.startsWith('--')) {
      let name = tok.slice(2);
      let val = null;
      const eq = name.indexOf('=');
      if (eq >= 0) { val = name.slice(eq + 1); name = name.slice(0, eq); }
      if (aliases[name]) name = aliases[name];
      if (booleans.has(name)) {
        if (val != null) {
          if (val === 'false' || val === '0') { out[name] = false; continue; }
          if (val === 'true' || val === '1') { out[name] = true; continue; }
          throw new CliError(EXIT.USAGE, `flag --${name} is a boolean, got =${val}`);
        }
        out[name] = true;
        continue;
      }
      // Greedy rest-consumer (e.g. --tunnel kubectl port-forward … {port}:7900):
      // capture the remainder of argv as an array so a real argv with spaces is
      // stored without split ambiguity.
      if ((opts.greedy || []).includes(name)) {
        const rest = argv.slice(i + 1);
        if (rest.length === 0) throw new CliError(EXIT.USAGE, `flag --${name} needs at least one argument`);
        out[name] = rest;
        i = argv.length;
        continue;
      }
      if (val == null) {
        val = argv[i + 1];
        // A repeatable passthrough flag (--arg) takes the literal next token,
        // dashes and all — raw agent flags like `--arg --model` are the norm
        // there. Non-multi flags still reject a dashy next token as a likely
        // missing value (`--url --token`).
        const dashy = typeof val === 'string' && val.startsWith('--');
        if (val == null || (dashy && !multi.has(name))) {
          throw new CliError(EXIT.USAGE, `flag --${name} needs a value`);
        }
        i++;
      }
      setFlag(name, val);
      continue;
    }
    // A short flag alias like -h → --help (only if declared).
    if (typeof tok === 'string' && tok.startsWith('-') && tok.length > 1 && aliases[tok.slice(1)]) {
      const name = aliases[tok.slice(1)];
      if (booleans.has(name)) { out[name] = true; continue; }
      const val = argv[++i];
      if (val == null) throw new CliError(EXIT.USAGE, `flag -${tok.slice(1)} needs a value`);
      setFlag(name, val);
      continue;
    }
    out._.push(tok);
  }
  return out;
}

module.exports = { parse };
