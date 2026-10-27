import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Provider } from 'react-redux';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ServerEvent } from '@nota-bene/shared';
import { setLang } from '@/i18n/index.ts';
import { makeStore, serverEvent } from '@/store/store.ts';
import { Feed } from './Feed.tsx';

beforeEach(() => setLang('en'));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const session: ServerEvent = { kind: 'session', id: 's1', root: '/p', title: null, model: null };
const marker: ServerEvent = { kind: 'agent', ts: 50, e: { t: 'compacted', preTokens: 1000 } };
const user = (id: string, text = id): ServerEvent => ({ kind: 'user', id, text, ts: 1, historic: true });
const page = (events: ServerEvent[], segment: number, more: boolean) =>
  new Response(JSON.stringify({ events, segment, more }), { status: 200, headers: { 'content-type': 'application/json' } });

/** `/history` answers come from `answer`; every other route is a 404 */
function setup(earlier: number, answer: (u: string) => Promise<Response> | Response) {
  vi.stubGlobal('fetch', vi.fn((u: string) => (u.startsWith('/history') ? answer(u) : Promise.resolve(new Response('', { status: 404 })))));
  const store = makeStore({ url: 'ws://x', connect: vi.fn(() => ({ send: () => true, close() {} })) });
  const view = render(
    <Provider store={store}>
      <main data-chat-pane>
        <Feed />
      </main>
    </Provider>,
  );
  act(() => void store.dispatch(serverEvent({ kind: 'replay', events: [session, marker, user('u9', 'after')], earlier })));
  return { store, view };
}
const show = () => screen.queryByRole('button', { name: 'Show before compaction' });

it('no archived segments: no button', () => {
  setup(0, () => page([], 1, false));
  expect(show()).toBeNull();
});

it('is the first item of the feed; each click loads one segment, then it goes', async () => {
  const { view } = setup(2, (u) => (u.endsWith('before=3') ? page([user('u2', 'second')], 2, true) : page([user('u1', 'first')], 1, false)));
  const first = view.container.querySelector('[data-earlier]');
  expect(first).toBe(document.querySelector('[data-chat-pane] > div > :first-child'));
  fireEvent.click(show()!);
  await waitFor(() => expect(screen.getByText('second')).toBeInTheDocument());
  expect(show()).toBeInTheDocument(); // more: true
  fireEvent.click(show()!);
  await waitFor(() => expect(screen.getByText('first')).toBeInTheDocument());
  expect(show()).toBeNull();
  const users = [...view.container.querySelectorAll('[data-kind="user"]')].map((e) => e.getAttribute('data-item-id'));
  expect(users).toEqual(['u1', 'u2', 'u9']);
});

it('shows loading while the request runs, and a failure (a 409) with the button kept to retry', async () => {
  setLang('ru');
  let answer!: (r: Response) => void;
  setup(1, () => new Promise<Response>((r) => { answer = r; }));
  fireEvent.click(screen.getByRole('button', { name: 'Показать до сжатия' }));
  const busy = await screen.findByRole('button', { name: 'Загружаю…' });
  expect(busy).toBeDisabled();
  await act(async () => answer(new Response('not the current session', { status: 409 })));
  expect(screen.getByText('Не удалось загрузить')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Показать до сжатия' })).toBeEnabled();
  expect(screen.queryByText('second')).toBeNull();
});

/**
 * jsdom has no layout. The pane sits at top 0; the feed's first keyed item (u9, the one the reader saw before a prepend) sits at
 * `100 - scrollTop` while nothing is prepended and `h.px` lower once the fragment "first" is in the DOM.
 */
function layout(h: { px: number }) {
  const pane = document.querySelector<HTMLElement>('[data-chat-pane]')!;
  const feed = pane.firstElementChild as HTMLElement;
  const rect = (top: number) => ({ top, bottom: top, left: 0, right: 0, width: 0, height: 0, x: 0, y: top, toJSON() {} }) as DOMRect;
  const marker = () => feed.querySelector('[data-item-id="u9"]');
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    if (this === marker()) return rect(100 + (pane.textContent!.includes('first') ? h.px : 0) - pane.scrollTop);
    return rect(0);
  });
  Object.defineProperty(pane, 'clientHeight', { configurable: true, value: 600 });
  Object.defineProperty(pane, 'scrollHeight', { configurable: true, get: () => 3000 + (pane.textContent!.includes('first') ? h.px : 0) });
  return pane;
}
let resize: (() => void) | null = null;
beforeEach(() => {
  resize = null;
  vi.stubGlobal('ResizeObserver', class { constructor(cb: () => void) { resize = cb; } observe() {} disconnect() { resize = null; } });
});

it('a prepend keeps the reader\'s place: no autoscroll, no "new" dot', async () => {
  setup(1, () => page([user('u1', 'first'), user('u2', 'second')], 1, false));
  const h = { px: 1200 };
  const pane = layout(h);
  pane.scrollTop = 500; // reading near the top, far from the end
  fireEvent.scroll(pane);
  const latest = screen.getByRole('button', { name: 'Jump to the latest' });
  fireEvent.click(show()!);
  await waitFor(() => expect(screen.getByText('first')).toBeInTheDocument());
  expect(pane.scrollTop).toBe(500 + 1200); // the same content stays under the reader
  expect(latest.dataset.unread).toBeUndefined();
});

it('a short feed (stuck to the end): a prepend does not jump to the end, the old top stays in view', async () => {
  setup(1, () => page([user('u1', 'first')], 1, false));
  const pane = layout({ px: 400 });
  pane.scrollTop = 0;
  fireEvent.scroll(pane);
  fireEvent.click(show()!);
  await waitFor(() => expect(screen.getByText('first')).toBeInTheDocument());
  expect(pane.scrollTop).toBe(400); // not the end (3400): what was on screen is still on screen
});

it('content above that grows late (an image, a diagram) keeps being compensated for about a second, until the reader acts', async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  try {
    setup(1, () => page([user('u1', 'first')], 1, false));
    const h = { px: 400 };
    const pane = layout(h);
    pane.scrollTop = 300;
    fireEvent.scroll(pane);
    fireEvent.click(show()!);
    await waitFor(() => expect(screen.getByText('first')).toBeInTheDocument());
    expect(pane.scrollTop).toBe(700);
    h.px = 650; // an image above loaded
    resize!();
    expect(pane.scrollTop).toBe(950);
    fireEvent.scroll(pane); // our own scroll event does not end the window
    h.px = 700;
    resize!();
    expect(pane.scrollTop).toBe(1000);
    fireEvent.wheel(pane); // the reader takes over
    expect(resize).toBeNull();
    h.px = 900;
    expect(pane.scrollTop).toBe(1000);
  } finally {
    vi.useRealTimers();
  }
});

it('the compensation window ends after a second without any reader action', async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  try {
    setup(1, () => page([user('u1', 'first')], 1, false));
    const h = { px: 400 };
    const pane = layout(h);
    pane.scrollTop = 300;
    fireEvent.scroll(pane);
    fireEvent.click(show()!);
    await waitFor(() => expect(screen.getByText('first')).toBeInTheDocument());
    vi.setSystemTime(Date.now() + 1100);
    h.px = 650;
    resize!();
    expect(pane.scrollTop).toBe(700); // too late: left alone
  } finally {
    vi.useRealTimers();
  }
});

it('the reader scrolling (not our own scroll) ends the window', async () => {
  setup(1, () => page([user('u1', 'first')], 1, false));
  const h = { px: 400 };
  const pane = layout(h);
  pane.scrollTop = 300;
  fireEvent.scroll(pane);
  fireEvent.click(show()!);
  await waitFor(() => expect(screen.getByText('first')).toBeInTheDocument());
  pane.scrollTop = 123;
  fireEvent.scroll(pane);
  expect(resize).toBeNull();
});

it('a page that adds nothing (a 404) leaves the feed scrolling as before: the next message still follows the end', async () => {
  const { store } = setup(1, () => new Response('no such segment', { status: 404 }));
  const pane = document.querySelector<HTMLElement>('[data-chat-pane]')!;
  let height = 600;
  Object.defineProperty(pane, 'scrollHeight', { configurable: true, get: () => height });
  Object.defineProperty(pane, 'clientHeight', { configurable: true, value: 600 });
  pane.scrollTop = 0;
  fireEvent.scroll(pane);
  fireEvent.click(show()!);
  await waitFor(() => expect(show()).toBeNull());
  height = 900;
  act(() => void store.dispatch(serverEvent({ kind: 'agent', ts: 70, e: { t: 'message', id: 'a7:0', text: 'live' } })));
  expect(pane.scrollTop).toBe(900); // stuck to the end, as without the click
});

it('an unanswered ask from an archived segment reads as read-only, with no Allow or Deny', async () => {
  const ask: ServerEvent = { kind: 'permission', id: 'p1', toolName: 'Bash', input: { command: 'rm x' }, ts: 2 };
  const { view } = setup(1, () => page([ask, user('u1', 'first')], 1, false));
  fireEvent.click(show()!);
  await waitFor(() => expect(screen.getByText('first')).toBeInTheDocument());
  const card = view.container.querySelector('[data-kind="permission"]')!;
  expect(card).toHaveTextContent('No answer was given before the compaction');
  expect(card.querySelectorAll('button')).toHaveLength(0);
});
