/**
 * Centres a range in its pane's scroll element by the range's own rect. Scrolling an ancestor element into view
 * (the M1 way) lands in the middle of the file when the fragment's parent is a whole plain `<code>` block.
 */
export function scrollRangeIntoView(range: Range, scroller: HTMLElement, behavior: ScrollBehavior = 'smooth') {
  const r = range.getBoundingClientRect();
  const b = scroller.getBoundingClientRect();
  const top = scroller.scrollTop + r.top - b.top - scroller.clientHeight / 2 + r.height / 2;
  scroller.scrollTo({ top: Math.max(0, top), behavior });
}
