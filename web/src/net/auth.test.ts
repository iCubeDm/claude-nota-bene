import { describe, expect, it, vi } from 'vitest';
import { afterEach } from 'vitest';
import { KEY_STORAGE, apiFetch, getKey, loginFromFragment, refusedForAuth, socketProtocols } from './auth.ts';

afterEach(() => localStorage.clear());

const TOKEN = 'ab'.repeat(32);
const loc = (hash: string) => ({ hash, pathname: '/some', search: '?x=1' }) as Location;

describe('loginFromFragment', () => {
  it('posts the token to /auth, and takes it out of the address bar before the answer arrives', async () => {
    const replace = vi.fn();
    let pending!: (r: Response) => void;
    const fetchFn = vi.fn(() => new Promise<Response>((r) => { pending = r; }));
    const done = loginFromFragment(loc(`#t=${TOKEN}`), { replaceState: replace } as unknown as History, fetchFn as unknown as typeof fetch);
    expect(replace).toHaveBeenCalledWith(null, '', '/some?x=1'); // gone from the bar and the history entry at once
    expect(fetchFn).toHaveBeenCalledWith('/auth', expect.objectContaining({ method: 'POST', body: JSON.stringify({ token: TOKEN }) }));
    pending(new Response(JSON.stringify({ ok: true, key: 'k'.repeat(64) }), { status: 200 }));
    expect(await done).toBe(true);
    expect(getKey()).toBe('k'.repeat(64)); // kept for the writes and the socket
  });

  it('a refused token is false; a network error is false and does not throw', async () => {
    const h = { replaceState() {} } as unknown as History;
    expect(await loginFromFragment(loc(`#t=${TOKEN}`), h, (async () => new Response('no', { status: 401 })) as typeof fetch)).toBe(false);
    expect(await loginFromFragment(loc(`#t=${TOKEN}`), h, (async () => { throw new TypeError('offline'); }) as typeof fetch)).toBe(false);
  });

  it('no fragment, or another fragment: nothing is sent and the address is left alone', async () => {
    const replace = vi.fn();
    const fetchFn = vi.fn();
    for (const hash of ['', '#', '#section', '#t=', '#t=zz', `#x=1&t=${TOKEN}`]) {
      expect(await loginFromFragment(loc(hash), { replaceState: replace } as unknown as History, fetchFn as unknown as typeof fetch)).toBe(false);
    }
    expect(fetchFn).not.toHaveBeenCalled();
    expect(replace).not.toHaveBeenCalled();
  });
});

describe('refusedForAuth', () => {
  it('is true only for a 401 from /info', async () => {
    expect(await refusedForAuth((async () => new Response('', { status: 401 })) as typeof fetch)).toBe(true);
    expect(await refusedForAuth((async () => new Response('{}', { status: 200 })) as typeof fetch)).toBe(false);
    expect(await refusedForAuth((async () => new Response('', { status: 502 })) as typeof fetch)).toBe(false);
    expect(await refusedForAuth((async () => { throw new TypeError('server is down'); }) as typeof fetch)).toBe(false);
  });
});

describe('refusedForAuth and the key', () => {
  const info = (body: unknown, status = 200) => (async () => new Response(JSON.stringify(body), { status })) as typeof fetch;
  it('a logged-in page that lost its key (cleared storage) is refused too, while a keyless older server is not', async () => {
    expect(await refusedForAuth(info({ keyRequired: true }))).toBe(true);
    expect(await refusedForAuth(info({}))).toBe(false); // an older server has no keys
    localStorage.setItem(KEY_STORAGE, 'k'.repeat(64));
    expect(await refusedForAuth(info({ keyRequired: true }))).toBe(false);
  });
});

describe('apiFetch', () => {
  it('adds the key header to a request, keeps the rest, and sends nothing extra without a key', async () => {
    const calls: [unknown, RequestInit][] = [];
    const f = (async (i: unknown, init: RequestInit) => { calls.push([i, init]); return new Response(''); }) as unknown as typeof fetch;
    await apiFetch('/x', { method: 'POST', headers: { 'content-type': 'a/b' }, body: 'b' }, f);
    expect(calls[0]![1].headers).toEqual({ 'content-type': 'a/b' }); // no key stored: untouched
    localStorage.setItem(KEY_STORAGE, 'k'.repeat(64));
    await apiFetch('/x', { method: 'POST', headers: { 'content-type': 'a/b' }, body: 'b' }, f);
    const h = new Headers(calls[1]![1].headers);
    expect([h.get('content-type'), h.get('x-nota-bene-key'), calls[1]![1].method, calls[1]![1].body]).toEqual(['a/b', 'k'.repeat(64), 'POST', 'b']);
  });
  it('the socket carries the key as a subprotocol, only when there is one', () => {
    expect(socketProtocols()).toEqual([]);
    localStorage.setItem(KEY_STORAGE, 'k'.repeat(64));
    expect(socketProtocols()).toEqual([`nb.${'k'.repeat(64)}`]);
  });
});
