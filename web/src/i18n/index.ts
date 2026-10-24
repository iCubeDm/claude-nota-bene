import { useSyncExternalStore } from 'react';
import { en } from './en.ts';
import { ru } from './ru.ts';

export type Lang = 'ru' | 'en';

const DICTS: Record<Lang, Record<string, unknown>> = { ru, en };

export function initialLang(navLang: string, stored: string | null): Lang {
  if (stored === 'ru' || stored === 'en') return stored;
  return /^ru\b/i.test(navLang) ? 'ru' : 'en';
}

const listeners = new Set<() => void>();
let lang: Lang = initialLang(
  typeof navigator === 'undefined' ? '' : navigator.language,
  typeof localStorage === 'undefined' ? null : localStorage.getItem('lang'),
);
if (typeof document !== 'undefined') document.documentElement.lang = lang;

export function getLang(): Lang {
  return lang;
}

export function setLang(l: Lang): void {
  lang = l;
  localStorage.setItem('lang', l);
  document.documentElement.lang = l;
  for (const fn of listeners) fn();
}

export function t(key: keyof typeof ru, ...args: unknown[]): string {
  const v = DICTS[lang][key] ?? DICTS.en[key] ?? key;
  return typeof v === 'function' ? String(v(...args)) : String(v);
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/**
 * Re-renders the calling component when the language changes. The returned `t` is the same module-level
 * function every time, so it does NOT change identity: memoised children that call t() themselves need
 * their own useT() (or another prop that changes) to pick up a new language.
 */
export function useT(): typeof t {
  useSyncExternalStore(subscribe, getLang);
  return t;
}
