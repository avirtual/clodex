'use strict';

const SPILLED_BODY = '[Runtime note: Clodex filed this body in full; it is not carried in the transcript.]';
const SPILLED_BODY_FIRST = '[Runtime note: Clodex carries your two newest long intent bodies in full as examples and replaces earlier ones with this note; this body was delivered and filed in full. Every new intent still needs its complete body; never write this note.]';
const SPILLED_BODY_EPHEMERAL = '[Runtime note: Clodex carries your newest long intent body in full as an example and replaces earlier ones with this note; this body was delivered and filed in full. Every new intent still needs its complete body; never write this note.]';
const PLACEHOLDER = "[Runtime note: this turn's text was delivered and filed in full; Clodex keeps it out of the request. Never write this note.]";
const PLACEHOLDER_LEGACY = "(This turn's text was delivered in full; Clodex keeps it out of the request.)";
const STAND_INS = Object.freeze([PLACEHOLDER, PLACEHOLDER_LEGACY, SPILLED_BODY, SPILLED_BODY_FIRST, SPILLED_BODY_EPHEMERAL]);

module.exports = { SPILLED_BODY, SPILLED_BODY_FIRST, SPILLED_BODY_EPHEMERAL, PLACEHOLDER, PLACEHOLDER_LEGACY, STAND_INS };
