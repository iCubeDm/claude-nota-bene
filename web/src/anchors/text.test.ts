import { describe, expect, it } from 'vitest';
import { makeAnchor } from './resolve';
import { collapsedLength, offsetsOf, rangeForAnchor, rangeFromOffsets, rawIndexOf, textOf } from './text';

function el(html: string): HTMLElement {
  const root = document.createElement('div');
  root.innerHTML = html;
  document.body.appendChild(root);
  return root;
}

describe('anchor text model', () => {
  it('textOf collapses whitespace across elements', () => {
    const root = el('  <p>Hello\n  <b>big</b>   world</p>\n<p>\tnext </p> ');
    expect(textOf(root)).toBe('Hello big world next');
  });

  it('skips script, style and aria-hidden text', () => {
    const root = el('<p>a<span aria-hidden="true">X</span><script>y</script><style>z</style>b</p>');
    expect(textOf(root)).toBe('ab');
    const r = rangeFromOffsets(root, 0, 2)!;
    expect(offsetsOf(root, r)).toEqual({ start: 0, end: 2 });
  });

  it('skips [data-anchor-skip] subtrees', () => {
    const root = el('<div><div data-anchor-skip>you · 14:03</div>hello</div>');
    expect(textOf(root)).toBe('hello');
  });

  it('offsetsOf and rangeFromOffsets round-trip across bold, code and links', () => {
    const root = el('<p>Use <b>the</b>  <code>foo()</code> call, see <a href="#">docs\n here</a>.</p>');
    const text = textOf(root);
    expect(text).toBe('Use the foo() call, see docs here.');
    for (let s = 0; s <= text.length; s++) {
      for (let e = s; e <= text.length; e++) {
        const r = rangeFromOffsets(root, s, e)!;
        expect(r).not.toBeNull();
        expect(offsetsOf(root, r)).toEqual({ start: s, end: e });
        if (s < e) expect(r.toString().replace(/\s+/g, ' ').trim()).toBe(text.slice(s, e).trim());
      }
    }
  });

  it('handles a range ending at an element boundary', () => {
    const root = el('<p>run <code>npm i</code> now</p>');
    const code = root.querySelector('code')!;
    const r = document.createRange();
    r.setStart(root.querySelector('p')!.firstChild!, 0);
    r.setEnd(code, code.childNodes.length);
    expect(offsetsOf(root, r)).toEqual({ start: 0, end: 9 });
    const r2 = document.createRange();
    r2.selectNodeContents(root);
    expect(offsetsOf(root, r2)).toEqual({ start: 0, end: textOf(root).length });
  });

  it('offsetsOf returns null for a range outside root', () => {
    const root = el('<p>inside</p>');
    const other = el('<p>outside</p>');
    const r = document.createRange();
    r.selectNodeContents(other);
    expect(offsetsOf(root, r)).toBeNull();
    const straddle = document.createRange();
    straddle.setStart(root.firstChild!.firstChild!, 2);
    straddle.setEnd(other.firstChild!.firstChild!, 2);
    expect(offsetsOf(root, straddle)).toBeNull();
  });

  it('rangeFromOffsets returns null out of bounds, collapsed when equal', () => {
    const root = el('<p>abc</p>');
    expect(rangeFromOffsets(root, 0, 4)).toBeNull();
    expect(rangeFromOffsets(root, -1, 2)).toBeNull();
    expect(rangeFromOffsets(root, 2, 1)).toBeNull();
    const c = rangeFromOffsets(root, 1, 1)!;
    expect(c.collapsed).toBe(true);
    expect(offsetsOf(root, c)).toEqual({ start: 1, end: 1 });
  });

  it('block boundaries and <br> separate words (R7)', () => {
    expect(textOf(el('<p>one</p><p>two</p>'))).toBe('one two');
    expect(textOf(el('<ul>\n<li>a</li><li>b</li>\n</ul>'))).toBe('a b');
    expect(textOf(el('x<br>y<br> z'))).toBe('x y z');
    expect(textOf(el('<p>one </p> <p> two</p>tail'))).toBe('one two tail');
    expect(textOf(el('<p>a<b>b</b></p>'))).toBe('ab');
  });

  it('round-trips exactly with block boundaries', () => {
    const root = el('<h1>Title</h1>\n<p>one <b>two</b><br>three</p><ul><li>a</li><li>b c</li></ul>tail ');
    const text = textOf(root);
    expect(text).toBe('Title one two three a b c tail');
    for (let s = 0; s <= text.length; s++) {
      for (let e = s; e <= text.length; e++) {
        const r = rangeFromOffsets(root, s, e)!;
        expect(offsetsOf(root, r)).toEqual({ start: s, end: e });
      }
    }
  });

  it('element-boundary points stay within bounds and round-trip', () => {
    for (const html of [
      '<ul>\n<li>a</li>\n</ul>\n',
      '\n<p>a</p>\n<p>b</p>\n\n',
      '  <b>x</b> \n <i>y</i>  ',
      '<p>a</p><script>q</script> \n',
    ]) {
      const root = el(html);
      const total = textOf(root).length;
      for (let i = 0; i <= root.childNodes.length; i++) {
        const r = document.createRange();
        r.setStart(root, i);
        r.setEnd(root, i);
        const o = offsetsOf(root, r)!;
        expect(o.start).toBeGreaterThanOrEqual(0);
        expect(o.start).toBeLessThanOrEqual(o.end);
        expect(o.end).toBeLessThanOrEqual(total);
        const back = rangeFromOffsets(root, o.start, o.end)!;
        expect(back).not.toBeNull();
        expect(offsetsOf(root, back)).toEqual(o);
      }
    }
  });

  it('raw boundaries inside whitespace runs and edge whitespace nodes', () => {
    const root = el('<p>   lead</p><p>mid  \n  dle</p><p>tail   </p>');
    const [p1, p2, p3] = Array.from(root.querySelectorAll('p')).map((p) => p.firstChild as Text);
    const at = (n: Text, a: number, b: number) => {
      const r = document.createRange();
      r.setStart(n, a);
      r.setEnd(n, b);
      return offsetsOf(root, r)!;
    };
    expect(textOf(root)).toBe('lead mid dle tail');
    expect(at(p1, 1, 5)).toEqual({ start: 0, end: 2 }); // from inside leading whitespace
    expect(at(p1, 0, 3)).toEqual({ start: 0, end: 0 });
    expect(at(p2, 4, 6)).toEqual({ start: 9, end: 9 }); // inside the whitespace run
    expect(at(p2, 3, 8)).toEqual({ start: 8, end: 9 });
    const t = textOf(root).length;
    expect(at(p3, 5, 7)).toEqual({ start: t, end: t }); // inside trailing whitespace
    expect(at(p3, 0, 7)).toEqual({ start: 13, end: t });
  });
});

describe('rangeForAnchor', () => {
  const src = { kind: 'message' as const, id: 'm1' };
  it('maps an exact anchor to the same range as rangeFromOffsets', () => {
    const root = el('<p>alpha <b>beta</b> gamma</p>');
    const a = makeAnchor(src, textOf(root), 6, 10);
    const r = rangeForAnchor(root, a)!;
    expect(r.toString()).toBe('beta');
    const ref = rangeFromOffsets(root, 6, 10)!;
    expect([r.startContainer, r.startOffset, r.endContainer, r.endOffset]).toEqual([ref.startContainer, ref.startOffset, ref.endContainer, ref.endOffset]);
  });
  it('follows the quote when the text before it changed', () => {
    const root = el('<p>alpha beta gamma</p>');
    const a = makeAnchor(src, textOf(root), 6, 10);
    root.innerHTML = '<p>a longer alpha beta gamma</p>';
    expect(rangeForAnchor(root, a)!.toString()).toBe('beta');
  });
  it('returns null when the quote is gone', () => {
    const root = el('<p>alpha beta gamma</p>');
    const a = makeAnchor(src, textOf(root), 6, 10);
    root.innerHTML = '<p>nothing here</p>';
    expect(rangeForAnchor(root, a)).toBeNull();
  });
});

describe('the whitespace rule on a plain string (tool panels, M7-17)', () => {
  const cases = ['a  b', '  lead and trail \n\t ', 'x\n\n\ny\t\tz', '\u00a0nb\u00a0\u00a0sp\u00a0', 'one', '', '   ', 'a \u00a0\n b'];
  it.each(cases.map((c) => [JSON.stringify(c), c]))('matches the DOM model on %s', (_n, raw) => {
    const root = document.createElement('div');
    const pre = document.createElement('pre');
    pre.textContent = raw;
    root.appendChild(pre);
    document.body.appendChild(root);
    const text = textOf(root);
    expect(collapsedLength(raw)).toBe(text.length);
    // every collapsed char starts at the same raw index in both
    for (let n = 0; n < text.length; n++) expect(rawIndexOf(raw, n)).toBe(rangeFromOffsets(root, n, n + 1)!.startOffset);
    expect(rawIndexOf(raw, text.length + 5)).toBe(raw.length);
    root.remove();
  });
});
