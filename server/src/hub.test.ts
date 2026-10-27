import { describe, it, expect, vi, afterEach } from 'vitest';
import type { ServerEvent } from '@nota-bene/shared';
import { EventHub } from './hub.ts';
import { guard } from './errors.ts';

const user = (id: string): Extract<ServerEvent, { kind: 'user' }> => ({ kind: 'user', id, text: id, ts: 1 });

function sock() {
  const frames: string[] = [];
  return { frames, send: (d: string) => void frames.push(d) };
}

afterEach(() => vi.restoreAllMocks());

describe('EventHub', () => {
  it('late subscriber gets a replay of stored events', () => {
    const hub = new EventHub();
    hub.emit(user('a'));
    hub.emit(user('b'));
    const s = sock();
    hub.attach(s);
    expect(s.frames).toHaveLength(1);
    expect(JSON.parse(s.frames[0]!)).toEqual({ kind: 'replay', events: [user('a'), user('b')] });
    hub.emit(user('c'));
    expect(JSON.parse(s.frames[1]!)).toEqual(user('c'));
  });

  it('clients() counts attached sockets and drops a detached one', () => {
    const hub = new EventHub();
    expect(hub.clients()).toBe(0);
    const off = hub.attach(sock());
    hub.attach(sock());
    expect(hub.clients()).toBe(2);
    off();
    expect(hub.clients()).toBe(1);
  });

  it('store:false events reach live sockets but not the replay', () => {
    const hub = new EventHub();
    const live = sock();
    hub.attach(live);
    hub.emit({ kind: 'server-error', where: 'x', message: 'boom' }, { store: false });
    expect(JSON.parse(live.frames[1]!).kind).toBe('server-error');
    const late = sock();
    hub.attach(late);
    expect(JSON.parse(late.frames[0]!)).toEqual({ kind: 'replay', events: [] });
  });

  it('reset replaces history', () => {
    const hub = new EventHub();
    hub.emit(user('a'));
    hub.reset([user('z')]);
    const s = sock();
    hub.attach(s);
    expect(JSON.parse(s.frames[0]!).events).toEqual([user('z')]);
  });

  it('reset sends every connected socket the new replay, so its feed empties', () => {
    const hub = new EventHub();
    const a = sock();
    const b = sock();
    hub.attach(a);
    hub.attach(b);
    hub.emit(user('old'));
    hub.reset();
    hub.reset([user('h')]);
    for (const s of [a, b]) {
      expect(s.frames.slice(2).map((f) => JSON.parse(f))).toEqual([{ kind: 'replay', events: [] }, { kind: 'replay', events: [user('h')] }]);
    }
    hub.emit(user('live'));
    expect(JSON.parse(a.frames.at(-1)!)).toEqual(user('live'));
  });

  it('stamps ts only when absent and only on kinds that have it', () => {
    const hub = new EventHub();
    const s = sock();
    hub.attach(s);
    hub.emit({ kind: 'user', id: 'a', text: 'a' });
    hub.emit({ kind: 'session', id: null, root: '/r', title: null, model: null });
    expect(typeof JSON.parse(s.frames[1]!).ts).toBe('number');
    expect(JSON.parse(s.frames[2]!)).not.toHaveProperty('ts');
  });

  it('a throwing socket is dropped and does not break others', () => {
    const hub = new EventHub();
    let n = 0;
    const bad = { send: vi.fn(() => { if (++n > 1) throw new Error('closed'); }) };
    const good = sock();
    hub.attach(bad);
    hub.attach(good);
    hub.emit(user('a'));
    hub.emit(user('b'));
    expect(good.frames).toHaveLength(3);
    expect(bad.send).toHaveBeenCalledTimes(2); // replay + first emit, then dropped
  });

  it('detach stops delivery', () => {
    const hub = new EventHub();
    const s = sock();
    const off = hub.attach(s);
    off();
    hub.emit(user('a'));
    expect(s.frames).toHaveLength(1);
  });
});

describe('EventHub.cut (R-M7-1, R-M7-2)', () => {
  type Stored = Exclude<ServerEvent, { kind: 'replay' }>;
  const agent = (e: Extract<ServerEvent, { kind: 'agent' }>['e']): Stored => ({ kind: 'agent', e, ts: 1 });
  const boundary = agent({ t: 'compacted', preTokens: 100 });
  const session: Stored = { kind: 'session', id: 's1', root: '/r', title: null, model: null };
  const replayOf = (hub: EventHub) => { const s = sock(); hub.attach(s); return JSON.parse(s.frames[0]!) as { events: ServerEvent[]; earlier?: number }; };

  it('cut keeps the boundary and later frames', () => {
    const hub = new EventHub();
    for (const ev of [user('a'), agent({ t: 'message', id: 'm1', text: 'x' }), user('/compact'), boundary, agent({ t: 'message', id: 'm2', text: 'y' })]) hub.emit(ev);
    const archived: ServerEvent[][] = [];
    const cut = hub.cut({ archive: (evs) => { archived.push(evs); return 1; } });
    expect(cut).toEqual([user('a'), agent({ t: 'message', id: 'm1', text: 'x' }), user('/compact')]); // the /compact goes too
    expect(archived).toEqual([cut]);
    const r = replayOf(hub);
    expect(r.events).toEqual([boundary, agent({ t: 'message', id: 'm2', text: 'y' })]);
    expect(r.earlier).toBe(1);
  });

  it('cut archives everything before the boundary, and also keeps what a replay still needs: the last session event, an open ask, a running task, and what `keep` says', () => {
    const hub = new EventHub();
    const ask = (id: string): Stored => ({ kind: 'permission', id, toolName: 'Bash', input: {}, ts: 1 });
    const done = (id: string): Stored => ({ kind: 'permission-done', id, allow: true, ts: 1 });
    const task = (id: string, phase: 'started' | 'progress' | 'done'): Stored => agent({ t: 'task', id, phase });
    const before = [{ ...session, title: 'old' }, user('a'), ask('p1'), done('p1'), task('t1', 'started'), task('t2', 'started'),
      ask('p2'), task('t1', 'progress'), task('t2', 'done'), session, user('b')];
    for (const ev of [...before, boundary]) hub.emit(ev);
    const archived: ServerEvent[][] = [];
    const cut = hub.cut({ keep: (ev) => ev.kind === 'user' && ev.id === 'b', archive: (evs) => { archived.push(evs); return 1; } });
    expect(cut).toEqual(before); // segments are whole: the kept items are in it too (R-M7-12 ruling)
    expect(archived).toEqual([before]);
    expect(replayOf(hub).events).toEqual([task('t1', 'started'), ask('p2'), task('t1', 'progress'), session, user('b'), boundary]);
  });

  it('segments never overlap: a kept item is archived once, and dropped from the hub once nothing needs it', () => {
    const hub = new EventHub();
    const archived: ServerEvent[][] = [];
    const archive = (evs: ServerEvent[]) => { archived.push(evs); return archived.length; };
    let waiting = true;
    const keep = (ev: ServerEvent) => waiting && ev.kind === 'user' && ev.id === 'u1';
    const b2 = agent({ t: 'compacted', preTokens: 200 });
    const b3 = agent({ t: 'compacted', preTokens: 300 });
    for (const ev of [user('u1'), user('x'), boundary, user('y')]) hub.emit(ev);
    hub.cut({ keep, archive });
    hub.emit(b2);
    hub.cut({ keep, archive });
    expect(archived).toEqual([[user('u1'), user('x')], [boundary, user('y')]]);
    expect(replayOf(hub).events).toEqual([user('u1'), b2]);
    waiting = false; // its turn ended: the next cut drops it from the hub and writes nothing of it again
    hub.emit(b3);
    hub.cut({ keep, archive });
    expect(archived[2]).toEqual([b2]);
    expect(replayOf(hub).events).toEqual([b3]);
  });

  it('a failing archive leaves the history as it was', () => {
    const hub = new EventHub();
    hub.emit(user('a'));
    hub.emit(boundary);
    expect(() => hub.cut({ archive: () => { throw new Error('ENOSPC'); } })).toThrow('ENOSPC');
    expect(replayOf(hub)).toEqual({ kind: 'replay', events: [user('a'), boundary] });
  });

  it('no boundary, or nothing before it: nothing is cut or archived', () => {
    const hub = new EventHub();
    let calls = 0;
    hub.emit(user('a'));
    expect(hub.cut({ archive: () => ++calls })).toEqual([]);
    hub.reset([boundary]);
    expect(hub.cut({ archive: () => ++calls })).toEqual([]);
    expect(calls).toBe(0);
  });

  it('reset carries `earlier` into every replay while it is > 0; a plain reset drops it', () => {
    const hub = new EventHub();
    const live = sock();
    hub.attach(live);
    hub.reset([boundary], { earlier: 2 });
    expect(JSON.parse(live.frames[1]!)).toEqual({ kind: 'replay', events: [boundary], earlier: 2 });
    expect(replayOf(hub).earlier).toBe(2);
    hub.reset([], { earlier: 0 });
    expect(replayOf(hub)).toEqual({ kind: 'replay', events: [] });
    hub.reset([boundary], { earlier: 3 });
    hub.reset();
    expect(replayOf(hub)).toEqual({ kind: 'replay', events: [] });
  });
});

describe('guard', () => {
  it('guard reports instead of throwing', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const hub = new EventHub();
    const s = sock();
    hub.attach(s);
    const g = guard(hub, 'where', (_n: number) => { throw new Error('bad'); });
    expect(() => g(1)).not.toThrow();
    expect(JSON.parse(s.frames[1]!)).toEqual({ kind: 'server-error', where: 'where', message: 'bad' });
  });
});
