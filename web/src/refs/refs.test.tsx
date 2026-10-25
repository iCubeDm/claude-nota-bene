import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { Provider } from 'react-redux';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { textOf } from '@/anchors/text.ts';
import { Markdown } from '@/feed/Markdown.tsx';
import { UserMessage } from '@/feed/UserMessage.tsx';
import { setLang } from '@/i18n/index.ts';
import { makeStore } from '@/store/store.ts';
import { selectTabs } from '@/tabs/slice.ts';
import { clearRefCache, markRefs, refClick, splitMentions } from './refs.ts';

beforeEach(() => {
  setLang('en');
  clearRefCache();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.getSelection()?.removeAllRanges();
});

const div = (html: string) => {
  const d = document.createElement('div');
  d.innerHTML = html;
  return d;
};

it('marks project paths in code and relative links', () => {
  const d = div('<p><code>src/App.tsx</code> <a href="docs/a.md">x</a> <code>src/a.ts:42:7</code></p>');
  markRefs(d);
  const [c, c2] = d.querySelectorAll('code');
  expect(c.classList.contains('ref')).toBe(true);
  expect(c.dataset.path).toBe('src/App.tsx');
  expect(d.querySelector('a')!.dataset.path).toBe('docs/a.md');
  expect(c2.dataset.path).toBe('src/a.ts');
});

it('leaves commands, urls, anchors, absolute paths and code blocks alone', () => {
  const d = div(
    '<code>npm test</code> <code>https://a.b/c.md</code>' +
      '<a href="https://x.y/z">h</a><a href="mailto:a@b.c">m</a><a href="#top">t</a><a href="file:///etc/x">f</a><a href="/abs.md">a</a>' +
      '<pre><code>src/in/block.ts</code></pre>',
  );
  markRefs(d);
  expect(d.querySelectorAll('.ref').length).toBe(0);
});

it('marks a backticked path with spaces and symbols, but not a bare command', () => {
  const d = div('<code>docs/Отчёт #1 (final).md</code> <code>npm test</code>');
  markRefs(d);
  const [a, b] = d.querySelectorAll('code');
  expect(a.dataset.path).toBe('docs/Отчёт #1 (final).md');
  expect(b.classList.contains('ref')).toBe(false);
});

it('resolves against baseDir, strips fragment and query, refuses to leave the root', () => {
  const d = div('<a href="../b.md#s">1</a><a href="c.md?x=1">2</a><code>./d.ts</code><a href="../../../x.md">3</a>');
  markRefs(d, 'docs/sub');
  const p = [...d.querySelectorAll<HTMLElement>('a, code')].map((e) => e.dataset.path);
  expect(p).toEqual(['docs/b.md', 'docs/sub/c.md', 'docs/sub/d.ts', undefined]);
});

it('does not change the text that comment anchors read', () => {
  const d = div('<p>see <code>src/a.ts</code> and <a href="docs/a.md">the doc</a>.</p>');
  const before = textOf(d);
  markRefs(d);
  expect(textOf(d)).toBe(before);
});

it('Markdown marks refs only in the final render', () => {
  const { container, rerender } = render(<Markdown text="open `src/a.ts`" final={false} />);
  expect(container.querySelector('.ref')).toBeNull();
  rerender(<Markdown text="open `src/a.ts`" final />);
  expect(container.querySelector('code.ref')).not.toBeNull();
});

it('splitMentions finds quoted and plain mentions and keeps the other text', () => {
  expect(splitMentions('see @"a b.md" and @x/y')).toEqual([
    { text: 'see ' },
    { mention: 'a b.md' },
    { text: ' and ' },
    { mention: 'x/y' },
  ]);
  expect(splitMentions('mail me@x.io')).toEqual([{ text: 'mail me@x.io' }]);
});

function setup(ui: (store: ReturnType<typeof makeStore>) => React.ReactElement) {
  const store = makeStore({ url: 'ws://x', connect: () => ({ send: () => true, close() {} }) });
  render(<Provider store={store}>{ui(store)}</Provider>);
  return store;
}
const Box = ({ store, html }: { store: ReturnType<typeof makeStore>; html: string }) => (
  <div data-testid="box" onClick={(e) => refClick(e, store.dispatch)} dangerouslySetInnerHTML={{ __html: html }} />
);
const tick = () => new Promise((r) => setTimeout(r, 0));

it('a click opens an existing file as a tab, and the HEAD result is cached', async () => {
  const fetchMock = vi.fn(async () => ({ ok: true }));
  vi.stubGlobal('fetch', fetchMock);
  const store = setup((s) => <Box store={s} html='<code class="ref" data-path="src/a.ts">src/a.ts</code>' />);
  const el = screen.getByText('src/a.ts');
  fireEvent.click(el);
  await tick();
  fireEvent.click(el);
  await tick();
  expect(selectTabs(store.getState()).open.map((t) => t.id)).toContain('file:src/a.ts');
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

it('a click with a non-collapsed selection does nothing', async () => {
  const fetchMock = vi.fn(async () => ({ ok: true }));
  vi.stubGlobal('fetch', fetchMock);
  const store = setup((s) => <Box store={s} html='<code class="ref" data-path="src/a.ts">src/a.ts</code>' />);
  const el = screen.getByText('src/a.ts');
  const r = document.createRange();
  r.selectNodeContents(el);
  window.getSelection()!.addRange(r);
  fireEvent.click(el);
  await tick();
  expect(fetchMock).not.toHaveBeenCalled();
  expect(selectTabs(store.getState()).open.length).toBe(1);
});

it('a missing file gets .missing and a title', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false })));
  setup((s) => <Box store={s} html='<code class="ref" data-path="gone.ts">gone.ts</code>' />);
  const el = screen.getByText('gone.ts');
  fireEvent.click(el);
  await tick();
  expect(el.classList.contains('missing')).toBe(true);
  expect(el.title).toBe('no such file in the project');
});

it('relative links never navigate, but a modifier click keeps the browser default', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true })));
  setup((s) => <Box store={s} html='<a class="ref" data-path="docs/a.md" href="docs/a.md">d</a>' />);
  const a = screen.getByText('d');
  expect(fireEvent.click(a)).toBe(false); // default prevented
  expect(fireEvent.click(a, { metaKey: true })).toBe(true);
});

it('user @mentions are clickable and keep the message text identical', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true })));
  const text = 'look at @src/a.ts and @"my doc.md" please';
  const store = makeStore({ url: 'ws://x', connect: () => ({ send: () => true, close() {} }) });
  const root = render(
    <Provider store={store}>
      <div onClick={(e) => refClick(e, store.dispatch)}>
        <UserMessage item={{ kind: 'user', id: 'u1', text, ts: 0 } as never} />
      </div>
    </Provider>,
  ).container;
  const msg = root.querySelector<HTMLElement>('[data-kind="user"]')!;
  expect(textOf(msg)).toContain(text);
  const ms = msg.querySelectorAll<HTMLElement>('.mention');
  expect([...ms].map((m) => m.dataset.path)).toEqual(['src/a.ts', 'my doc.md']);
  fireEvent.click(ms[1]);
  await tick();
  expect(selectTabs(store.getState()).open.map((t) => t.id)).toContain('file:my doc.md');
});
