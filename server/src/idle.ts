import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Idle compaction (the terminal CLI's feature, which the SDK does not run): a long conversation nobody touches is
 * compacted while its prompt cache is still warm, so the next message does not reprocess the whole context uncached.
 * Like the CLI (~54 min), it fires `afterMs` after the last turn ended, and only when the window has seen no activity
 * for `awayMs` (someone reading a long reply is not away). Past `cacheMs` the cache may be gone: a compaction then
 * would read it all uncached and lose detail for nothing, so it gives up.
 */
export const AFTER_MS = 50 * 60_000;
export const AWAY_MS = 15 * 60_000;
/** the prompt cache is written for 1 h (measured on our sessions); keep a margin for the compaction call itself */
export const CACHE_MS = 55 * 60_000;
/** busy, switched off or someone active at the time: look again this often until the cache runs out */
export const RETRY_MS = 60_000;
/** the CLI's minimum; a summary is ~20k tokens, so compacting much less buys nothing */
export const MIN_TOKENS = 200_000;

export type IdleConfig = { afterMs: number; awayMs: number; retryMs: number; cacheMs: number; minTokens: number };

const num = (v: string | undefined): number | undefined => {
  const n = Number(v);
  return v !== undefined && v !== '' && Number.isFinite(n) && n >= 0 ? n : undefined;
};

/** NOTA_BENE_IDLE_COMPACT_MINUTES; CLAUDE_CODE_IDLE_COMPACT_MIN_TOKENS (the CLI's own knob). */
export function idleConfig(env: NodeJS.ProcessEnv = process.env): IdleConfig {
  const minutes = num(env.NOTA_BENE_IDLE_COMPACT_MINUTES);
  return {
    afterMs: minutes !== undefined && minutes > 0 ? minutes * 60_000 : AFTER_MS,
    awayMs: AWAY_MS,
    retryMs: RETRY_MS,
    cacheMs: CACHE_MS,
    minTokens: num(env.CLAUDE_CODE_IDLE_COMPACT_MIN_TOKENS) ?? MIN_TOKENS,
  };
}

/** `"idleCompaction": false` in the user's Claude Code settings turns it off here too. */
export function offInClaudeSettings(env: NodeJS.ProcessEnv = process.env): boolean {
  const dir = env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  try {
    const s: unknown = JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8'));
    return !!s && typeof s === 'object' && (s as { idleCompaction?: unknown }).idleCompaction === false;
  } catch {
    return false;
  }
}

export type IdleWhy = 'started' | 'off' | 'busy' | 'active' | 'small' | 'cold';

type IdleOptions = {
  config: IdleConfig;
  enabled: () => boolean;
  busy: () => boolean;
  contextUsed: () => number | null;
  compact: () => void;
  /** each firing's outcome (tests, logs) */
  onFire?: (why: IdleWhy) => void;
  now?: () => number;
};

/**
 * Armed by a turn's end, disarmed by any compaction (also a manual one) or a session change: one idle compaction per
 * stretch of quiet, never on a session nobody has talked to since it was opened.
 */
export class IdleCompactor {
  private timer: NodeJS.Timeout | null = null;
  private turnEnd: number | null = null; // armed: when the last turn ended
  private lastActivity = 0;
  private readonly now: () => number;
  private readonly o: IdleOptions;

  constructor(o: IdleOptions) {
    this.o = o;
    this.now = o.now ?? Date.now;
  }

  /** A turn ended: arm, due `afterMs` from now. */
  turnEnded(): void {
    this.turnEnd = this.lastActivity = this.now();
    this.schedule(this.o.config.afterMs);
  }

  /** Any activity (a send, a command, the UI): someone is here. */
  touch(): void {
    this.lastActivity = this.now();
  }

  /** A compaction (any) or a new session: nothing to do until the next turn. */
  disarm(): void {
    this.turnEnd = null;
    this.clear();
  }

  stop(): void {
    this.disarm();
  }

  private clear(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private schedule(ms: number): void {
    this.clear();
    this.timer = setTimeout(() => this.fire(), ms);
    this.timer.unref();
  }

  private fire(): void {
    this.timer = null;
    const why = this.decide();
    // not now (busy, switched off, someone here): look again until the cache runs out, so leaving a little later or
    // turning it back on still counts
    if (why === 'busy' || why === 'off' || why === 'active') this.schedule(this.o.config.retryMs);
    else this.disarm();
    if (why === 'started') this.o.compact();
    this.o.onFire?.(why);
  }

  private decide(): IdleWhy {
    const now = this.now();
    if (this.turnEnd === null || now - this.turnEnd > this.o.config.cacheMs) return 'cold';
    if (!this.o.enabled()) return 'off';
    if (this.o.busy()) return 'busy';
    if (now - this.lastActivity < this.o.config.awayMs) return 'active';
    if ((this.o.contextUsed() ?? 0) < this.o.config.minTokens) return 'small';
    return 'started';
  }
}
