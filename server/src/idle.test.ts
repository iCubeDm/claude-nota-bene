import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CACHE_MS, IDLE_MS, IdleCompactor, MIN_TOKENS, idleConfig, offInClaudeSettings, type IdleWhy } from './idle.ts';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

function make(o: { enabled?: boolean; busy?: boolean; used?: number | null } = {}) {
  const st = { enabled: o.enabled ?? true, busy: o.busy ?? false, used: o.used === undefined ? 300_000 : o.used };
  const fired: IdleWhy[] = [];
  const compact = vi.fn();
  const c = new IdleCompactor({
    config: { idleMs: 1000, cacheMs: 5000, minTokens: 200_000 },
    enabled: () => st.enabled, busy: () => st.busy, contextUsed: () => st.used, compact,
    onFire: (w) => fired.push(w), now: () => Date.now(),
  });
  return { c, st, fired, compact };
}

describe('IdleCompactor', () => {
  it('compacts once after a turn and the idle time, then waits for the next turn', () => {
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

  it('activity restarts the clock; nothing before a first turn', () => {
    const { c, compact } = make();
    c.touch();
    vi.advanceTimersByTime(2000);
    expect(compact).not.toHaveBeenCalled(); // never armed
    c.turnEnded();
    vi.advanceTimersByTime(800);
    c.touch();
    vi.advanceTimersByTime(800);
    expect(compact).not.toHaveBeenCalled();
    vi.advanceTimersByTime(200);
    expect(compact).toHaveBeenCalledTimes(1);
  });

  it('a cache gone cold (activity kept it from firing in time) is never compacted', () => {
    const { c, compact, fired } = make();
    c.turnEnded();
    for (let i = 0; i < 6; i++) { vi.advanceTimersByTime(900); c.touch(); } // 5.4 s of reading
    vi.advanceTimersByTime(1000);
    expect(compact).not.toHaveBeenCalled();
    expect(fired).toEqual(['cold']);
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

  it('switched off when it fired, then on again: this quiet stretch still counts', () => {
    const { c, st, compact, fired } = make({ enabled: false });
    c.turnEnded();
    vi.advanceTimersByTime(1000);
    st.enabled = true;
    vi.advanceTimersByTime(1000);
    expect(fired).toEqual(['off', 'started']);
    expect(compact).toHaveBeenCalledTimes(1);
  });

  it('busy (a permission waits): tries again, until the cache goes cold', () => {
    const { c, st, compact, fired } = make({ busy: true });
    c.turnEnded();
    vi.advanceTimersByTime(2000);
    expect(fired).toEqual(['busy', 'busy']);
    st.busy = false;
    vi.advanceTimersByTime(1000);
    expect(compact).toHaveBeenCalledTimes(1);
  });
});

describe('idleConfig and settings', () => {
  it('defaults: 15 min, 55 min cache, the CLI 200k minimum; env overrides', () => {
    expect(idleConfig({})).toEqual({ idleMs: IDLE_MS, cacheMs: CACHE_MS, minTokens: MIN_TOKENS });
    expect(IDLE_MS).toBe(15 * 60_000);
    expect(idleConfig({ NOTA_BENE_IDLE_COMPACT_MINUTES: '5', CLAUDE_CODE_IDLE_COMPACT_MIN_TOKENS: '100000' }))
      .toMatchObject({ idleMs: 5 * 60_000, minTokens: 100_000 });
    expect(idleConfig({ NOTA_BENE_IDLE_COMPACT_MINUTES: 'x', CLAUDE_CODE_IDLE_COMPACT_MIN_TOKENS: '-1' }))
      .toMatchObject({ idleMs: IDLE_MS, minTokens: MIN_TOKENS });
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
