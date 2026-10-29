/**
 * "Only the newest wins": `next()` hands out a token, `current(token)` is true until another `next()` or `invalidate()`.
 * A parse that cannot be cancelled checks its token afterwards and throws its result away when it was superseded.
 */
export function createLatest() {
  let n = 0;
  return {
    next: () => ++n,
    current: (token: number) => token === n,
    invalidate: () => void ++n,
  };
}
