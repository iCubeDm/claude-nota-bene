import { describe, expect, it, vi } from 'vitest';
import { loginFromFragment, refusedForAuth } from './auth.ts';

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
    pending(new Response('{}', { status: 200 }));
    expect(await done).toBe(true);
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
