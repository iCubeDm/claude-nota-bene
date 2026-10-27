import type { ServerEvent } from '@nota-bene/shared';

class TimeoutError extends Error {}

/**
 * A stored session's replay, raced against `timeoutMs` (a transcript read that hangs must not hold `switching`).
 * Either failure gives an empty feed: a timeout is reported as `switch` (the client ends its "switching" state on a
 * switch error), an unreadable transcript as `history` (it must not stop the server).
 */
export async function readHistory(o: {
  read: () => Promise<ServerEvent[]>; timeoutMs: number; report: (where: string, e: unknown) => void;
}): Promise<ServerEvent[]> {
  let timer: NodeJS.Timeout | undefined;
  try {
    const read = o.read();
    read.catch(() => {}); // a read that loses the race may still reject later: no news
    return await Promise.race([
      read,
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new TimeoutError('transcript read timed out')), o.timeoutMs); }),
    ]);
  } catch (e) {
    o.report(e instanceof TimeoutError ? 'switch' : 'history', e);
    return [];
  } finally {
    clearTimeout(timer);
  }
}
