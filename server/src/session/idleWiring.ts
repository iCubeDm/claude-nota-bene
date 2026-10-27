import type { Capabilities, IdleCompact } from '@nota-bene/shared';
import { IdleCompactor, idleConfig, offInClaudeSettings, type IdleConfig } from '../idle.ts';
import { prefsKey, readPrefs } from '../prefs.ts';

/** The session's idle compaction: the compactor and the per-project state the UI shows. */
export function idleCompaction(o: {
  config?: IdleConfig; offInSettings?: () => boolean; root: () => string; capabilities: Capabilities;
  busy: () => boolean; contextUsed: () => number | null; compact: () => void;
}): { idle: IdleCompactor; state: () => IdleCompact; enabled: () => boolean } {
  const config = o.config ?? idleConfig();
  const blocked = o.offInSettings ?? offInClaudeSettings;
  const state = (): IdleCompact => ({
    on: readPrefs().idleCompact[prefsKey(o.root())] ?? true,
    blocked: blocked(),
    minutes: Math.round(config.afterMs / 60_000),
    awayMinutes: Math.round(config.awayMs / 60_000),
    minTokens: config.minTokens,
  });
  const enabled = () => { const st = state(); const c = o.capabilities; return c.idleCompact && c.compact && st.on && !st.blocked; };
  const idle = new IdleCompactor({
    config, enabled, busy: o.busy, contextUsed: o.contextUsed, compact: o.compact,
    onFire: (why) => { if (why !== 'active' && why !== 'off') console.log(`[idle] ${why}`); }, // the retries would flood the log
  });
  return { idle, state, enabled };
}
