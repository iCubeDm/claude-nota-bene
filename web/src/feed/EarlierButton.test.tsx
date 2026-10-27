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

it('a prepend keeps the reader\'s place: no autoscroll, no "new" dot', async () => {
  setup(1, () => page([user('u1', 'first'), user('u2', 'second')], 1, false));
  const pane = document.querySelector<HTMLElement>('[data-chat-pane]')!;
  // the prepended content is 1200 px tall: the height follows the DOM
  Object.defineProperty(pane, 'scrollHeight', { configurable: true, get: () => (pane.textContent!.includes('first') ? 4200 : 3000) });
  Object.defineProperty(pane, 'clientHeight', { configurable: true, value: 600 });
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
  const pane = document.querySelector<HTMLElement>('[data-chat-pane]')!;
  Object.defineProperty(pane, 'scrollHeight', { configurable: true, get: () => (pane.textContent!.includes('first') ? 1000 : 600) });
  Object.defineProperty(pane, 'clientHeight', { configurable: true, value: 600 });
  pane.scrollTop = 0;
  fireEvent.scroll(pane);
  fireEvent.click(show()!);
  await waitFor(() => expect(screen.getByText('first')).toBeInTheDocument());
  expect(pane.scrollTop).toBe(400); // not 1000: what was on screen is still on screen
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
