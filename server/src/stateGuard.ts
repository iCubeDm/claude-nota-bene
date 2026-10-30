// The server's state folder holds the access token, so no file route may serve, list or search anything in it, whatever the
// project root, the symlinks or the source (`src=`) are: a window whose root is $HOME contains `~/.nota-bene`, and a cookie that
// may read project files must not read the token with it. One check, shared by /file, /tree, /model, /complete and the branch reads.
import fs from 'node:fs';
import path from 'node:path';
import { stateDir } from './state.ts';

function realState(): string | null {
  try {
    return fs.realpathSync.native(stateDir());
  } catch {
    return null;
  }
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

/** A checker with the state folder resolved once (for a loop); true for it and anything under it, through symlinks too. */
export function stateCheck(): (abs: string) => boolean {
  const state = realState();
  if (!state) return () => false;
  return (abs) => {
    const real = realish(abs);
    return real === state || real.startsWith(state + path.sep);
  };
}

/** True when `abs` is the state folder or anything under it (through symlinks too). */
export const underState = (abs: string): boolean => stateCheck()(abs);

/**
 * A predicate on paths relative to `root` ('/'-separated): true for the entries that are the state folder or inside it. Cheap
 * for long lists (one realpath of the root and of the state folder, then string prefixes); false for everything when the state
 * folder is not inside the root.
 */
export function stateRelativeTo(root: string): (rel: string) => boolean {
  const state = realState();
  if (!state) return () => false;
  const rel = path.relative(realish(root), state); // root need not exist (a branch's place in the working tree)
  if (rel === '' || rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel)) return () => false;
  const prefix = rel.split(path.sep).join('/');
  return (p) => p === prefix || p.startsWith(prefix + '/');
}
