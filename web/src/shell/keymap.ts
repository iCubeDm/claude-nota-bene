import { setPanelOpen } from '@/comments/slice.ts';
import { recentModal } from '@/files/recent.ts';
import type { ru } from '@/i18n/ru.ts';
import type { AppStore } from '@/store/store.ts';
import { activate, closeTab, reopenClosed } from '@/tabs/slice.ts';
import { revealFile, setTreeOpen } from '@/tree/slice.ts';

/**
 * The app's global hotkeys (M6-14, R-M6-5): the ONE document listener for them. Chrome keeps Cmd/Ctrl+W/T/1-9 and
 * Ctrl+Tab, so tabs go on Alt. Matching is by `code` (Alt on a Mac turns `key` into ∑, †…).
 *
 * Rules:
 * - it listens in the bubble phase and skips an event something already handled (`defaultPrevented`): popups, pickers
 *   and dialogs see their keys first (the Esc protocol);
 * - in a text field (input, textarea, contenteditable) the Alt and Cmd/Ctrl bindings work, but not Alt+←/→ (a Mac
 *   field's word jump) and not the plain keys (`/`, Esc);
 * - nothing runs while an IME composes.
 */
export type Mods = { mod?: boolean; alt?: boolean; shift?: boolean };
type Ctx = { store: AppStore; e: KeyboardEvent };
export type Binding = {
  id: keyof typeof ru & `hk_${string}`;
  /** `code`s that trigger it (`Digit1`…). */
  codes: string[];
  mods: Mods;
  /** also when focus is in a text field */
  inFields: boolean;
  run: (c: Ctx) => void;
};

export const isMac = () => typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

const editable = (t: EventTarget | null): boolean => {
  const el = t as HTMLElement | null;
  if (!el || !el.closest) return false;
  return !!el.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"]');
};

const tabAt = (store: AppStore, i: number) => {
  const { open } = store.getState().tabs;
  return open[Math.max(0, Math.min(open.length - 1, i))]?.id;
};
const step = (store: AppStore, by: number) => {
  const { open, active } = store.getState().tabs;
  const i = open.findIndex((t) => t.id === active);
  return open[(i + by + open.length) % open.length]?.id;
};
const focusComposer = () => (document.getElementById('composer-input') as HTMLTextAreaElement | null)?.focus();

export const BINDINGS: Binding[] = [
  { id: 'hk_closeTab', codes: ['KeyW'], mods: { alt: true }, inFields: true,
    run: ({ store }) => { const { active } = store.getState().tabs; if (active !== 'chat') store.dispatch(closeTab(active)); } },
  { id: 'hk_reopenTab', codes: ['KeyT'], mods: { alt: true, shift: true }, inFields: true, run: ({ store }) => void store.dispatch(reopenClosed()) },
  { id: 'hk_prevTab', codes: ['ArrowLeft'], mods: { alt: true }, inFields: false, run: ({ store }) => { const id = step(store, -1); if (id) store.dispatch(activate(id)); } },
  { id: 'hk_nextTab', codes: ['ArrowRight'], mods: { alt: true }, inFields: false, run: ({ store }) => { const id = step(store, 1); if (id) store.dispatch(activate(id)); } },
  // 1 = the chat … 8 = the eighth tab; 9 = the last one (as in Chrome)
  { id: 'hk_tabN', codes: ['Digit1', 'Digit2', 'Digit3', 'Digit4', 'Digit5', 'Digit6', 'Digit7', 'Digit8', 'Digit9'], mods: { alt: true }, inFields: true,
    run: ({ store, e }) => {
      const n = Number(e.code.slice(5));
      const id = n === 9 ? tabAt(store, Infinity) : store.getState().tabs.open[n - 1]?.id;
      if (id) store.dispatch(activate(id));
    } },
  { id: 'hk_recent', codes: ['KeyE'], mods: { mod: true }, inFields: true, run: () => (recentModal.get() ? recentModal.close() : recentModal.open()) },
  { id: 'hk_files', codes: ['KeyF'], mods: { mod: true, shift: true }, inFields: true, run: ({ store }) => void store.dispatch(setTreeOpen(!store.getState().tree.open)) },
  { id: 'hk_comments', codes: ['KeyC'], mods: { mod: true, shift: true }, inFields: true,
    run: ({ store }) => void store.dispatch(setPanelOpen(!store.getState().comments.ui.panelOpen)) },
  { id: 'hk_reveal', codes: ['F1'], mods: { alt: true }, inFields: true,
    run: ({ store }) => {
      const st = store.getState();
      const tab = st.tabs.open.find((t) => t.id === st.tabs.active);
      if (tab?.kind === 'file') store.dispatch(revealFile(tab.path, tab.src));
    } },
  { id: 'hk_composer', codes: ['Slash', 'Escape'], mods: {}, inFields: false,
    run: ({ e }) => {
      // Esc only on empty space: not inside a dialog, menu or other widget that may want it
      if (e.code === 'Escape' && (e.target as HTMLElement | null)?.closest?.('[role="dialog"], [role="menu"], [role="listbox"]')) return;
      focusComposer();
    } },
];

const matches = (b: Binding, e: KeyboardEvent): boolean => {
  if (!b.codes.includes(e.code)) return false;
  const mod = isMac() ? e.metaKey : e.ctrlKey;
  const other = isMac() ? e.ctrlKey : e.metaKey;
  // `/` on some layouts needs Shift: the plain keys ignore Shift
  const shiftOk = b.mods.mod || b.mods.alt ? e.shiftKey === !!b.mods.shift : true;
  return mod === !!b.mods.mod && e.altKey === !!b.mods.alt && shiftOk && !other;
};

/** Installs the one listener; returns its removal. */
export function installKeymap(store: AppStore): () => void {
  const onKey = (e: KeyboardEvent) => {
    // a held key repeats only the tab stepping
    if (e.defaultPrevented || e.isComposing || (e.repeat && e.code !== 'ArrowLeft' && e.code !== 'ArrowRight')) return;
    const b = BINDINGS.find((x) => matches(x, e));
    if (!b || (!b.inFields && editable(e.target))) return;
    // Esc keeps its other meaning (stop the agent, Composer's own listener): it is not consumed here
    if (e.code !== 'Escape') e.preventDefault();
    b.run({ store, e });
  };
  document.addEventListener('keydown', onKey);
  return () => document.removeEventListener('keydown', onKey);
}

/** The keys of a binding as the platform shows them, for the help. */
export function keysLabel(b: Binding): string {
  const mac = isMac();
  const parts: string[] = [];
  if (b.mods.mod) parts.push(mac ? '⌘' : 'Ctrl+');
  if (b.mods.alt) parts.push(mac ? '⌥' : 'Alt+');
  if (b.mods.shift) parts.push(mac ? '⇧' : 'Shift+');
  const key = (c: string) => ({ ArrowLeft: '←', ArrowRight: '→', Slash: '/', Escape: 'Esc' } as Record<string, string>)[c] ?? c.replace(/^(Key|Digit)/, '');
  const keys = b.id === 'hk_tabN' ? '1…9' : b.codes.map(key).join(', ');
  return parts.join('') + keys;
}
