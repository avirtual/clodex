'use strict';

const { SEAT_IMAGE_FILE_PATTERN } = require('./seat-images');
const { SEAT_FILE_FILE_PATTERN } = require('./seat-files');

const SEAT_MSG_FILE_PATTERN = 'msg-\\d+-\\d+\\.txt';
const SEAT_MESSAGE_NAME_PATTERN = `${SEAT_MSG_FILE_PATTERN}|${SEAT_IMAGE_FILE_PATTERN}|${SEAT_FILE_FILE_PATTERN}`;
const SEAT_MESSAGE_NAME_RE = new RegExp(`^(?:${SEAT_MESSAGE_NAME_PATTERN})$`);

function seatMsgFileName(pid, n) {
  return `msg-${pid}-${n}.txt`;
}

function isSeatMessageFileName(name) {
  return typeof name === 'string' && SEAT_MESSAGE_NAME_RE.test(name);
}

module.exports = { SEAT_MSG_FILE_PATTERN, SEAT_MESSAGE_NAME_PATTERN, seatMsgFileName, isSeatMessageFileName };
