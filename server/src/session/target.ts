import fs from 'node:fs';
import path from 'node:path';
import type { AgentBackend } from '../agent/types.ts';
import { cwdOf } from '../sessions.ts';
import { SwitchError } from './phase.ts';

export const SESSION_ID = /^[0-9a-f-]{36}$/i;

export function realOr(p: string): string {
  try {
    return fs.realpathSync.native(p);
  } catch {
    return path.resolve(p);
  }
}

/** Throws a SwitchError for a target that must not be opened; returns the realpath of `dir`. */
export async function checkTarget(o: {
  backend: Pick<AgentBackend, 'listSessions' | 'sessionInfo'>; root: string; id: string | null; dir: string; ownSession: boolean;
}): Promise<string> {
  const { backend, id, dir } = o;
  let real: string;
  try {
    if (!path.isAbsolute(dir)) throw new Error('relative');
    real = await fs.promises.realpath(dir); // the promises realpath is the native one (case, firmlinks), like realOr
    if (!(await fs.promises.stat(real)).isDirectory()) throw new Error('not a directory');
    await fs.promises.access(real, fs.constants.R_OK | fs.constants.X_OK);
  } catch {
    throw new SwitchError('switch', `not an existing, readable directory: ${dir}`);
  }
  if (o.ownSession) return real;
  if (id === null) {
    // a new session may only open where a session already lives (or here): a local client must not be able to
    // re-root /file at / or ~
    if (real === realOr(o.root)) return real;
    let list: Awaited<ReturnType<AgentBackend['listSessions']>>;
    try {
      list = await backend.listSessions();
    } catch (e) {
      throw new SwitchError('switch', `cannot list sessions: ${e instanceof Error ? e.message : String(e)}`);
    }
    const known = new Set<string>();
    for (const x of list) {
      const cwd = x.cwd || cwdOf(x.sessionId);
      if (cwd && !known.has(cwd)) known.add(cwd);
    }
    for (const cwd of known) if (realOr(cwd) === real) return real;
    throw new SwitchError('switch', `no session lives in ${real}`);
  }
  if (!SESSION_ID.test(id)) throw new SwitchError('switch', `invalid session id: ${id}`);
  // the client sends the session's own cwd: a mismatch is a bug or a stale list, never something to guess around
  let info: Awaited<ReturnType<AgentBackend['sessionInfo']>>;
  try {
    info = await backend.sessionInfo(id, real);
  } catch (e) {
    throw new SwitchError('switch', `cannot read session ${id.slice(0, 8)}: ${e instanceof Error ? e.message : String(e)}`);
  }
  const cwd = info ? info.cwd ?? cwdOf(id) : null;
  if (!info || (cwd !== null && realOr(cwd) !== real)) throw new SwitchError('switch', `session ${id.slice(0, 8)} does not belong to ${real}`);
  return real;
}
