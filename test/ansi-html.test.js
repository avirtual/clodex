'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { ansiRuns } = require('../renderer/lib/ansi-html');

const E = '\x1b[';

const SGR_TABLE = [
  ['bold 1', `${E}1mx`, 'font-weight:bold'],
  ['dim 2', `${E}2mx`, 'opacity:0.6'],
  ['italic 3', `${E}3mx`, 'font-style:italic'],
  ['underline 4', `${E}4mx`, 'text-decoration:underline'],
  ['22 clears bold and dim', `${E}1;2m${E}22mx`, ''],
  ['23 clears italic', `${E}3;1m${E}23mx`, 'font-weight:bold'],
  ['24 clears underline', `${E}4m${E}24mx`, ''],
  ['fg 31', `${E}31mx`, 'color:rgb(205,49,49)'],
  ['fg 37', `${E}37mx`, 'color:rgb(229,229,229)'],
  ['fg 90', `${E}90mx`, 'color:rgb(102,102,102)'],
  ['fg 97', `${E}97mx`, 'color:rgb(255,255,255)'],
  ['fg 39 resets', `${E}31m${E}39mx`, ''],
  ['fg truecolor', `${E}38;2;215;119;87mx`, 'color:rgb(215,119,87)'],
  ['fg 256 basic', `${E}38;5;9mx`, 'color:rgb(241,76,76)'],
  ['fg 256 cube', `${E}38;5;196mx`, 'color:rgb(255,0,0)'],
  ['fg 256 grey', `${E}38;5;244mx`, 'color:rgb(128,128,128)'],
  ['bg 42', `${E}42mx`, 'background-color:rgb(13,188,121)'],
  ['bg 104', `${E}104mx`, 'background-color:rgb(59,142,234)'],
  ['bg 49 resets', `${E}42m${E}49mx`, ''],
  ['bg truecolor', `${E}48;2;1;2;3mx`, 'background-color:rgb(1,2,3)'],
  ['bg 256', `${E}48;5;21mx`, 'background-color:rgb(0,0,255)'],
  ['0 resets all', `${E}1;3;4;31;42m${E}0mx`, ''],
  ['bare m resets', `${E}1m${E}mx`, ''],
  ['combined order', `${E}4;3;2;1;38;2;9;8;7;48;5;16mx`, 'font-weight:bold;opacity:0.6;font-style:italic;text-decoration:underline;color:rgb(9,8,7);background-color:rgb(0,0,0)'],
];

for (const [name, input, style] of SGR_TABLE) {
  test(`SGR ${name}`, () => {
    assert.deepStrictEqual(ansiRuns(input), [{ text: 'x', style }]);
  });
}

test('adjacent text with the same style merges into one run and a style change splits it', () => {
  assert.deepStrictEqual(ansiRuns(`a${E}1mb${E}22mc${E}39md`), [
    { text: 'a', style: '' },
    { text: 'b', style: 'font-weight:bold' },
    { text: 'cd', style: '' },
  ]);
});

test('an OSC 8 hyperlink is stripped to its visible text', () => {
  assert.deepStrictEqual(ansiRuns('see \x1b]8;;https://x.test\x07the docs\x1b]8;;\x1b\\ now'), [{ text: 'see the docs now', style: '' }]);
});

test('cursor-move and erase CSI sequences are stripped and change no style', () => {
  assert.deepStrictEqual(ansiRuns(`a${E}2A${E}10Cb${E}K${E}?25lc`), [{ text: 'abc', style: '' }]);
});

test('text holding < and & comes back as literal characters, never as markup', () => {
  assert.deepStrictEqual(ansiRuns(`${E}1m<b>&amp; x</b>`), [{ text: '<b>&amp; x</b>', style: 'font-weight:bold' }]);
});

test('newlines and tabs survive; other control characters are dropped', () => {
  assert.deepStrictEqual(ansiRuns('a\tb\r\nc\x07'), [{ text: 'a\tb\nc', style: '' }]);
});
