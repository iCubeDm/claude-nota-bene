import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { connect, defaultSocketUrl } from './socket.ts';

class FakeWS {
  static instances: FakeWS[] = [];
  static OPEN = 1;
  readyState = 0;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onclose: ((e: { code: number }) => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  url: string;
  constructor(url: string) {
    this.url = url;
    FakeWS.instances.push(this);
  }
  send(d: string) {
    this.sent.push(d);
  }
  close() {
    this.readyState = 3;
    this.onclose?.({ code: 1000 });
  }
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
  drop(code = 1006) {
    this.readyState = 3;
    this.onclose?.({ code });
  }
}
const replay = (ws: FakeWS) => ws.onmessage?.({ data: '{"kind":"replay","events":[]}' });
const WS = FakeWS as unknown as typeof WebSocket;

beforeEach(() => {
  FakeWS.instances = [];
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('connect', () => {
  it('send returns false while closed and true after open', () => {
    const c = connect('ws://x/ws', () => {}, () => {}, WS);
    expect(c.send({ type: 'interrupt' } as never)).toBe(false);
    FakeWS.instances[0].open();
    replay(FakeWS.instances[0]);
    expect(c.send({ type: 'interrupt' } as never)).toBe(true);
    expect(FakeWS.instances[0].sent).toEqual([JSON.stringify({ type: 'interrupt' })]);
  });

  it('reconnects after close within 1.1s and reports state once per close', () => {
    const states: string[] = [];
    connect('ws://x/ws', () => {}, (s) => states.push(s), WS);
    FakeWS.instances[0].open();
    expect(states).toEqual([]); // a socket is not attached until the replay
    replay(FakeWS.instances[0]);
    FakeWS.instances[0].drop();
    expect(states).toEqual(['open', 'closed']);
    vi.advanceTimersByTime(1100);
    expect(FakeWS.instances).toHaveLength(2);
    FakeWS.instances[1].drop(); // failed attempt, never opened
    expect(states).toEqual(['open', 'closed']);
    vi.advanceTimersByTime(1100);
    expect(FakeWS.instances).toHaveLength(3);
  });

  it('close() stops reconnecting', () => {
    const c = connect('ws://x/ws', () => {}, () => {}, WS);
    FakeWS.instances[0].open();
    FakeWS.instances[0].drop();
    c.close();
    vi.advanceTimersByTime(5000);
    expect(FakeWS.instances).toHaveLength(1);
    const c2 = connect('ws://x/ws', () => {}, () => {}, WS);
    FakeWS.instances[1].open();
    c2.close();
    vi.advanceTimersByTime(5000);
    expect(FakeWS.instances).toHaveLength(2);
  });

  it('does not reconnect after close code 4001, reports taken, and reconnect() opens a new socket', () => {
    const states: string[] = [];
    const c = connect('ws://x/ws', () => {}, (s) => states.push(s), WS);
    FakeWS.instances[0].open();
    replay(FakeWS.instances[0]);
    FakeWS.instances[0].drop(4001);
    expect(states).toEqual(['open', 'taken']);
    vi.advanceTimersByTime(10_000);
    expect(FakeWS.instances).toHaveLength(1);
    c.reconnect();
    expect(FakeWS.instances).toHaveLength(2);
    FakeWS.instances[1].open();
    replay(FakeWS.instances[1]);
    FakeWS.instances[1].drop(); // an ordinary drop reconnects again
    vi.advanceTimersByTime(1100);
    expect(FakeWS.instances).toHaveLength(3);
    expect(states).toEqual(['open', 'taken', 'open', 'closed']);
  });

  it('an unattached socket (no replay: the grace or occupied) sends nothing but takeover and reports no state', () => {
    const states: string[] = [];
    const c = connect('ws://x/ws', () => {}, (s) => states.push(s), WS);
    const ws = FakeWS.instances[0];
    ws.open();
    ws.onmessage?.({ data: '{"kind":"occupied"}' });
    ws.onmessage?.({ data: '{"kind":"hello","protocol":5}' });
    expect(c.send({ type: 'interrupt' })).toBe(false);
    expect(c.send({ type: 'takeover' })).toBe(true);
    expect(ws.sent).toEqual([JSON.stringify({ type: 'takeover' })]);
    expect(states).toEqual([]);
  });

  it('parses frames and ignores unparseable ones', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const got: unknown[] = [];
    connect('ws://x/ws', (e) => got.push(e), () => {}, WS);
    const ws = FakeWS.instances[0];
    ws.onmessage?.({ data: '{"type":"a"}' });
    expect(() => ws.onmessage?.({ data: 'not json' })).not.toThrow();
    expect(got).toEqual([{ type: 'a' }]);
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

describe('defaultSocketUrl', () => {
  it('picks wss on https and ws otherwise', () => {
    expect(defaultSocketUrl(new URL('https://h.example:8443/x'))).toBe('wss://h.example:8443/ws');
    expect(defaultSocketUrl(new URL('http://127.0.0.1:4777/'))).toBe('ws://127.0.0.1:4777/ws');
  });
});
