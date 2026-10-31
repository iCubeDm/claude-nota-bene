// The server's state folder holds the access token, so no file route may serve, list or search anything in it, whatever the
// project root, the symlinks or the source (`src=`) are: a window whose root is $HOME contains `~/.nota-bene`, and a cookie that
// may read project files must not read the token with it. One check, shared by /file, /tree, /model, /complete and the branch reads.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { stateBaseDir, stateDir } from './state.ts';

/**
 * Every folder that holds secrets, as real paths: the current state folder and the two default ones (`~/.nota-bene`,
 * `~/.nota-bene-dev`), whatever NOTA_BENE_HOME is now: a dev window must not serve the production token, nor the other way round.
 * null when the current one cannot be resolved: the guard then fails closed.
 */
function realStates(): string[] | null {
  let cur: string;
  try {
    cur = fs.realpathSync.native(stateDir());
  } catch {
    return null;
  }
  const out = new Set([cur, realish(stateBaseDir())]);
  for (const name of ['.nota-bene', '.nota-bene-dev']) out.add(realish(path.join(os.homedir(), name)));
  return [...out];
}

/** The real path of `abs`: its deepest existing ancestor resolved, the missing tail appended. */
function realish(abs: string): string {
  let cur = path.resolve(abs);
  let tail = '';
  for (;;) {
    try {
      return path.join(fs.realpathSync.native(cur), tail);
    } catch {
      const up = path.dirname(cur);
      if (up === cur) return path.resolve(abs);
      tail = path.join(path.basename(cur), tail);
      cur = up;
    }
  }
}

/** A checker with the state folders resolved once (for a loop); true for them and anything under them, through symlinks too. Fails closed. */
export function stateCheck(): (abs: string) => boolean {
  const states = realStates();
  if (!states) return () => true;
  return (abs) => {
    const real = realish(abs);
    return states.some((state) => real === state || real.startsWith(state + path.sep));
  };
}

/** True when `abs` is a state folder or anything under it (through symlinks too). Fails closed. */
export const underState = (abs: string): boolean => stateCheck()(abs);

/**
 * A predicate on paths relative to `root` ('/'-separated): true for the entries that are a state folder or inside one. Cheap
 * for long lists (the folders resolved once, then string prefixes); false for everything when none is inside the root. Fails
 * closed (everything hidden) when the state folder cannot be resolved.
 */
export function stateRelativeTo(root: string): (rel: string) => boolean {
  const states = realStates();
  if (!states) return () => true;
  const realRoot = realish(root); // root need not exist (a branch's place in the working tree)
  const prefixes: string[] = [];
  for (const state of states) {
    const rel = path.relative(realRoot, state);
    if (rel === '' || rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel)) continue;
    prefixes.push(rel.split(path.sep).join('/'));
  }
  return (p) => prefixes.some((prefix) => p === prefix || p.startsWith(prefix + '/'));
}
