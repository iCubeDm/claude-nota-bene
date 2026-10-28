import { editable } from './editable.ts';

/**
 * The scope rule shared by the keys that belong to a media tab (markup mode, player keys): the event is ours when it
 * is a plain, finished keystroke, not typed into a text field, `pane` is visible, and focus is on nothing (body) or
 * somewhere `inside` accepts. `inside` is where the tab's own widgets live; everything else (chat, menus) keeps its keys.
 */
export function keysInScope(e: KeyboardEvent, pane: Element, inside: (focus: Element) => boolean): boolean {
  if (e.defaultPrevented || e.isComposing || editable(e.target) || pane.closest('[hidden]')) return false;
  const f = document.activeElement;
  return !f || f === document.body || inside(f);
}
