import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { EffortLevel, ModelOption } from '@nota-bene/shared';
import type { EmitInput } from '../hub.ts';
import { prefsKey, readPrefs, setModelPref } from '../prefs.ts';
import { ModelKeeper } from './model.ts';

let home: string;
const prevHome = process.env.NOTA_BENE_HOME;
beforeEach(() => {
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nb-model-')));
  process.env.NOTA_BENE_HOME = home;
});
afterEach(() => {
  if (prevHome === undefined) delete process.env.NOTA_BENE_HOME; else process.env.NOTA_BENE_HOME = prevHome;
  fs.rmSync(home, { recursive: true, force: true });
});

const LIST: ModelOption[] = [
  { value: 'sonnet', name: 'Sonnet', description: '', resolved: 'claude-sonnet-5', efforts: ['low', 'medium', 'high'] },
  { value: 'opus', name: 'Opus', description: '', resolved: 'claude-opus-5', efforts: ['low', 'high', 'max'] },
  { value: 'haiku', name: 'Haiku', description: '', resolved: 'claude-haiku-5' },
];

function agent(list: ModelOption[] = LIST) {
  const calls: string[] = [];
  return {
    calls,
    supportedModels: async () => list,
    setModel: async (m: string | null) => void calls.push(`model:${m}`),
    setEffort: async (e: EffortLevel | null) => void calls.push(`effort:${e}`),
  };
}

function make() {
  const events: EmitInput[] = [];
  const k = new ModelKeeper({ dir: '/p', emit: (ev) => events.push(ev), report: () => {} });
  return { k, events };
}
const yes = () => true;
const pref = () => readPrefs().models[prefsKey('/p')];

describe('ModelKeeper', () => {
  it('no pref: the agent starts without a model option', () => {
    const { k } = make();
    expect(k.forStart('/p')).toEqual({});
    expect(k.current).toEqual({ model: null });
  });

  it('starts with the pref model and effort', () => {
    setModelPref('/p', { model: 'opus', effort: 'high' });
    const { k } = make();
    expect(k.forStart('/p')).toEqual({ model: 'opus', effort: 'high' });
    expect(k.current).toEqual({ model: 'opus', effort: 'high' });
  });

  it('a pref model the list does not offer: no model option at start, the pref stays', async () => {
    setModelPref('/p', { model: 'retired', effort: 'high' });
    const { k } = make();
    await k.load(agent(), yes);
    expect(k.forStart('/p')).toEqual({});
    expect(k.current).toEqual({ model: null });
    expect(pref()).toEqual({ model: 'retired', effort: 'high' });
  });

  it('an effort the pref model does not have is not passed at start', async () => {
    setModelPref('/p', { model: 'haiku', effort: 'high' });
    const { k } = make();
    await k.load(agent(), yes);
    expect(k.forStart('/p')).toEqual({ model: 'haiku' });
  });

  it('load: a model the agent started with but does not offer goes back to its default; the pref stays', async () => {
    setModelPref('/p', { model: 'retired' });
    const { k, events } = make();
    const a = agent();
    await k.load(a, yes);
    expect(a.calls).toEqual(['model:null']);
    expect(events).toEqual([{ kind: 'models', models: LIST }, { kind: 'model', model: null }]);
    expect(pref()).toEqual({ model: 'retired' });
  });

  it('load: announces the list; a stale agent (a switch meanwhile) changes nothing', async () => {
    const { k, events } = make();
    await k.load(agent(), () => false);
    expect(events).toEqual([]);
    expect(k.models).toEqual([]);
  });

  it('adopt: the CLI default is shown but is no choice: no pref', () => {
    const { k, events } = make();
    k.adopt('claude-sonnet-5', '/p');
    k.adopt('claude-sonnet-5', '/p');
    expect(k.current).toEqual({ model: 'claude-sonnet-5' });
    expect(pref()).toBeUndefined();
    expect(events).toEqual([{ kind: 'model', model: 'claude-sonnet-5' }]);
  });

  it('adopt: the resolved id of the alias we asked for is no change', async () => {
    setModelPref('/p', { model: 'opus', effort: 'high' });
    const { k, events } = make();
    k.forStart('/p');
    await k.load(agent(), yes);
    events.length = 0;
    k.adopt('claude-opus-5', '/p');
    expect(k.current).toEqual({ model: 'opus', effort: 'high' });
    expect(events).toEqual([]);
  });

  it('adopt: a model the CLI changes after it settled is shown and saved; its effort is unknown then', async () => {
    setModelPref('/p', { model: 'opus', effort: 'high' });
    const { k, events } = make();
    k.forStart('/p');
    await k.load(agent(), yes);
    k.adopt('claude-opus-5', '/p');
    events.length = 0;
    k.adopt('claude-haiku-5', '/p');
    expect(k.current).toEqual({ model: 'claude-haiku-5' });
    expect(pref()).toEqual({ model: 'claude-haiku-5' });
    expect(events).toEqual([{ kind: 'model', model: 'claude-haiku-5' }]);
  });

  it('adopt: a first report that differs from an unoffered pref keeps the pref', () => {
    setModelPref('/p', { model: 'retired' });
    const { k } = make();
    k.forStart('/p');
    k.adopt('claude-sonnet-5', '/p');
    expect(pref()).toEqual({ model: 'retired' });
  });

  it('change: a model switch calls setModel, saves the pref; ack answers with the current choice', async () => {
    const { k, events } = make();
    await k.load(agent(), yes);
    events.length = 0;
    const a = agent();
    await k.change(a, { model: 'opus', effort: 'max' }, '/p', yes);
    expect(a.calls).toEqual(['model:opus', 'effort:max']);
    expect(pref()).toEqual({ model: 'opus', effort: 'max' });
    expect(events).toEqual([]);
    k.ack('a1');
    k.ack();
    expect(events).toEqual([{ kind: 'model', model: 'opus', effort: 'max', ack: 'a1' }, { kind: 'model', model: 'opus', effort: 'max' }]);
  });

  it('change: an effort alone leaves the model alone (applyFlagSettings only)', async () => {
    setModelPref('/p', { model: 'opus', effort: 'low' });
    const { k } = make();
    await k.load(agent(), yes);
    const a = agent();
    await k.change(a, { model: 'opus', effort: 'high' }, '/p', yes);
    expect(a.calls).toEqual(['effort:high']);
    expect(pref()).toEqual({ model: 'opus', effort: 'high' });
  });

  it('change: to a model without efforts clears the effort; the same model and effort calls nothing', async () => {
    setModelPref('/p', { model: 'opus', effort: 'low' });
    const { k } = make();
    await k.load(agent(), yes);
    const a = agent();
    await k.change(a, { model: 'haiku' }, '/p', yes);
    expect(a.calls).toEqual(['model:haiku', 'effort:null']);
    expect(pref()).toEqual({ model: 'haiku' });
    a.calls.length = 0;
    await k.change(a, { model: 'haiku' }, '/p', yes);
    expect(a.calls).toEqual([]);
  });

  it('change: a refusal by the agent leaves the choice and the pref as they were', async () => {
    setModelPref('/p', { model: 'sonnet' });
    const { k } = make();
    await k.load(agent(), yes);
    const a = { ...agent(), setModel: async () => { throw new Error('nope'); } };
    await expect(k.change(a, { model: 'opus' }, '/p', yes)).rejects.toThrow('nope');
    expect(k.current).toEqual({ model: 'sonnet' });
    expect(pref()).toEqual({ model: 'sonnet' });
  });

  it('change: a model or effort the list does not offer is refused before the agent is touched', async () => {
    const { k } = make();
    await k.load(agent(), yes);
    const a = agent();
    await expect(k.change(a, { model: 'gpt' }, '/p', yes)).rejects.toThrow('not offered');
    await expect(k.change(a, { model: 'haiku', effort: 'low' }, '/p', yes)).rejects.toThrow('no effort');
    expect(a.calls).toEqual([]);
    expect(pref()).toBeUndefined();
  });

  it('change: with no agent only the pref is written; a stale session writes nothing', async () => {
    const { k } = make();
    await k.load(agent(), yes);
    await k.change(null, { model: 'haiku' }, '/p', yes);
    expect(pref()).toEqual({ model: 'haiku' });
    await k.change(agent(), { model: 'opus' }, '/p', () => false);
    expect(pref()).toEqual({ model: 'haiku' });
  });

  it('enter: a switch takes the new dir\'s start choice without announcing it', async () => {
    const { k, events } = make();
    await k.load(agent(), yes);
    setModelPref('/q', { model: 'opus', effort: 'low' });
    events.length = 0;
    k.enter('/q');
    expect(k.current).toEqual({ model: 'opus', effort: 'low' });
    expect(events).toEqual([]);
  });
});
