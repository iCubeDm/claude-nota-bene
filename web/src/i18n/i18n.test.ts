import { afterEach, expect, it, vi } from 'vitest';
import { en } from './en.ts';
import { initialLang, setLang, t } from './index.ts';
import { ru } from './ru.ts';

afterEach(() => setLang('ru'));

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
    expect(posts).toEqual([{ lang: 'ru' }]);
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
