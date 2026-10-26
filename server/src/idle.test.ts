import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AFTER_MS, AWAY_MS, CACHE_MS, IdleCompactor, MIN_TOKENS, RETRY_MS, idleConfig, offInClaudeSettings, type IdleWhy } from './idle.ts';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

function make(o: { enabled?: boolean; busy?: boolean; used?: number | null } = {}) {
  const st = { enabled: o.enabled ?? true, busy: o.busy ?? false, used: o.used === undefined ? 300_000 : o.used };
  const fired: IdleWhy[] = [];
  const compact = vi.fn();
  const c = new IdleCompactor({
    config: { afterMs: 1000, awayMs: 300, retryMs: 100, cacheMs: 1500, minTokens: 200_000 },
    enabled: () => st.enabled, busy: () => st.busy, contextUsed: () => st.used, compact,
    onFire: (w) => fired.push(w), now: () => Date.now(),
  });
  return { c, st, fired, compact };
}

describe('IdleCompactor', () => {
  it('compacts once, afterMs after the turn, then waits for the next turn', () => {
    const { c, compact, fired } = make();
    c.turnEnded();
    vi.advanceTimersByTime(999);
    expect(compact).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(compact).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(10_000);
    expect(compact).toHaveBeenCalledTimes(1);
    expect(fired).toEqual(['started']);
  });

  it('nothing before a first turn; activity does not move the time, it only says someone is here', () => {
    const { c, compact, fired } = make();
    c.touch();
    vi.advanceTimersByTime(2000);
    expect(compact).not.toHaveBeenCalled(); // never armed
    c.turnEnded();
    vi.advanceTimersByTime(800);
    c.touch(); // active at 800: still 'active' at 1000 (away 300), and at 1100 is away
    vi.advanceTimersByTime(200);
    expect(fired).toEqual(['active']);
    vi.advanceTimersByTime(100);
    expect(compact).toHaveBeenCalledTimes(1);
  });

  it('someone active until the cache runs out: never compacted', () => {
    const { c, compact, fired } = make();
    c.turnEnded();
    for (let t = 0; t < 1700; t += 100) { c.touch(); vi.advanceTimersByTime(100); }
    expect(compact).not.toHaveBeenCalled();
    expect(fired.at(-1)).toBe('cold');
    const n = fired.length;
    vi.advanceTimersByTime(5000);
    expect(fired).toHaveLength(n); // gave up
  });

  it('off, small or a compaction in between: no compaction', () => {
    const off = make({ enabled: false });
    off.c.turnEnded();
    vi.advanceTimersByTime(1000);
    expect(off.fired).toEqual(['off']);
    const small = make({ used: 150_000 });
    small.c.turnEnded();
    vi.advanceTimersByTime(1000);
    expect(small.fired).toEqual(['small']);
    const unknown = make({ used: null });
    unknown.c.turnEnded();
    vi.advanceTimersByTime(1000);
    expect(unknown.fired).toEqual(['small']);
    const manual = make();
    manual.c.turnEnded();
    manual.c.disarm();
    vi.advanceTimersByTime(2000);
    expect(manual.fired).toEqual([]);
    for (const m of [off, small, unknown, manual]) expect(m.compact).not.toHaveBeenCalled();
  });

  it('switched off when due, then on again before the cache runs out: still compacts', () => {
    const { c, st, compact, fired } = make({ enabled: false });
    c.turnEnded();
    vi.advanceTimersByTime(1000);
    st.enabled = true;
    vi.advanceTimersByTime(100);
    expect(fired).toEqual(['off', 'started']);
    expect(compact).toHaveBeenCalledTimes(1);
  });

  it('busy (a permission waits): tries again, until the cache goes cold', () => {
    const { c, st, compact, fired } = make({ busy: true });
    c.turnEnded();
    vi.advanceTimersByTime(1200);
    expect(fired).toEqual(['busy', 'busy', 'busy']);
    st.busy = false;
    vi.advanceTimersByTime(100);
    expect(compact).toHaveBeenCalledTimes(1);
  });
});

describe('idleConfig and settings', () => {
  it('defaults: 50 min after the turn, 15 min away, 55 min cache, the CLI 200k minimum; env overrides', () => {
    expect(idleConfig({})).toEqual({ afterMs: AFTER_MS, awayMs: AWAY_MS, retryMs: RETRY_MS, cacheMs: CACHE_MS, minTokens: MIN_TOKENS });
    expect([AFTER_MS, AWAY_MS, CACHE_MS]).toEqual([50 * 60_000, 15 * 60_000, 55 * 60_000]);
    expect(idleConfig({ NOTA_BENE_IDLE_COMPACT_MINUTES: '5', CLAUDE_CODE_IDLE_COMPACT_MIN_TOKENS: '100000' }))
      .toMatchObject({ afterMs: 5 * 60_000, minTokens: 100_000 });
    expect(idleConfig({ NOTA_BENE_IDLE_COMPACT_MINUTES: 'x', CLAUDE_CODE_IDLE_COMPACT_MIN_TOKENS: '-1' }))
      .toMatchObject({ afterMs: AFTER_MS, minTokens: MIN_TOKENS });
  });

  it('"idleCompaction": false in Claude Code settings.json blocks it; missing or broken files do not', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nb-idle-'));
    try {
      const env = { CLAUDE_CONFIG_DIR: dir };
      expect(offInClaudeSettings(env)).toBe(false);
      fs.writeFileSync(path.join(dir, 'settings.json'), '{ broken');
      expect(offInClaudeSettings(env)).toBe(false);
      fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ idleCompaction: true }));
      expect(offInClaudeSettings(env)).toBe(false);
      fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ idleCompaction: false }));
      expect(offInClaudeSettings(env)).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
