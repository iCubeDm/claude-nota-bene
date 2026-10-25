const GAP = 6; // between the field and the list
const EDGE = 8; // kept free at the window edge

type Rect = { top: number; bottom: number; left: number };

/**
 * Where a picker list goes next to its field: above when its natural height `h` fits there, else on the side with
 * more room. `maxHeight` caps it to that side, so the list never leaves the window (a list below the composer used to
 * push the document into scrolling).
 */
export function placeList(r: Rect, w: number, h: number, vw: number, vh: number): { left: number; top: number; maxHeight: number } {
  const above = r.top - GAP - EDGE;
  const below = vh - r.bottom - GAP - EDGE;
  const up = h <= above || above >= below;
  const maxHeight = Math.max(0, Math.min(h, up ? above : below));
  return { left: Math.max(EDGE, Math.min(r.left, vw - w - EDGE)), top: up ? r.top - GAP - maxHeight : r.bottom + GAP, maxHeight };
}

/** The list's own `scrollTop` for `el` to be fully visible in it; element.scrollIntoView would also scroll the document. */
export function scrollTopFor(top: number, height: number, scrollTop: number, clientHeight: number): number {
  if (top < scrollTop) return top;
  if (top + height > scrollTop + clientHeight) return top + height - clientHeight;
  return scrollTop;
}

/**
 * Measures and places `list` next to `field`, in viewport terms. The inline max-height is cleared first, so the measure is the
 * CSS-capped natural height, then set to the room on the chosen side. Imperative on purpose: a React style prop
 * would not re-apply an unchanged value after the clear.
 */
export function placeListFor(list: HTMLElement, field: HTMLElement): { left: number; top: number } {
  list.style.maxHeight = '';
  const p = placeList(field.getBoundingClientRect(), list.offsetWidth, list.offsetHeight, window.innerWidth, window.innerHeight);
  list.style.maxHeight = `${p.maxHeight}px`;
  // an ancestor with backdrop-filter or transform (the footer's blur) is the containing block of a position:fixed
  // element, so `top`/`left` are relative to it, not to the viewport: subtract its origin, read off where the list
  // sits now against its current style
  const now = list.getBoundingClientRect();
  const ox = now.left - (parseFloat(list.style.left) || 0);
  const oy = now.top - (parseFloat(list.style.top) || 0);
  return { left: p.left - ox, top: p.top - oy };
}

/** Scrolls the list (only the list) so its `aria-selected` option is in view. */
export function revealSelected(list: HTMLElement): void {
  const el = list.querySelector<HTMLElement>('[aria-selected="true"]');
  if (!el) return;
  // the list is position:fixed, so it is the option's offsetParent
  list.scrollTop = scrollTopFor(el.offsetTop, el.offsetHeight, list.scrollTop, list.clientHeight);
}
