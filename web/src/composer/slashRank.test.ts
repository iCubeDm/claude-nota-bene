import { expect, it } from 'vitest';
import type { SlashCommand } from '@nota-bene/shared';
import { rankCommands, slashToken } from './slashRank.ts';

const c = (name: string, aliases?: string[]): SlashCommand => ({ name, description: '', ...(aliases ? { aliases } : {}) });
const names = (l: SlashCommand[]) => l.map((x) => x.name);

it('an empty query lists everything in the given order', () => {
  expect(names(rankCommands([c('b'), c('a')], ''))).toEqual(['b', 'a']);
});

it('prefix, then contains, then subsequence, then an alias; the given order inside a group', () => {
  const list = [c('xx-ping'), c('p-i-n-g'), c('ping2'), c('ping'), c('other', ['pinger']), c('nope')];
  expect(names(rankCommands(list, 'ping'))).toEqual(['ping2', 'ping', 'xx-ping', 'p-i-n-g', 'other']);
});

it('matches case-insensitively and finds a plugin skill by its short alias', () => {
  const list = [c('superpowers:brainstorming', ['brainstorming']), c('Zed')];
  expect(names(rankCommands(list, 'BRAIN'))).toEqual(['superpowers:brainstorming']);
  expect(names(rankCommands(list, 'zed'))).toEqual(['Zed']);
});

it('slashToken: only a slash at offset 0, up to the first whitespace', () => {
  expect(slashToken('/pi', 3)).toBe('pi');
  expect(slashToken('/', 1)).toBe('');
  expect(slashToken('/pi', 2)).toBe('p'); // the caret inside the word
  expect(slashToken('/pi arg', 7)).toBeNull(); // the caret is past the whitespace
  expect(slashToken('/pi arg', 3)).toBe('pi'); // back in the first word
  expect(slashToken(' /pi', 4)).toBeNull();
  expect(slashToken('hi /pi', 6)).toBeNull();
  expect(slashToken('', 0)).toBeNull();
});
