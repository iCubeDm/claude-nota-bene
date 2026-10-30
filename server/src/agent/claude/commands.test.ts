import { describe, expect, it } from 'vitest';
import { BUILTIN_OK, CommandTap, pickCommands, toSlash } from './commands.ts';

const row = (name: string, o: Record<string, unknown> = {}) => ({ name, description: `${name} d`, argumentHint: '', ...o });

describe('toSlash', () => {
  it('maps the SDK row to the wire row, leaving out what is empty', () => {
    expect(toSlash(row('a'))).toEqual({ name: 'a', description: 'a d' });
    expect(toSlash(row('b', { argumentHint: '[x]', aliases: ['bb'], builtin: true }))).toEqual({ name: 'b', description: 'b d', hint: '[x]', aliases: ['bb'], builtin: true });
    expect(toSlash(row('c', { aliases: [] }))).toEqual({ name: 'c', description: 'c d' });
  });
});

describe('pickCommands', () => {
  const rows = [row('compact', { builtin: true }), row('model', { builtin: true }), row('proj-skill'), row('context', { builtin: true }), row('plug:skill', { aliases: ['skill'] })].map(toSlash);

  it('keeps every non-builtin and only the allowlisted builtins; the user\'s come first, order kept', () => {
    expect(pickCommands(rows).map((c) => c.name)).toEqual(['proj-skill', 'plug:skill', 'compact', 'context']);
  });

  it('never shows a command the CLI tags as bound to the terminal', () => {
    expect(pickCommands(rows, ['compact', 'proj-skill']).map((c) => c.name)).toEqual(['plug:skill', 'context']);
  });

  it('a name appears once (rows can share one): the first of the sorted list stays', () => {
    const dup = [row('x', { builtin: true }), row('compact', { builtin: true }), row('compact')].map(toSlash);
    const out = pickCommands(dup);
    expect(out.map((c) => c.name)).toEqual(['compact']);
    expect(out[0].builtin).toBeUndefined();
  });

  it('the allowlist holds no command that changes state the UI shows elsewhere', () => {
    for (const n of ['model', 'effort', 'fast', 'advisor', 'output-style', 'config', 'autocompact', 'color', 'focus', 'doctor', 'reload-plugins']) expect(BUILTIN_OK.has(n)).toBe(false);
  });
});

describe('CommandTap', () => {
  const frames = (tap: CommandTap<object>, f: object) => [...tap.through(f)] as { subtype?: string; commands?: unknown }[];

  it('an init that brings terminal-only names adds the cached list again, once', () => {
    const tap = new CommandTap<object>();
    tap.rows = [row('a'), row('b')];
    const out = frames(tap, { type: 'system', subtype: 'init', terminal_slash_commands: ['b'] });
    expect(out.map((f) => f.subtype)).toEqual(['init', 'commands_changed']);
    expect(out[1].commands).toEqual(tap.rows);
    expect(tap.terminal).toEqual(['b']);
    expect(frames(tap, { type: 'system', subtype: 'init', terminal_slash_commands: ['b'] })).toHaveLength(1); // every turn inits: only news counts
  });

  it('no cached list yet: nothing to add; a pushed list is cached', () => {
    const tap = new CommandTap<object>();
    expect(frames(tap, { type: 'system', subtype: 'init', terminal_slash_commands: ['b'] })).toHaveLength(1);
    frames(tap, { type: 'system', subtype: 'commands_changed', commands: [row('z')] });
    expect(tap.rows).toEqual([row('z')]);
    expect(frames(tap, { type: 'assistant' })).toHaveLength(1);
  });
});
