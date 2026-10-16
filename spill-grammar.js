'use strict';

const HEAD_TITLE_MAX = 300;
const TITLE_SRC = String.raw`[^\n]{0,${HEAD_TITLE_MAX - 1}}[^\s\n]`;
const FILED_SRC = String.raw`((?:\d+ B|\d+\.\d KB)(?: of prose)? filed at (\/[^\n]*\/spill\/[^\/\n]+\/([0-9a-f]{16})\.md))`;
const FILED_POINTER_RE = new RegExp(String.raw`^\s*(?:(${TITLE_SRC}) — )?${FILED_SRC}\s*$`);

module.exports = { HEAD_TITLE_MAX, TITLE_SRC, FILED_SRC, FILED_POINTER_RE };
