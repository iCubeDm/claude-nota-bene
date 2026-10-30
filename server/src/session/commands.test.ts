import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ServerEvent, SlashCommand } from '@nota-bene/shared';
import { fakeBackend } from '../agent/fake.ts';
import { EventHub } from '../hub.ts';
import { createSessionManager } from '../session.ts';
import { CommandKeeper } from './commands.ts';

describe('CommandKeeper', () => {
  const c = (name: string): SlashCommand => ({ name, description: name });

  it('announces a change once; the same list again is not news', async () => {
    const seen: SlashCommand[][] = [];
    const k = new CommandKeeper((ev) => seen.push(ev.commands));
    await k.load({ supportedCommands: async () => [c('a')] }, () => true);
    await k.load({ supportedCommands: async () => [c('a')] }, () => true);
    k.set([c('a'), c('b')]);
    expect(seen).toEqual([[c('a')], [c('a'), c('b')]]);
    expect(k.commands).toEqual([c('a'), c('b')]);
  });

  it('an agent that is no longer the current one changes nothing', async () => {
    const seen: unknown[] = [];
    const k = new CommandKeeper((ev) => seen.push(ev));
    await k.load({ supportedCommands: async () => [c('a')] }, () => false);
    expect(seen).toEqual([]);
    expect(k.commands).toEqual([]);
  });
});

describe('slash commands in a session', () => {
  let home: string;
  const prev = process.env.NOTA_BENE_HOME;
  beforeEach(() => { home = fs.mkdtempSync(path.join(os.tmpdir(), 'nb-cmds-')); process.env.NOTA_BENE_HOME = home; });
  afterEach(() => {
    if (prev === undefined) delete process.env.NOTA_BENE_HOME; else process.env.NOTA_BENE_HOME = prev;
    fs.rmSync(home, { recursive: true, force: true });
  });

  async function until(cond: () => boolean): Promise<void> {
    const end = Date.now() + 2000;
    while (!cond()) {
      if (Date.now() > end) throw new Error('timeout');
      await new Promise((r) => setTimeout(r, 5));
    }
  }

  const setup = (backend: ReturnType<typeof fakeBackend>) => {
    const hub = new EventHub();
    const events: ServerEvent[] = [];
    hub.attach({ send: (d) => { const e = JSON.parse(d) as ServerEvent; if (e.kind !== 'replay') events.push(e); } });
    return { hub, events, make: () => createSessionManager({ hub, backend, cwd: home }) };
  };
  const lists = (events: ServerEvent[]) => events.flatMap((e) => (e.kind === 'commands' ? [e.commands.map((x) => x.name)] : []));

  it('the agent\'s list is announced once it is up and is never stored; a pushed commands_changed replaces it (filtered)', async () => {
    const backend = fakeBackend([{
      text: 'x',
      frames: [{ type: 'system', subtype: 'commands_changed', commands: [
        { name: 'new-skill', description: 'n', argumentHint: '' }, { name: 'model', description: 'm', argumentHint: '', builtin: true },
      ] }],
    }], { commands: [{ name: 'ping', description: 'p' }] });
    const { hub, events, make } = setup(backend);
    const s = await make();
    await until(() => lists(events).length === 1);
    expect(s.commands().map((x) => x.name)).toEqual(['ping']);
    s.send({ id: 'u1', text: 'hi' });
    await until(() => lists(events).length === 2);
    expect(lists(events)).toEqual([['ping'], ['new-skill']]);
    expect(s.commands().map((x) => x.name)).toEqual(['new-skill']);
    expect(events.some((e) => e.kind === 'agent' && (e.e as { t: string }).t === 'commands')).toBe(false); // server-internal
    let replay: ServerEvent[] = [];
    hub.attach({ send: (d) => { const e = JSON.parse(d) as ServerEvent; if (e.kind === 'replay') replay = e.events; } });
    expect(replay.some((e) => e.kind === 'commands')).toBe(false);
    s.close();
  });

  it('a switch empties the list at once; the new agent brings its own', async () => {
    const backend = fakeBackend([{ text: 'x' }], { commands: [{ name: 'ping', description: 'p' }] });
    const { events, make } = setup(backend);
    const s = await make();
    await until(() => lists(events).length === 1);
    await s.switch({ id: null, dir: home });
    await until(() => lists(events).length === 3);
    expect(lists(events)).toEqual([['ping'], [], ['ping']]);
    s.close();
  });
});
