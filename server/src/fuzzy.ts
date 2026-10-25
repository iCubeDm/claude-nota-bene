/**
 * Fuzzy subsequence score of a project path against a query (the prototype's `fuzzy`).
 * Consecutive characters, segment starts and file-name hits rank higher; -1 = no match.
 */
export function fuzzyScore(path: string, q: string): number {
  const lp = path.toLowerCase();
  const lq = q.toLowerCase();
  const base = lp.replace(/\/$/, '').lastIndexOf('/') + 1;
  let i = 0;
  let last = -2;
  let sc = 0;
  for (const ch of lq) {
    const j = lp.indexOf(ch, i);
    if (j < 0) return -1;
    sc += (j === last + 1 ? 5 : 0) + (j === 0 || '/-_. '.includes(lp[j - 1]!) ? 4 : 0) + (j >= base ? 2 : 0);
    last = j;
    i = j + 1;
  }
  const name = lp.slice(base);
  sc += name.startsWith(lq) ? 25 : name.includes(lq) ? 12 : lp.includes(lq) ? 6 : 0;
  return sc - path.length * 0.05;
}
