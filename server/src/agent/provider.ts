import path from 'node:path';

export type AgentProvider = 'claude' | 'codex';

export function parseProvider(value: string | undefined): AgentProvider {
  if (value === undefined || value === 'claude') return 'claude';
  if (value === 'codex') return value;
  throw new Error(`Invalid agent: ${value}. Expected claude or codex.`);
}

/** Legacy Claude storage is unchanged; all Codex-owned data/secrets are separate. */
export function providerStateDir(base: string, provider: AgentProvider): string {
  return provider === 'claude' ? base : path.join(base, 'providers', provider);
}
