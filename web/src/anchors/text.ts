// The only code that maps DOM ranges to anchor offsets. "Rendered text" is the
// root's visible text with every whitespace run collapsed to one space and the
// ends trimmed; script/style/aria-hidden/[data-anchor-skip] subtrees are skipped. All three
// functions share one model (`build`), so round-trips are exact.

type Pt = [Text, number];
type Entry = {
  node: Text;
  start: number; // normalised offset of this node's first emitted char (clamped to total)
  map: number[]; // raw offset i (0..len) -> normalised offset before char i
};

// slots[k] describes normalised char k: where a range starting at k begins and
// where a range ending after k ends. Real chars point into their own text node;
// a block-boundary space points at the end of the previous node / start of the next.
type Slot = { from: Pt; to: Pt };
type Model = { entries: Entry[]; slots: Slot[]; total: number; text: string };

const WS = /[\s\u00a0]/;
const BLOCKS = new Set([
  'p', 'li', 'div', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'pre', 'blockquote',
  'tr', 'td', 'th', 'ul', 'ol', 'table', 'section', 'hr', 'br',
]);

function build(root: Element): Model {
  const entries: Entry[] = [];
  const slots: Slot[] = [];
  let text = '';
  let pending = false; // a block boundary is waiting to become a space
  let last: Entry | null = null;

  const visitText = (node: Text) => {
    const data = node.data;
    const entry: Entry = { node, start: -1, map: [] };
    for (let i = 0; i < data.length; i++) {
      if (WS.test(data[i])) {
        entry.map.push(text.length);
        if (text.length === 0 || text.endsWith(' ')) continue;
        if (entry.start < 0) entry.start = text.length;
        text += ' ';
        slots.push({ from: [node, i], to: [node, i + 1] });
        pending = false;
      } else {
        if (pending && text.length > 0 && !text.endsWith(' ') && last) {
          text += ' ';
          slots.push({ from: [last.node, last.node.data.length], to: [node, 0] });
        }
        pending = false;
        entry.map.push(text.length);
        if (entry.start < 0) entry.start = text.length;
        text += data[i];
        slots.push({ from: [node, i], to: [node, i + 1] });
      }
    }
    entry.map.push(text.length);
    if (entry.start < 0) entry.start = text.length;
    entries.push(entry);
    last = entry;
  };

  const visit = (el: Element) => {
    for (const child of Array.from(el.childNodes)) {
      if (child.nodeType === Node.TEXT_NODE) visitText(child as Text);
      else if (child.nodeType === Node.ELEMENT_NODE) {
        const e = child as Element;
        const tag = e.tagName.toLowerCase();
        if (tag === 'script' || tag === 'style' || e.getAttribute('aria-hidden') === 'true' || e.hasAttribute('data-anchor-skip')) continue;
        const block = BLOCKS.has(tag);
        if (block) pending = true;
        visit(e);
        if (block) pending = true;
      }
    }
  };
  visit(root);

  if (text.endsWith(' ')) {
    text = text.slice(0, -1);
    slots.pop();
  }
  const total = text.length;
  for (const e of entries) {
    e.start = Math.min(e.start, total);
    for (let i = 0; i < e.map.length; i++) e.map[i] = Math.min(e.map[i], total);
  }
  return { entries, slots, total, text };
}

export function textOf(root: Element): string {
  return build(root).text;
}

// Normalised offset of a DOM boundary point, or null if outside root.
function pointOffset(root: Element, m: Model, container: Node, offset: number): number | null {
  if (!root.contains(container)) return null;
  if (container.nodeType === Node.TEXT_NODE) {
    const e = m.entries.find((x) => x.node === container);
    if (e) return e.map[Math.min(offset, e.map.length - 1)];
  }
  // Element boundary (or text in a skipped subtree): the point sits just before
  // `ref` in document order; take the start of the first included text after it.
  let ref: Node | null = container;
  if (container.nodeType !== Node.TEXT_NODE) {
    ref = container.childNodes[offset] ?? null;
  }
  if (ref) {
    for (const e of m.entries) {
      if (e.node === ref || ref.contains(e.node)) return e.start;
      if (ref.compareDocumentPosition(e.node) & Node.DOCUMENT_POSITION_FOLLOWING) return e.start;
    }
    return m.total;
  }
  // Point at the end of `container`: after its last included descendant.
  let last: Entry | undefined;
  for (const e of m.entries) {
    if (container.contains(e.node)) last = e;
    else if (container.compareDocumentPosition(e.node) & Node.DOCUMENT_POSITION_FOLLOWING) {
      return last ? last.map[last.map.length - 1] : e.start;
    }
  }
  return last ? last.map[last.map.length - 1] : m.total;
}

export function offsetsOf(root: Element, range: Range): { start: number; end: number } | null {
  const m = build(root);
  const start = pointOffset(root, m, range.startContainer, range.startOffset);
  const end = pointOffset(root, m, range.endContainer, range.endOffset);
  if (start === null || end === null) return null;
  return { start, end: Math.max(start, end) };
}

export function rangeFromOffsets(root: Element, start: number, end: number): Range | null {
  if (!Number.isInteger(start) || !Number.isInteger(end)) return null;
  const m = build(root);
  if (start < 0 || end > m.total || start > end) return null;
  const range = root.ownerDocument.createRange();
  if (m.total === 0) {
    range.setStart(root, 0);
    range.setEnd(root, 0);
    return range;
  }
  const from = (k: number): Pt => m.slots[k].from;
  const to = (k: number): Pt => m.slots[k].to;
  if (start === end) {
    const [n, i] = start < m.total ? from(start) : to(start - 1);
    range.setStart(n, i);
    range.setEnd(n, i);
    return range;
  }
  const [sn, si] = from(start);
  const [en, ei] = to(end - 1);
  range.setStart(sn, si);
  range.setEnd(en, ei);
  return range;
}
