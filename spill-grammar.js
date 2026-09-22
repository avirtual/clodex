'use strict';

const FILED_SRC = String.raw`((?:\d+ B|\d+\.\d KB)(?: of prose)? filed at (\/[^\n]*\/spill\/[^\/\n]+\/([0-9a-f]{16})\.md))`;
const FILED_POINTER_RE = new RegExp(String.raw`^\s*(?:([^\n]{0,79}[^\s\n]) — )?${FILED_SRC}\s*$`);

module.exports = { FILED_SRC, FILED_POINTER_RE };
