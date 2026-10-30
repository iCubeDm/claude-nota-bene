import type { SlashCommand } from '@nota-bene/shared';

/** 0 prefix, 1 contains, 2 subsequence (the same walk as the `@` search and the highlight), -1 none */
function grade(text: string, q: string): number {
  const t = text.toLowerCase();
  if (t.startsWith(q)) return 0;
  if (t.includes(q)) return 1;
  let i = 0;
  for (const ch of t) if (ch === q[i] && ++i === q.length) return 2;
  return -1;
}

/** The commands matching `q` (case does not matter), best first: by the name, then by an alias; the list's own order (the user's first) inside a rank. */
export function rankCommands(list: SlashCommand[], query: string): SlashCommand[] {
  const q = query.toLowerCase();
  if (!q) return list;
  const ranked = list.flatMap((c, k) => {
    const g = grade(c.name, q);
    if (g >= 0) return [{ c, k, r: g }];
    const a = Math.min(...(c.aliases ?? []).map((x) => grade(x, q)).filter((x) => x >= 0));
    return Number.isFinite(a) ? [{ c, k, r: 3 + a }] : [];
  });
  return ranked.sort((x, y) => x.r - y.r || x.k - y.k).map((x) => x.c);
}

/** What follows the `/` when the caret sits in a draft's first word (the word starts the draft with a slash); null anywhere else. */
export function slashToken(value: string, caret: number): string | null {
  const m = /^\/(\S*)$/.exec(value.slice(0, caret));
  return m ? m[1] : null;
}

/**
 * The draft's first word runs the CLI's /clear: the word itself, or an alias of the built-in (a command of the user's own by that name
 * wins, as in the CLI). Mirrors the server's `trackedCommand`; with no list yet only the literal `/clear` counts.
 */
export function isClearCommand(text: string, list: readonly SlashCommand[]): boolean {
  const word = /^\/([^\s/]+)(\s|$)/.exec(text)?.[1];
  if (!word) return false;
  const named = list.find((c) => c.name === word) ?? list.find((c) => c.builtin && c.aliases?.includes(word));
  return named ? !!named.builtin && named.name === 'clear' : word === 'clear';
}
