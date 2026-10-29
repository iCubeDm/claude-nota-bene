/**
 * Where a media tab should start, set by "open in a tab" on a chat video/audio that was played, and whether it plays on
 * (it was playing at the click). Keyed by tab id and consumed once (by the file view when the media is ready), so it is
 * not redux state: nothing renders from it.
 */
export type StartAt = { at: number; play: boolean };
const pending = new Map<string, StartAt>();
export const setStartAt = (tabId: string, at: number, play = false): void => void pending.set(tabId, { at, play });
export function takeStartAt(tabId: string): StartAt | undefined {
  const t = pending.get(tabId);
  pending.delete(tabId);
  return t;
}
