import { useSyncExternalStore } from 'react';
import { apiFetch } from '../net/auth.ts';
import { en } from './en.ts';
import { ru } from './ru.ts';

export type Lang = 'ru' | 'en';

const DICTS: Record<Lang, Record<string, unknown>> = { ru, en };

/** The languages on offer, each named in itself; adding one here adds it to the header menu and to Settings. */
export const LANGS: { id: Lang; name: string }[] = [{ id: 'en', name: 'English' }, { id: 'ru', name: 'Русский' }];

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

/** A choice the server has not confirmed yet (it was down, restarting, or the POST is still in flight). */
let unsynced: Lang | null = null;

/**
 * Tells the server the choice (prefs.json, shared by every window: localStorage is per port). Best effort, but the choice
 * stays `unsynced` until the server answers ok, and `adoptServerLang` keeps it safe from an older `hello.lang` meanwhile.
 * `ifUnset`: the migration of an old local choice; it must not win over, nor be protected against, the server's value.
 */
export function persistLang(l: Lang, ifUnset = false): void {
  if (!ifUnset) unsynced = l;
  try {
    void apiFetch('/system/prefs', {
      method: 'POST', keepalive: true, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ lang: l, ...(ifUnset ? { ifUnset: true } : {}) }),
    }).then((r) => { if (r.ok && !ifUnset && unsynced === l) unsynced = null; }, () => {});
  } catch { /* no fetch: the local cache still holds the choice */ }
}

/** The user picked a language (header menu, Settings): apply it here and save it for every window. */
export function chooseLang(l: Lang): void {
  setLang(l);
  persistLang(l);
}

/**
 * The server's `hello.lang`: the server's value wins over this origin's localStorage cache, except while our own choice is
 * unconfirmed (then it is sent again and the hello, which may predate it, is ignored). With no value on the server yet, a
 * choice this browser already made (localStorage) is moved up if still unset there, so nobody loses it.
 */
export function adoptServerLang(server: string | undefined): void {
  if (unsynced) return persistLang(unsynced);
  if (server === 'ru' || server === 'en') {
    if (server !== lang) setLang(server);
    return;
  }
  const stored = typeof localStorage === 'undefined' ? null : localStorage.getItem('lang');
  if (stored === 'ru' || stored === 'en') persistLang(stored, true);
}

/** test only: forget an unconfirmed choice */
export function resetUnsyncedLang(): void {
  unsynced = null;
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
