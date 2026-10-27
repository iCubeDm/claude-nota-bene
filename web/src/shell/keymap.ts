import { setPanelOpen } from '@/comments/slice.ts';
import { recentModal } from '@/files/recent.ts';
import type { ru } from '@/i18n/ru.ts';
import { selectConn, type AppStore } from '@/store/store.ts';
import { activate, closeTab, reopenClosed } from '@/tabs/slice.ts';
import { revealFile, setTreeOpen } from '@/tree/slice.ts';
import { editable } from '@/lib/editable.ts';

/**
 * The app's global hotkeys (M6-14, R-M6-5): the ONE document listener for them. Chrome keeps Cmd/Ctrl+W/T/1-9 and
 * Ctrl+Tab, so tabs go on Alt. Matching is by `code` (Alt on a Mac turns `key` into ∑, †…).
 *
 * Rules:
 * - it listens in the bubble phase and skips an event something already handled (`defaultPrevented`): popups, pickers
 *   and dialogs see their keys first (the Esc protocol);
 * - in a text field (input, textarea, any contenteditable) the Cmd/Ctrl bindings and Alt+F1 work. Alt+letter/digit
 *   work there only off a Mac: on a Mac, Option+key types characters (German, French, Nordic layouts type [ ] { } | that
 *   way), so in a field they type. Alt+←/→ (a field's word jump) and the plain keys (`/`, Esc) never fire in a field;
 * - while a modal dialog is open, only Alt+E (it toggles its own dialog) runs: the tabs behind the overlay stay put;
 * - `/` is matched by the character typed (`key`), so it follows the keyboard layout; the rest by `code`;
 * - nothing runs while an IME composes.
 */
export type Mods = { mod?: boolean; alt?: boolean; shift?: boolean };
type Ctx = { store: AppStore; e: KeyboardEvent };
export type Binding = {
  id: keyof typeof ru & `hk_${string}`;
  /** `code`s that trigger it (`Digit1`…). */
  codes: string[];
  mods: Mods;
  /** also when focus is in a text field; 'notMac': only off a Mac (Option+key types a character there) */
  inFields: boolean | 'notMac';
  run: (c: Ctx) => void;
};

export const isMac = () => typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);


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
  { id: 'hk_closeTab', codes: ['KeyW'], mods: { alt: true }, inFields: 'notMac',
    run: ({ store }) => { const { active } = store.getState().tabs; if (active !== 'chat') store.dispatch(closeTab(active)); } },
  { id: 'hk_reopenTab', codes: ['KeyT'], mods: { alt: true, shift: true }, inFields: 'notMac', run: ({ store }) => void store.dispatch(reopenClosed()) },
  { id: 'hk_prevTab', codes: ['ArrowLeft'], mods: { alt: true }, inFields: false, run: ({ store }) => { const id = step(store, -1); if (id) store.dispatch(activate(id)); } },
  { id: 'hk_nextTab', codes: ['ArrowRight'], mods: { alt: true }, inFields: false, run: ({ store }) => { const id = step(store, 1); if (id) store.dispatch(activate(id)); } },
  // 1 = the chat … 8 = the eighth tab; 9 = the last one (as in Chrome)
  { id: 'hk_tabN', codes: ['Digit1', 'Digit2', 'Digit3', 'Digit4', 'Digit5', 'Digit6', 'Digit7', 'Digit8', 'Digit9'], mods: { alt: true }, inFields: 'notMac',
    run: ({ store, e }) => {
      const n = Number(e.code.slice(5));
      const id = n === 9 ? tabAt(store, Infinity) : store.getState().tabs.open[n - 1]?.id;
      if (id) store.dispatch(activate(id));
    } },
  // Alt+E, not Cmd/Ctrl+E: Claude in Chrome takes ⌘E (the user, 2026-10-27). In a field too, also on a Mac: there
  // Option+E is the ´ dead key, which the binding consumes (recent files from the composer is the common case)
  { id: 'hk_recent', codes: ['KeyE'], mods: { alt: true }, inFields: true, run: () => (recentModal.get() ? recentModal.close() : recentModal.open()) },
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
  // `/` by the character (a Russian PC layout types it with Shift+7; the US Slash key types "." there)
  const hit = b.codes.includes(e.code) && e.code !== 'Slash' || (b.codes.includes('Slash') && e.key === '/');
  if (!hit) return false;
  const mod = isMac() ? e.metaKey : e.ctrlKey;
  const other = isMac() ? e.ctrlKey : e.metaKey;
  // a plain `/` may need Shift on the layout: the plain keys ignore Shift
  const shiftOk = b.mods.mod || b.mods.alt ? e.shiftKey === !!b.mods.shift : true;
  // AltGr reports Ctrl+Alt off a Mac: never one of ours
  return mod === !!b.mods.mod && e.altKey === !!b.mods.alt && shiftOk && !other;
};
const inField = (b: Binding) => b.inFields === true || (b.inFields === 'notMac' && !isMac());
// Radix sets no aria-modal (and a popover is role=dialog too): our modals carry data-nb-modal
const modalOpen = () => !!document.querySelector('[data-nb-modal]');

/** Installs the one listener; returns its removal. */
export function installKeymap(store: AppStore): () => void {
  const onKey = (e: KeyboardEvent) => {
    // a held key repeats only the tab stepping
    if (e.defaultPrevented || e.isComposing || (e.repeat && e.code !== 'ArrowLeft' && e.code !== 'ArrowRight')) return;
    // the overlay of another-tab / taken makes the DOM inert, the document hotkeys must not reach under it either
    const conn = selectConn(store.getState());
    if (conn === 'occupied' || conn === 'taken') return;
    const b = BINDINGS.find((x) => matches(x, e));
    if (!b || (!inField(b) && editable(e.target))) return;
    if (b.id !== 'hk_recent' && modalOpen()) return;
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
