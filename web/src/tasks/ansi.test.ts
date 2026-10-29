import { expect, it } from 'vitest';
import { plainOutput } from './ansi.ts';

it('colours, cursor moves, window titles and hyperlinks are removed, the text stays', () => {
  expect(plainOutput('\u001b[31mred\u001b[0m and \u001b[1;32;4mbold\u001b[m')).toBe('red and bold');
  expect(plainOutput('a\u001b[2K\u001b[1Gb\u001b[?25l')).toBe('ab');
  expect(plainOutput('\u001b]0;title\u0007text')).toBe('text');
  expect(plainOutput('\u001b]8;;http://x\u001b\\link\u001b]8;;\u001b\\')).toBe('link');
  expect(plainOutput('plain <b>html</b> & "quotes"')).toBe('plain <b>html</b> & "quotes"');
});
it('CRLF is a newline; a carriage return rewinds its line (a progress bar shows its last state)', () => {
  expect(plainOutput('a\r\nb\r\n')).toBe('a\nb\n');
  expect(plainOutput('10%\r50%\r100%\ndone')).toBe('100%\ndone');
});

it('a line that ends with a carriage return keeps its text (rsync / wget progress); the last rewind still wins', () => {
  expect(plainOutput('step 1\nprogress 40%\r')).toBe('step 1\nprogress 40%');
  expect(plainOutput('file\n  1%\r 50%\r100%\r')).toBe('file\n100%');
  expect(plainOutput('a\r\r\nb')).toBe('a\nb');
});
it('charset selects, save / restore cursor, keypad modes and other C0 characters are removed', () => {
  expect(plainOutput('\u001b(B\u001b[mok')).toBe('ok');
  expect(plainOutput('\u001b7saved\u001b8 \u001b=\u001b>x\u0007\u0000y')).toBe('saved xy');
  expect(plainOutput('tab\there\nnext')).toBe('tab\there\nnext');
});
it('a backspace deletes the character before it', () => {
  expect(plainOutput('-\b\\\b|\b/\bdone')).toBe('done');
  expect(plainOutput('ab\bc')).toBe('ac');
});
it('a truncated tail that starts inside a CSI loses the remains of it', () => {
  expect(plainOutput('2;32mcompiling\n', true)).toBe('compiling\n');
  expect(plainOutput('2;32mcompiling\n')).toBe('2;32mcompiling\n');
  expect(plainOutput('plain text\n', true)).toBe('plain text\n');
});
