import fs from 'node:fs';
import { MODES } from '@nota-bene/shared';
import { prefsKey, prototypeImported, updateRawPrefs } from './prefs.ts';
import { addMissingSessions } from './state.ts';

/** `<repo>/prototype/.sessions.json`, resolved from this file. */
export const PROTOTYPE_SESSIONS = new URL('../../prototype/.sessions.json', import.meta.url);

const realDir = (p: string): string | undefined => {
  try {
    return fs.statSync(p).isDirectory() ? fs.realpathSync.native(p) : undefined;
  } catch {
    return undefined;
  }
};

/**
 * R-M5-4: one-time import of the prototype's folder→session and per-port mode state. Never overwrites rebuild
 * state; the marker in prefs.json (written even when the file is absent or corrupt) makes it run once.
 */
export function importPrototypeState(o: { prototypeSessions: string | URL }): { sessions: number; modes: number } {
  if (prototypeImported()) return { sessions: 0, modes: 0 };
  let data: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(o.prototypeSessions, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { sessions: 0, modes: 0 };
    data = parsed as Record<string, unknown>;
  } catch (e) {
    // absent: nothing to import, and the marker stops further checks. Unreadable or half-written (the prototype
    // writes non-atomically while it still runs): skip without the marker so the next start retries.
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') return { sessions: 0, modes: 0 };
  }
  const sessions: Record<string, string> = {};
  const roots: Array<{ port: number; dir: string }> = [];
  for (const [k, v] of Object.entries(data)) {
    if (typeof v !== 'string') continue;
    if (k.startsWith('_root:')) {
      const port = Number(k.slice(6));
      if (Number.isInteger(port)) roots.push({ port, dir: v });
    } else if (!k.startsWith('_')) {
      const d = realDir(k);
      if (d && !(d in sessions)) sessions[d] = v;
    }
  }
  const modeFor: Record<string, { port: number; mode: (typeof MODES)[number] }> = {};
  for (const { port, dir } of roots) {
    const mode = data[`_mode:${port}`];
    const d = realDir(dir);
    if (!d || !(MODES as readonly unknown[]).includes(mode)) continue;
    if (!modeFor[d] || port > modeFor[d].port) modeFor[d] = { port, mode: mode as (typeof MODES)[number] };
  }
  const sessionsAdded = addMissingSessions(sessions);
  let modesAdded = 0;
  updateRawPrefs((raw) => {
    const modes = raw.modes && typeof raw.modes === 'object' && !Array.isArray(raw.modes) ? (raw.modes as Record<string, unknown>) : {};
    for (const [d, { mode }] of Object.entries(modeFor)) {
      const key = prefsKey(d);
      if (modes[key] !== undefined) continue;
      modes[key] = mode;
      modesAdded++;
    }
    raw.modes = modes;
    raw.importedPrototype = true;
  });
  if (sessionsAdded || modesAdded) console.log(`imported from prototype: ${sessionsAdded} sessions, ${modesAdded} modes`);
  return { sessions: sessionsAdded, modes: modesAdded };
}

/** Startup entry: the NOTA_BENE_PROTOTYPE_SESSIONS override ('off' skips); a failure never blocks the start. */
export function importPrototypeStateSafely(env: NodeJS.ProcessEnv = process.env): void {
  const o = env.NOTA_BENE_PROTOTYPE_SESSIONS;
  if (o === 'off') return;
  try {
    importPrototypeState({ prototypeSessions: o || PROTOTYPE_SESSIONS });
  } catch (e) {
    console.error(`[migrate] skipped: ${e instanceof Error ? e.message : String(e)}`);
  }
}
