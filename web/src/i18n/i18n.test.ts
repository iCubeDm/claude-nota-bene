import { afterEach, expect, it } from 'vitest';
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

it('initialLang prefers the stored choice, then the browser language', () => {
  expect(initialLang('ru-RU', null)).toBe('ru');
  expect(initialLang('en-US', null)).toBe('en');
  expect(initialLang('ru-RU', 'en')).toBe('en');
});
