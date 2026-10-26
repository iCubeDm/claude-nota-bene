import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { cleanup, render } from '@testing-library/react';
import { Provider } from 'react-redux';
import { afterEach, describe, expect, it } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip.tsx';
import { setLang } from '@/i18n/index.ts';
import { makeStore, serverEvent } from '@/store/store.ts';
import { CommentCard } from '@/comments/CommentCard.tsx';
import { UserMessage } from '@/feed/UserMessage.tsx';
import { meterLevel } from '@/stats/Meters.tsx';

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const theme = read('../theme.css');
const markdownCss = read('../feed/markdown.css');

afterEach(cleanup);

/** oklch -> relative luminance (Ottosson's OKLab matrices), enough for a WCAG contrast ratio. */
function luminance(L: number, C: number, hDeg: number): number {
  const h = (hDeg * Math.PI) / 180;
  const a = C * Math.cos(h), b = C * Math.sin(h);
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const lin = [4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s, -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s, -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s]
    .map((v) => Math.min(1, Math.max(0, v)));
  return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
}
const contrast = (a: number, b: number) => (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);

describe('--nb-accent (R-M6-1)', () => {
  it('is the prototype orange and has a Tailwind token', () => {
    expect(theme).toMatch(/--nb-accent:\s*oklch\(0\.70 0\.20 60\)/);
    expect(theme).toMatch(/--color-nb-accent:\s*var\(--nb-accent\)/);
  });

  it("leaves shadcn's own accent as the grey hover background", () => {
    expect(theme).toMatch(/--color-accent:\s*var\(--muted\)/);
    expect(theme).toMatch(/--color-accent-foreground:\s*var\(--foreground\)/);
  });

  it('warn and the "working" tone resolve to the accent, not to the grey', () => {
    expect(theme).toMatch(/--color-warn:\s*var\(--nb-accent\)/);
  });

  it('is readable on the card and the page background (>= 3:1, non-text UI minimum)', () => {
    const accent = luminance(0.70, 0.20, 60);
    expect(contrast(accent, luminance(0.22, 0.02, 260))).toBeGreaterThanOrEqual(3); // card
    expect(contrast(accent, luminance(0.15, 0.02, 260))).toBeGreaterThanOrEqual(3); // background
  });

  it('the meter warn fill uses the accent token', () => {
    expect(meterLevel(70)).toBe('warn');
    expect(read('../stats/Meters.tsx')).toContain("warn: 'bg-nb-accent'");
  });
});

describe('accent uses', () => {
  it('comment card quote stripe is the accent, not the grey `accent`', () => {
    setLang('ru');
    const store = makeStore({ url: 'ws://x', connect: (() => ({ send: () => true, close() {} })) as never });
    store.dispatch(serverEvent({
      kind: 'comments',
      items: [{ id: 'c1', anchor: { source: { kind: 'message', id: 'a1' }, start: 0, end: 5, quote: 'brave', prefix: '', suffix: '' }, text: 't', status: 'pending', createdAt: 1 }],
    }));
    const { container } = render(<Provider store={store}><TooltipProvider><CommentCard id="c1" index={0} /></TooltipProvider></Provider>);
    const q = container.querySelector('.line-clamp-3')!;
    expect(q.className).toContain('border-nb-accent');
    expect(q.className).not.toMatch(/border-accent\b/);
  });

  it('user-bubble comment quote carries the accent stripe', () => {
    setLang('ru');
    const store = makeStore({ url: 'ws://x', connect: (() => ({ send: () => true, close() {} })) as never });
    store.dispatch(serverEvent({
      kind: 'comments',
      items: [{ id: 'c1', anchor: { source: { kind: 'message', id: 'u1' }, start: 0, end: 5, quote: 'brave', prefix: '', suffix: '' }, text: 't', status: 'sent', sentIn: 'u1', createdAt: 1 }],
    }));
    const item = { kind: 'user', id: 'u1', text: 'hello', ts: 0, historic: true } as never;
    const { container } = render(<Provider store={store}><TooltipProvider><UserMessage item={item} /></TooltipProvider></Provider>);
    const bq = container.querySelector('details blockquote');
    expect(bq?.className).toContain('border-nb-accent');
  });

  it('file-ref underline uses the accent; a mention is plain until hovered (as in the prototype)', () => {
    expect(markdownCss).toMatch(/\.ref\s*\{[^}]*underline dotted var\(--nb-accent\)/);
    expect(markdownCss).toMatch(/\.mention\.ref\s*\{[^}]*text-decoration:\s*none/);
    expect(markdownCss).toMatch(/\.mention\.ref:hover\s*\{[^}]*underline/);
  });

  it('markdown palette keeps the prototype values (links primary, inline code, blockquote, hljs theme)', () => {
    expect(markdownCss).toMatch(/\.md a \{ color: var\(--primary\)/);
    expect(markdownCss).toMatch(/\.md :not\(pre\) > code \{[^}]*color: oklch\(0\.72 0\.02 260\)/);
    expect(markdownCss).toMatch(/\.md blockquote \{ border-left: 2px solid var\(--border\)/);
    expect(read('../feed/Markdown.tsx')).toContain("highlight.js/styles/github-dark.min.css");
  });
});
