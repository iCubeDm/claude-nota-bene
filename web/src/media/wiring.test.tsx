import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { Provider } from 'react-redux';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { setLang } from '@/i18n/index.ts';
import { makeStore } from '@/store/store.ts';
import { App } from '@/App.tsx';
import { activate, closeAll, closeOthers, closeRight, closeTab, fileTabId, openFile, selectTabs } from '@/tabs/slice.ts';
import type { PipApi } from './mediaController.ts';

vi.mock('mermaid', () => ({ default: { initialize: vi.fn(), render: vi.fn(async () => ({ svg: '<svg></svg>' })) } }));

beforeEach(() => {
  localStorage.clear();
  setLang('en');
  vi.stubGlobal('fetch', vi.fn(async () => new Response('x', { status: 200, headers: { 'content-length': '1' } })));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

function setup(files: string[]) {
  let cur: Element | null = null;
  const pip = {
    request: vi.fn(async (v: HTMLVideoElement) => { cur = v; }),
    exit: vi.fn(async () => { const v = cur; cur = null; v?.dispatchEvent(new Event('leavepictureinpicture')); }),
    current: () => cur,
  } satisfies PipApi;
  const store = makeStore({ url: 'ws://x', connect: () => ({ send: () => true, close() {} }), pip });
  for (const f of files) store.dispatch(openFile(f));
  store.dispatch(activate('chat'));
  render(<Provider store={store}><App /></Provider>);
  return { store, pip };
}

/** Makes the rendered <video|audio> of a tab playable in jsdom. */
function media(path: string) {
  const el = document.querySelector<HTMLMediaElement>(`[data-media-tab="${fileTabId(path)}"]`)!;
  let paused = true;
  Object.defineProperty(el, 'paused', { configurable: true, get: () => paused });
  el.play = vi.fn(async () => { paused = false; el.dispatchEvent(new Event('play')); });
  el.pause = vi.fn(() => { if (!paused) { paused = true; el.dispatchEvent(new Event('pause')); } });
  return el;
}
const tabEl = (path: string) => document.querySelector(`[data-tab="${fileTabId(path)}"]`)!;

it('clicking the chat tab while a video plays requests PiP before the pane is hidden', async () => {
  const { store, pip } = setup(['a.mp4']);
  act(() => { store.dispatch(activate(fileTabId('a.mp4'))); });
  const v = media('a.mp4');
  await act(() => v.play());
  let hiddenAtRequest: boolean | null = null;
  pip.request.mockImplementation(async (el) => { hiddenAtRequest = el.closest('[data-pane]')!.hasAttribute('hidden'); });
  fireEvent.click(screen.getByRole('tab', { name: /Chat/ }));
  expect(pip.request).toHaveBeenCalledTimes(1);
  expect(hiddenAtRequest).toBe(false);
});

it('opening a text file from the tree while a video plays sends it to PiP', async () => {
  const { store, pip } = setup(['a.mp4']);
  act(() => { store.dispatch(activate(fileTabId('a.mp4'))); });
  await act(() => media('a.mp4').play());
  act(() => { store.dispatch(openFile('notes.ts')); });
  expect(pip.request).toHaveBeenCalledTimes(1);
});

it('opening a new video from the tree pauses the playing one, no PiP', async () => {
  const { store, pip } = setup(['a.mp4']);
  act(() => { store.dispatch(activate(fileTabId('a.mp4'))); });
  const v = media('a.mp4');
  await act(() => v.play());
  act(() => { store.dispatch(openFile('b.mp4')); }); // b's element does not exist yet
  expect(v.paused).toBe(true);
  expect(pip.request).not.toHaveBeenCalled();
});

it.each([
  ['closeTab', (s: ReturnType<typeof setup>['store']) => s.dispatch(closeTab(fileTabId('a.mp3')))],
  ['closeOthers', (s: ReturnType<typeof setup>['store']) => s.dispatch(closeOthers(fileTabId('x.ts')))],
  ['closeRight', (s: ReturnType<typeof setup>['store']) => s.dispatch(closeRight(fileTabId('x.ts')))],
  ['closeAll', (s: ReturnType<typeof setup>['store']) => s.dispatch(closeAll())],
])('%s pauses every removed medium', async (_n, close) => {
  const { store } = setup(['x.ts', 'a.mp3', 'b.mp4']);
  const a = media('a.mp3');
  await act(() => a.play());
  act(() => { close(store); });
  expect(a.paused).toBe(true);
  expect(selectTabs(store.getState()).open.some((t) => t.id === fileTabId('a.mp3'))).toBe(false);
});

it('closeAll with a video in PiP exits PiP and does not switch back', async () => {
  const { store, pip } = setup(['a.mp4']);
  act(() => { store.dispatch(activate(fileTabId('a.mp4'))); });
  const v = media('a.mp4');
  await act(() => v.play());
  act(() => { store.dispatch(activate('chat')); });
  expect(pip.current()).toBe(v);
  act(() => { store.dispatch(closeAll()); });
  expect(v.paused).toBe(true);
  expect(pip.exit).toHaveBeenCalledTimes(1);
  expect(selectTabs(store.getState()).active).toBe('chat');
});

it('the ▶ dot shows on a background tab whose medium plays, and follows pause', async () => {
  const { store } = setup(['a.mp3']);
  act(() => { store.dispatch(activate(fileTabId('a.mp3'))); });
  const a = media('a.mp3');
  await act(() => a.play());
  expect(tabEl('a.mp3').getAttribute('data-playing')).toBeNull(); // the active tab shows its own player
  act(() => { store.dispatch(activate('chat')); });
  expect(tabEl('a.mp3').getAttribute('data-playing')).toBe('true');
  act(() => a.pause());
  expect(tabEl('a.mp3').getAttribute('data-playing')).toBeNull();
});
