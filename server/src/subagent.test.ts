import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SubagentView } from '@nota-bene/shared';
import { fakeBackend, type FakeSubagent } from './agent/fake.ts';
import { startServer } from './server.ts';

let home: string;
let dist: string;
const prevHome = process.env.NOTA_BENE_HOME;
const closers: (() => Promise<void>)[] = [];

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'nb-sub-home-'));
  dist = fs.mkdtempSync(path.join(os.tmpdir(), 'nb-sub-dist-'));
  fs.writeFileSync(path.join(dist, 'index.html'), '<h1>x</h1>');
  process.env.NOTA_BENE_HOME = home;
});
afterEach(async () => {
  while (closers.length) await closers.pop()!();
  if (prevHome === undefined) delete process.env.NOTA_BENE_HOME; else process.env.NOTA_BENE_HOME = prevHome;
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(dist, { recursive: true, force: true });
});

const subagents: FakeSubagent[] = [
  {
    toolUseId: 'toolu_done', type: 'general-purpose', description: 'Re-review batch send',
    messages: [
      { role: 'user', text: 'Review the diff' },
      { role: 'assistant', text: 'Reading.', tools: [{ id: 'toolu_inner', name: 'Read', input: { file_path: 'a.md' }, output: 'hello' }] },
      { role: 'assistant', text: 'All good.' },
    ],
  },
  { toolUseId: 'toolu_run', type: 'Explore', description: 'Look around', running: true, messages: [{ role: 'user', text: 'Explore' }, { role: 'assistant', text: 'Working on it' }] },
];

async function boot() {
  const s = await startServer({ insecureNoAuth: true, cwd: '/proj', port: 0, backend: fakeBackend([{ text: 'hello' }], { subagents }), webDist: dist, oneTab: false, resume: 'fake-session' });
  closers.push(s.close);
  return s;
}
const get = (s: { url: string }, q: string) => fetch(`${s.url}/subagent?${q}`);

describe('GET /subagent', () => {
  it('200: the subagent\'s own text, tool call and result as feed events, with type, description and running', async () => {
    const s = await boot();
    const r = await get(s, 'session=fake-session&tool=toolu_done');
    expect(r.status).toBe(200);
    const v = await r.json() as SubagentView;
    expect(v).toMatchObject({ running: false, type: 'general-purpose', description: 'Re-review batch send' });
    expect(v.events.map((e) => (e.kind === 'user' ? 'user' : e.kind === 'agent' ? e.e.t : e.kind))).toEqual(['user', 'message', 'tool-call', 'tool-update', 'message']);
    expect(v.events.find((e) => e.kind === 'agent' && e.e.t === 'tool-call')).toMatchObject({ e: { id: 'toolu_inner', name: 'Read', sub: false } });
  });

  it('running comes from the agent', async () => {
    const s = await boot();
    expect(await (await get(s, 'session=fake-session&tool=toolu_run')).json()).toMatchObject({ running: true, type: 'Explore' });
  });

  it('404 when no subagent matches the tool id', async () => {
    const s = await boot();
    expect((await get(s, 'session=fake-session&tool=toolu_nope')).status).toBe(404);
  });

  it('409 for a session that is not the current conversation, and no content leaks', async () => {
    const s = await boot();
    const r = await get(s, 'session=other-session&tool=toolu_done');
    expect(r.status).toBe(409);
    expect(await r.text()).not.toContain('Review');
  });

  it('400 for ids that are not plain ids (no path pieces), a missing one, and 405 for a POST', async () => {
    const s = await boot();
    for (const q of ['session=..%2Fx&tool=toolu_done', 'session=fake-session&tool=..%2F..%2Fetc', 'session=fake-session&tool=a%2Fb', 'session=fake-session', 'tool=toolu_done', 'session=fake-session&tool=']) {
      expect((await get(s, q)).status, q).toBe(400);
    }
    expect((await fetch(`${s.url}/subagent?session=fake-session&tool=toolu_done`, { method: 'POST', headers: { origin: s.url } })).status).toBe(405);
  });
});
