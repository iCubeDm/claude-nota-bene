import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ModelOption, ServerEvent } from '@nota-bene/shared';
import { fakeBackend } from './agent/fake.ts';
import type { AgentBackend } from './agent/types.ts';
import { EventHub } from './hub.ts';
import { prefsKey, readPrefs, setModelPref } from './prefs.ts';
import { createSessionManager } from './session.ts';

let home: string;
const prevHome = process.env.NOTA_BENE_HOME;
beforeEach(() => { home = fs.mkdtempSync(path.join(os.tmpdir(), 'nb-session-model-')); process.env.NOTA_BENE_HOME = home; });
afterEach(() => {
  if (prevHome === undefined) delete process.env.NOTA_BENE_HOME; else process.env.NOTA_BENE_HOME = prevHome;
  fs.rmSync(home, { recursive: true, force: true });
});

const MODELS: ModelOption[] = [
  { value: 'sonnet', name: 'Sonnet', description: '', resolved: 'claude-sonnet-5', efforts: ['low', 'high'] },
  { value: 'opus', name: 'Opus', description: '', resolved: 'claude-opus-5', efforts: ['low', 'high', 'max'] },
  { value: 'haiku', name: 'Haiku', description: '', resolved: 'claude-haiku-5' },
];

function setup(backend: AgentBackend) {
  const hub = new EventHub();
  const events: ServerEvent[] = [];
  hub.attach({ send: (d) => { const e = JSON.parse(d) as ServerEvent; if (e.kind !== 'replay') events.push(e); } });
  return { events, make: (cwd = '/proj') => createSessionManager({ hub, backend, cwd }) };
}

async function until(cond: () => boolean, ms = 2000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 5));
  }
}

const modelEvents = (events: ServerEvent[]) => events.filter((e) => e.kind === 'model');
const pref = () => readPrefs().models[prefsKey('/proj')];

describe('model and effort', () => {
  it('the agent starts with the pref model and effort; its list reaches the clients and the manager', async () => {
    setModelPref('/proj', { model: 'opus', effort: 'high' });
    const b = fakeBackend([{ text: 'x' }], { models: MODELS });
    const { events, make } = setup(b);
    const s = await make();
    expect(b.starts[0]).toMatchObject({ model: 'opus', effort: 'high' });
    await until(() => events.some((e) => e.kind === 'models'));
    expect(s.models()).toEqual(MODELS);
    expect(s.model()).toEqual({ model: 'opus', effort: 'high' });
    s.close();
  });

  it('a pref model the agent does not offer: the agent is put back on its default, the pref stays; a later start omits it', async () => {
    setModelPref('/proj', { model: 'retired' });
    const b = fakeBackend([{ text: 'x', crash: true }, { text: 'y' }], { models: MODELS });
    const { events, make } = setup(b);
    const s = await make();
    await until(() => b.setModels.length === 1);
    expect(b.setModels).toEqual([null]);
    expect(s.model()).toEqual({ model: null });
    expect(pref()).toEqual({ model: 'retired' });
    s.send({ id: 'u1', text: 'hi' });
    await until(() => events.some((e) => e.kind === 'agent' && e.e.t === 'turn-end')); // the crash killed the agent
    s.send({ id: 'u2', text: 'again' });
    expect(b.starts.map((x) => x.model)).toEqual(['retired', undefined]);
    s.close();
  });

  it('setModel: setModel and the effort go to the agent, the pref is written, one event carries the ack, even while busy', async () => {
    const b = fakeBackend([{ text: 'a slow reply for a while', chunk: 2, delayMs: 20 }], { models: MODELS });
    const { events, make } = setup(b);
    const s = await make();
    await until(() => s.models().length > 0);
    s.send({ id: 'u1', text: 'hi' });
    await until(() => s.busy());
    const before = modelEvents(events).length;
    await s.setModel({ model: 'opus', effort: 'max' }, 'a1');
    expect(s.busy()).toBe(true); // the running turn is not interrupted
    expect(b.setModels).toEqual(['opus']);
    expect(b.setEfforts).toEqual(['max']);
    expect(pref()).toEqual({ model: 'opus', effort: 'max' });
    expect(modelEvents(events).slice(before)).toEqual([{ kind: 'model', model: 'opus', effort: 'max', ack: 'a1' }]);
    // the next turn's init reports the resolved id: no change, so no event and the pref stays
    await until(() => !s.busy());
    s.send({ id: 'u2', text: 'again' });
    await until(() => !s.busy() && events.filter((e) => e.kind === 'agent' && e.e.t === 'turn-end').length === 2);
    expect(modelEvents(events).slice(before)).toHaveLength(1);
    expect(s.model()).toEqual({ model: 'opus', effort: 'max' });
    expect(pref()).toEqual({ model: 'opus', effort: 'max' });
    s.close();
  });

  it('the first init shows the CLI default without writing a pref', async () => {
    const b = fakeBackend([{ text: 'x' }], { models: MODELS });
    const { events, make } = setup(b);
    const s = await make();
    await until(() => s.models().length > 0);
    s.send({ id: 'u1', text: 'hi' });
    await until(() => modelEvents(events).some((e) => (e as { model: string | null }).model === 'claude-sonnet-5'));
    expect(pref()).toBeUndefined();
    s.close();
  });

  it('a model the list does not offer is reported and answered with the model as it stands', async () => {
    const b = fakeBackend([{ text: 'x' }], { models: MODELS });
    const { events, make } = setup(b);
    const s = await make();
    await until(() => s.models().length > 0);
    await s.setModel({ model: 'gpt' }, 'a2');
    expect(b.setModels).toEqual([]);
    expect(events).toContainEqual({ kind: 'server-error', where: 'model', message: 'model gpt is not offered' });
    expect(modelEvents(events).at(-1)).toEqual({ kind: 'model', model: null, ack: 'a2' });
    expect(pref()).toBeUndefined();
    s.close();
  });

  it('mid-switch it is not applied: the answer says the model as it stands', async () => {
    const b = fakeBackend([{ text: 'x' }], { models: MODELS });
    const { events, make } = setup(b);
    const proj = path.join(home, 'proj');
    fs.mkdirSync(proj);
    const s = await make(proj);
    await until(() => s.models().length > 0);
    const sw = s.restart();
    expect(s.switching()).toBe(true);
    await s.setModel({ model: 'haiku' }, 'a3');
    expect(b.setModels).toEqual([]);
    expect(readPrefs().models).toEqual({});
    expect(modelEvents(events).at(-1)).toEqual({ kind: 'model', model: null, ack: 'a3' });
    await sw;
    s.close();
  });
});
