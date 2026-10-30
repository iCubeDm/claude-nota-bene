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

  it('a function url is evaluated at each open: a retry can differ from the first connect', () => {
    let n = 0;
    connect(() => `ws://x/ws?n=${n++}`, () => {}, () => {}, WS);
    expect(FakeWS.instances[0].url).toBe('ws://x/ws?n=0');
    FakeWS.instances[0].drop();
    vi.advanceTimersByTime(1000);
    expect(FakeWS.instances[1].url).toBe('ws://x/ws?n=1');
  });

  it('a page put into the back/forward cache closes its socket (the next page must not wait out the owner), and reopens when restored', () => {
    // other tests' connections stay open and hear the same window events: count only this one's sockets
    const mine = () => FakeWS.instances.filter((w) => w.url === 'ws://bf/ws');
    const c = connect('ws://bf/ws', () => {}, () => {}, WS);
    mine()[0].open();
    replay(mine()[0]);
    dispatchEvent(Object.assign(new Event('pagehide'), { persisted: true }));
    expect(mine()[0].readyState).toBe(3);
    vi.advanceTimersByTime(5000);
    expect(mine()).toHaveLength(1); // no retry from inside the cache
    dispatchEvent(Object.assign(new Event('pageshow'), { persisted: true }));
    expect(mine()).toHaveLength(2);
    c.close();
    dispatchEvent(Object.assign(new Event('pagehide'), { persisted: true }));
    dispatchEvent(Object.assign(new Event('pageshow'), { persisted: true }));
    expect(mine()).toHaveLength(2); // closed for good: the listeners are gone
  });
});

describe('a refused socket (no login)', () => {
  const settle = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };

  it('a socket that never got a frame is checked; refused for auth stops the retries and says so once', async () => {
    const states: string[] = [];
    const probe = vi.fn(async () => true);
    connect('ws://x/ws', () => {}, (s) => states.push(s), WS, probe);
    FakeWS.instances[0].drop(); // the handshake was refused: closed, never a frame
    await settle();
    expect(probe).toHaveBeenCalledTimes(1);
    expect(states).toEqual(['unauthorized']);
    vi.advanceTimersByTime(10_000);
    expect(FakeWS.instances).toHaveLength(1); // no endless reconnect
  });

  it('a socket down for another reason (server restarting) reconnects as before', async () => {
    const states: string[] = [];
    const probe = vi.fn(async () => false);
    connect('ws://x/ws', () => {}, (s) => states.push(s), WS, probe);
    FakeWS.instances[0].drop();
    await settle();
    expect(states).toEqual([]);
    vi.advanceTimersByTime(1100);
    expect(FakeWS.instances).toHaveLength(2);
  });

  it('a socket that was attached and then dropped is not probed as a refusal', async () => {
    const probe = vi.fn(async () => true);
    const states: string[] = [];
    connect('ws://x/ws', () => {}, (s) => states.push(s), WS, probe);
    FakeWS.instances[0].open();
    replay(FakeWS.instances[0]);
    FakeWS.instances[0].drop();
    await settle();
    // a restart looks the same from here; the next attempt that gets no frame is the one that is checked
    expect(states).toEqual(['open', 'closed']);
    vi.advanceTimersByTime(1100);
    FakeWS.instances[1].drop();
    await settle();
    expect(probe).toHaveBeenCalledTimes(1);
    expect(states.at(-1)).toBe('unauthorized');
  });

  it('close() while the check is out stops everything', async () => {
    const probe = vi.fn(async () => false);
    const c = connect('ws://x/ws', () => {}, () => {}, WS, probe);
    FakeWS.instances[0].drop();
    c.close();
    await settle();
    vi.advanceTimersByTime(5000);
    expect(FakeWS.instances).toHaveLength(1);
  });
});
