import type { EventHub } from './hub.ts';

export function reportError(hub: EventHub, where: string, e: unknown): void {
  const message = e instanceof Error ? e.message : String(e);
  console.error(`[${where}]`, e);
  hub.emit({ kind: 'server-error', where, message }, { store: false });
}

export function guard<A extends unknown[]>(hub: EventHub, where: string, fn: (...a: A) => void): (...a: A) => void {
  return (...a: A) => {
    try {
      fn(...a);
    } catch (e) {
      reportError(hub, where, e);
    }
  };
}
