import { describe, expect, it } from 'vitest';
import type { AnchorSource } from '@nota-bene/shared';
import { CONTEXT, makeAnchor, resolveAnchor } from './resolve';

const src: AnchorSource = { kind: 'message', id: 'm1' };

describe('makeAnchor', () => {
  it('fills quote, prefix and suffix, clipped at the bounds', () => {
    const a = makeAnchor(src, 'hello brave new world', 6, 11);
    expect(a).toEqual({ source: src, start: 6, end: 11, quote: 'brave', prefix: 'hello ', suffix: ' new world' });
    const long = 'x'.repeat(100) + 'Q' + 'y'.repeat(100);
    const b = makeAnchor(src, long, 100, 101);
    expect(b.prefix).toHaveLength(CONTEXT);
    expect(b.suffix).toHaveLength(CONTEXT);
  });
  it('throws on bad offsets', () => {
    expect(() => makeAnchor(src, 'abc', 2, 1)).toThrow();
    expect(() => makeAnchor(src, 'abc', -1, 1)).toThrow();
    expect(() => makeAnchor(src, 'abc', 0, 4)).toThrow();
  });
});

describe('resolveAnchor', () => {
  it('exact position wins', () => {
    const text = 'one two one two';
    const a = makeAnchor(src, text, 8, 11);
    expect(resolveAnchor(a, text)).toEqual({ start: 8, end: 11 });
  });
  it('moved text is found by quote', () => {
    const text = 'alpha beta gamma';
    const a = makeAnchor(src, text, 6, 10);
    expect(resolveAnchor(a, 'INSERTED alpha beta gamma')).toEqual({ start: 15, end: 19 });
  });
  it('duplicate quotes are disambiguated by context', () => {
    const text = 'red cat sat. blue cat ran. green cat hid.';
    const start = text.indexOf('cat', 14);
    const a = makeAnchor(src, text, start, start + 3);
    const edited = 'NEW NEW NEW ' + text;
    const s = edited.indexOf('blue cat') + 5;
    expect(resolveAnchor(a, edited)).toEqual({ start: s, end: s + 3 });
  });
  it('tie goes to the hit nearest the original start', () => {
    const a = { source: src, start: 10, end: 11, quote: 'a', prefix: '--', suffix: '--' };
    const t = '--a--------a--';
    const r = resolveAnchor({ ...a, start: 9 }, t);
    expect(r).toEqual({ start: 11, end: 12 });
  });
  it('missing quote → null', () => {
    const a = makeAnchor(src, 'hello world', 0, 5);
    expect(resolveAnchor(a, 'goodbye world')).toBeNull();
  });
  it('ambiguous with zero context score → null; single occurrence accepted', () => {
    const a = { source: src, start: 0, end: 1, quote: 'a', prefix: 'QQ', suffix: 'QQ' };
    expect(resolveAnchor(a, 'xxaxxaxx')).toBeNull();
    expect(resolveAnchor(a, 'xxxxaxxx')).toEqual({ start: 4, end: 5 });
  });
  it('empty quote resolves only by exact position', () => {
    const a = { source: src, start: 2, end: 2, quote: '', prefix: '', suffix: '' };
    expect(resolveAnchor(a, 'abcd')).toEqual({ start: 2, end: 2 });
    expect(resolveAnchor(a, 'a')).toBeNull();
  });

  it('never returns a range whose text differs from quote (property)', () => {
    let seed = 12345;
    const rnd = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32);
    const int = (n: number) => Math.floor(rnd() * n);
    const alphabet = 'abc d';
    const word = (n: number) => Array.from({ length: n }, () => alphabet[int(alphabet.length)]).join('');
    let nonNull = 0;
    for (let i = 0; i < 3000; i++) {
      const base = word(20 + int(80));
      const s = int(base.length);
      const e = s + int(Math.min(8, base.length - s) + 1);
      const a = makeAnchor(src, base, s, e);
      let t = base;
      for (let k = 0, n = 1 + int(4); k < n; k++) {
        const p = int(t.length + 1);
        const op = int(4);
        if (op === 0) t = t.slice(0, p) + word(1 + int(6)) + t.slice(p);
        else if (op === 1) t = t.slice(0, p) + t.slice(p + 1 + int(6));
        else if (op === 2) t = t.slice(0, p) + a.quote + t.slice(p);
        else t = t.slice(0, p) + word(2) + a.quote + word(2) + t.slice(p);
      }
      const r = resolveAnchor(a, t);
      if (r) {
        nonNull++;
        expect(t.slice(r.start, r.end)).toBe(a.quote);
      }
    }
    expect(nonNull).toBeGreaterThan(0);
  });
});
