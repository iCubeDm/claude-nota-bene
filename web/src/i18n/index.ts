import { useSyncExternalStore } from 'react';
import { en } from './en.ts';
import { ru } from './ru.ts';

export type Lang = 'ru' | 'en';

const DICTS: Record<Lang, Record<string, unknown>> = { ru, en };

/** A stored choice wins; otherwise English, whatever the browser language says. */
export function initialLang(stored: string | null): Lang {
  return stored === 'ru' || stored === 'en' ? stored : 'en';
}

const listeners = new Set<() => void>();
let lang: Lang = initialLang(typeof localStorage === 'undefined' ? null : localStorage.getItem('lang'));
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

/** Translate into an explicit language (for text that must not follow the UI language, e.g. a sent batch). */
export function tIn(l: Lang, key: keyof typeof ru, ...args: unknown[]): string {
  const v = DICTS[l][key] ?? DICTS.en[key] ?? key;
  return typeof v === 'function' ? String(v(...args)) : String(v);
}

export function t(key: keyof typeof ru, ...args: unknown[]): string {
  return tIn(lang, key, ...args);
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
