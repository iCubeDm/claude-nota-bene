/**
 * Toasts live outside Redux: `toast()` must be callable from anywhere (a fetch catch, a thunk, a middleware) without
 * a dispatch or a store in reach, and a toast is transient UI that is never persisted or replayed. A module singleton
 * with `subscribe` (read by <Toasts> through useSyncExternalStore) is the smallest thing that does that.
 */
export type ToastItem = { id: number; title: string; msg: string; count: number };

const TIMEOUT_MS = 15_000;
const MAX = 5;

let list: ToastItem[] = [];
let seq = 0;
const timers = new Map<number, ReturnType<typeof setTimeout>>();
const listeners = new Set<() => void>();

const emit = () => { for (const fn of listeners) fn(); };

export const subscribeToasts = (fn: () => void): (() => void) => { listeners.add(fn); return () => void listeners.delete(fn); };
export const getToasts = (): readonly ToastItem[] => list;

/** (Re)starts the 15 s countdown. */
export function resumeToast(id: number): void {
  clearTimeout(timers.get(id));
  timers.set(id, setTimeout(() => dismissToast(id), TIMEOUT_MS));
}
/** Hover: no countdown until resumeToast. */
export function pauseToast(id: number): void {
  clearTimeout(timers.get(id));
  timers.delete(id);
}
export function dismissToast(id: number): void {
  pauseToast(id);
  if (!list.some((x) => x.id === id)) return;
  list = list.filter((x) => x.id !== id);
  emit();
}

/** The same title and message again bumps ×N and restarts the timer (prototype: dedup key `title\nmsg`). */
export function toast(title: string, msg: string): void {
  const same = list.find((x) => x.title === title && x.msg === msg);
  if (same) {
    list = list.map((x) => (x === same ? { ...x, count: x.count + 1 } : x));
    resumeToast(same.id);
  } else {
    const item: ToastItem = { id: ++seq, title, msg, count: 1 };
    list = [...list, item];
    resumeToast(item.id);
    while (list.length > MAX) dismissToast(list[0].id);
  }
  emit();
}

/** Tests: drop everything and every timer. */
export function resetToasts(): void {
  for (const id of timers.keys()) clearTimeout(timers.get(id));
  timers.clear();
  list = [];
  emit();
}
