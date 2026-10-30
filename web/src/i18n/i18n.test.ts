import { afterEach, expect, it, vi } from 'vitest';
import { en } from './en.ts';
import { initialLang, setLang, t } from './index.ts';
import { ru } from './ru.ts';

afterEach(async () => { (await import('./index.ts')).resetUnsyncedLang(); setLang('ru'); });

it('ru and en have the same keys', () => {
  const r = Object.keys(ru);
  const e = Object.keys(en);
  expect(r.filter((k) => !(k in en))).toEqual([]);
  expect(e.filter((k) => !(k in ru))).toEqual([]);
});

it('t() formats function values in the current language', () => {
  setLang('ru');
  expect(t('sendN', 3)).toBe('Отправить (3)');
  setLang('en');
  expect(t('sendN', 3)).toBe('Send (3)');
  expect(document.documentElement.lang).toBe('en');
  expect(localStorage.getItem('lang')).toBe('en');
});

it('initialLang: the stored choice wins, otherwise English (the browser language is ignored)', () => {
  expect(initialLang(null)).toBe('en');
  expect(initialLang('ru')).toBe('ru');
  expect(initialLang('en')).toBe('en');
  expect(initialLang('de')).toBe('en');
});

it('adoptServerLang: the server value wins over the local cache; with none, a stored local choice is moved up', async () => {
  const { adoptServerLang, getLang } = await import('./index.ts');
  const posts: unknown[] = [];
  vi.stubGlobal('fetch', vi.fn(async (_u: string, init: RequestInit) => { posts.push(JSON.parse(String(init.body))); return new Response('{}'); }));
  try {
    localStorage.setItem('lang', 'en');
    setLang('en');
    adoptServerLang('ru'); // another window chose Russian: this port's cache is overruled
    expect(getLang()).toBe('ru');
    expect(localStorage.getItem('lang')).toBe('ru'); // and the cache follows
    expect(posts).toEqual([]);
    localStorage.setItem('lang', 'ru');
    adoptServerLang(undefined); // the server has none yet: this browser's old choice is saved for all windows
    expect(posts).toEqual([{ lang: 'ru', ifUnset: true }]);
    posts.length = 0;
    localStorage.removeItem('lang');
    adoptServerLang(undefined); // neither: nothing to say, English stays the default
    expect(posts).toEqual([]);
  } finally {
    vi.unstubAllGlobals();
  }
});

it('chooseLang sets the language here and posts it to the server', async () => {
  const { chooseLang, getLang } = await import('./index.ts');
  const posts: unknown[] = [];
  vi.stubGlobal('fetch', vi.fn(async (_u: string, init: RequestInit) => { posts.push(JSON.parse(String(init.body))); return new Response('{}'); }));
  try {
    chooseLang('en');
    expect(getLang()).toBe('en');
    expect(posts).toEqual([{ lang: 'en' }]);
  } finally {
    vi.unstubAllGlobals();
  }
});

it('a choice the server has not confirmed survives a hello: down server, hello built before the POST, then ok clears it', async () => {
  const { adoptServerLang, chooseLang, getLang } = await import('./index.ts');
  const calls: { body: Record<string, unknown>; keepalive?: boolean }[] = [];
  let ok = false;
  vi.stubGlobal('fetch', vi.fn(async (_u: string, init: RequestInit) => {
    calls.push({ body: JSON.parse(String(init.body)), keepalive: init.keepalive });
    if (!ok) throw new TypeError('server down');
    return new Response('{}', { status: 200 });
  }));
  const tick = () => new Promise((r) => setTimeout(r, 0));
  try {
    setLang('en');
    chooseLang('ru'); // server down: the POST fails
    await tick();
    expect(calls[0]).toEqual({ body: { lang: 'ru' }, keepalive: true });
    adoptServerLang('en'); // the server restarts and its hello (older than the choice) says en
    expect(getLang()).toBe('ru'); // not reverted
    expect(calls).toHaveLength(2); // and the choice is sent again
    ok = true;
    adoptServerLang(undefined);
    await tick();
    expect(calls).toHaveLength(3);
    adoptServerLang('en'); // confirmed now: the server's value wins again
    expect(getLang()).toBe('en');
    expect(calls).toHaveLength(3);
  } finally {
    vi.unstubAllGlobals();
  }
});

it('a hello that lands while the POST is still in flight does not undo the choice (the other order)', async () => {
  const { adoptServerLang, chooseLang, getLang } = await import('./index.ts');
  let release!: () => void;
  vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>((res) => { release = () => res(new Response('{}', { status: 200 })); })));
  try {
    setLang('en');
    chooseLang('ru'); // POST in flight
    adoptServerLang('en'); // hello built before the POST was applied
    expect(getLang()).toBe('ru');
    release();
    await new Promise((r) => setTimeout(r, 0));
    adoptServerLang('ru');
    expect(getLang()).toBe('ru');
  } finally {
    vi.unstubAllGlobals();
  }
});
