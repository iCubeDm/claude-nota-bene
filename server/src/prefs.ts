import fs from 'node:fs';
import path from 'node:path';
import { MODES } from '@nota-bene/shared';
import type { Mode } from '@nota-bene/shared';
import { stateDir } from './state.ts';

export type Prefs = { modes: Record<string, Mode>; lang?: 'ru' | 'en' };

const isMode = (v: unknown): v is Mode => (MODES as readonly unknown[]).includes(v);
let reported = false; // a broken file is reported once per process, not on every read

/** Keys are real project dirs, so a symlinked path and its target share one setting. */
export function prefsKey(dir: string): string {
  try {
    return fs.realpathSync.native(dir);
  } catch {
    return path.resolve(dir);
  }
}

function file(): string {
  return path.join(stateDir(), 'prefs.json');
}

/** A missing or corrupt file gives the defaults; corruption is logged once. */
export function readPrefs(): Prefs {
  let raw: string;
  try {
    raw = fs.readFileSync(file(), 'utf8');
  } catch {
    return { modes: {} };
  }
  try {
    const data: unknown = JSON.parse(raw);
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('prefs.json is not an object');
    const { modes, lang } = data as { modes?: unknown; lang?: unknown };
    const out: Prefs = { modes: {} };
    if (modes && typeof modes === 'object' && !Array.isArray(modes)) {
      for (const [k, v] of Object.entries(modes)) if (isMode(v)) out.modes[k] = v;
    }
    if (lang === 'ru' || lang === 'en') out.lang = lang;
    return out;
  } catch (e) {
    if (!reported) {
      reported = true;
      console.error('[prefs] ignoring unreadable prefs.json:', e);
    }
    return { modes: {} };
  }
}

export function setModePref(dir: string, mode: Mode): void {
  // merge into the raw object: unknown top-level keys and other projects' entries survive the save
  let raw: Record<string, unknown> = {};
  try {
    const data: unknown = JSON.parse(fs.readFileSync(file(), 'utf8'));
    if (data && typeof data === 'object' && !Array.isArray(data)) raw = data as Record<string, unknown>;
  } catch {
    // missing or corrupt: start from an empty object
  }
  const modes = raw.modes && typeof raw.modes === 'object' && !Array.isArray(raw.modes) ? (raw.modes as Record<string, unknown>) : {};
  modes[prefsKey(dir)] = mode;
  raw.modes = modes;
  const f = file();
  const tmp = `${f}.tmp${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(raw, null, 2));
  fs.renameSync(tmp, f);
}
