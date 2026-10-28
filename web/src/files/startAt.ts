/**
 * Where a media tab should start, set by "open in a tab" on a chat video/audio that was played. Keyed by tab id and
 * consumed once (by the file view when the media is ready), so it is not redux state: nothing renders from it.
 */
const pending = new Map<string, number>();
export const setStartAt = (tabId: string, seconds: number): void => void pending.set(tabId, seconds);
export function takeStartAt(tabId: string): number | undefined {
  const t = pending.get(tabId);
  pending.delete(tabId);
  return t;
}
