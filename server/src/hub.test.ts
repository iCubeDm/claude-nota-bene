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
