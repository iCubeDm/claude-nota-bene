import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TitleTracker } from './title.ts';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

function make(answer: (id: string) => Promise<string | null> = async (id) => `title of ${id}`) {
  const cur = { id: 's1' as string | null, dir: '/p', gen: 0 };
  const calls: string[] = [];
  let changes = 0;
  const t = new TitleTracker({
    lookup: (id, dir) => { calls.push(`${id}@${dir}`); return answer(id); },
    current: () => cur,
    onChange: () => { changes++; },
  });
  return { t, cur, calls, changes: () => changes };
}
const flush = () => vi.advanceTimersByTimeAsync(0);

describe('TitleTracker', () => {
  it('after a result: one lookup now, then at most one per 10 s, the last result trailing', async () => {
    const { t, calls, changes } = make();
    t.afterResult();
    await flush();
    expect(calls).toEqual(['s1@/p']);
    expect(t.title).toBe('title of s1');
    expect(changes()).toBe(1);
    t.afterResult();
    t.afterResult();
    await vi.advanceTimersByTimeAsync(9_999);
    expect(calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(calls).toHaveLength(2);
    expect(changes()).toBe(1); // same title: no change announced
  });

  it('the lookup reads the session as it is when it runs, and is dropped when the generation or id moved meanwhile', async () => {
    let release!: (t: string) => void;
    const { t, cur, changes } = make(() => new Promise((r) => { release = r; }));
    t.afterResult();
    await flush();
    cur.gen = 1; // a restart: same id
    release('stale');
    await flush();
    expect(t.title).toBeNull();
    expect(changes()).toBe(0);
  });

  it('no id: no lookup', async () => {
    const { t, cur, calls } = make();
    cur.id = null;
    t.afterResult();
    await flush();
    expect(calls).toEqual([]);
  });

  it('a failed or timed-out lookup keeps the title', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    let n = 0;
    const { t } = make(async () => { if (++n === 1) return 'first'; throw new Error('boom'); });
    t.afterResult();
    await flush();
    expect(t.title).toBe('first');
    await vi.advanceTimersByTimeAsync(10_000);
    t.afterResult();
    await flush();
    expect(t.title).toBe('first');
    expect(err).toHaveBeenCalled();
    err.mockRestore();
  });

  it('a lookup that hangs times out after 5 s', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { t } = make(() => new Promise(() => {}));
    const p = t.load('s1', '/p');
    await vi.advanceTimersByTimeAsync(5000);
    await p;
    expect(t.title).toBeNull();
    err.mockRestore();
  });

  it('load sets the title without announcing it (the caller announces the session), and starts the throttle', async () => {
    const { t, calls, changes } = make();
    await t.load('s2', '/q');
    expect(t.title).toBe('title of s2');
    expect(changes()).toBe(0);
    t.afterResult();
    await flush();
    expect(calls).toHaveLength(1); // throttled: the load was the lookup
  });

  it('reset forgets the title and the throttle but keeps a scheduled lookup; stop cancels it', async () => {
    const { t, calls } = make();
    t.afterResult();
    await flush();
    t.afterResult(); // trailing, in 10 s
    t.reset();
    expect(t.title).toBeNull();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(calls).toHaveLength(2);
    t.afterResult(); // throttle restarted by that lookup: trailing again
    t.stop();
    t.reset();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(calls).toHaveLength(2);
    t.afterResult(); // reset: due at once
    await flush();
    expect(calls).toHaveLength(3);
  });
});
