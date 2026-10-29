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
