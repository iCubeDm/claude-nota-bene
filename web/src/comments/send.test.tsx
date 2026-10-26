import { act, cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Provider } from 'react-redux';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ClientMessage, Comment } from '@nota-bene/shared';
import { TooltipProvider } from '@/components/ui/tooltip.tsx';
import { Composer } from '@/composer/Composer.tsx';
import { Feed } from '@/feed/Feed.tsx';
import { setLang } from '@/i18n/index.ts';
import { makeStore, serverEvent, useAppDispatch } from '@/store/store.ts';
import { addImage, uploadFinished, uploadStarted } from '@/composer/slice.ts';
import { openFile } from '@/tabs/slice.ts';
import { setFileVersion } from '@/files/slice.ts';
import { getToasts, resetToasts } from '@/shell/toast.ts';
import { sendBatch } from './send.ts';
import { CommentsPanel } from './CommentsPanel.tsx';

function Panel() {
  const d = useAppDispatch();
  return <CommentsPanel onSend={() => void d(sendBatch(false))} />;
}

// the composer's Send is under test: the comments panel (open by default, with its own Send) is closed
beforeEach(() => { setLang('en'); localStorage.clear(); localStorage.setItem('panel:comments', '0'); });
afterEach(cleanup);

const cm = (id: string, o: Partial<Comment> = {}): Comment => ({
  id, anchor: { source: { kind: 'message', id: 'u0' }, start: 0, end: 1, quote: `quote ${id}`, prefix: '', suffix: '' },
  text: `text ${id}`, status: 'pending', createdAt: 1, ...o,
});

function setup(items: Comment[] = [], open = true) {
  const sent: ClientMessage[] = [];
  const store = makeStore({ url: 'ws://x', connect: ((_u: string, _e: unknown, onState: (s: 'open') => void) => (open && onState('open'), { send: (m: ClientMessage) => (sent.push(m), true), close() {} })) as never });
  act(() => {
    store.dispatch(serverEvent({ kind: 'user', id: 'u0', text: 'first', ts: 0, historic: true }));
    store.dispatch(serverEvent({ kind: 'comments', items }));
  });
  render(
    <Provider store={store}>
      <TooltipProvider>
        <Feed />
        <Panel />
        <Composer />
      </TooltipProvider>
    </Provider>,
  );
  return { sent, store, box: screen.getByRole('textbox') as HTMLTextAreaElement };
}

it('send carries composed text and commentIds', async () => {
  const { sent, box } = setup([cm('c1'), cm('c2')]);
  await userEvent.type(box, 'please{Enter}');
  expect(sent).toHaveLength(1);
  const m = sent[0] as Extract<ClientMessage, { type: 'send' }>;
  expect(m.commentIds).toEqual(['c1', 'c2']);
  expect(m.text).toMatch(/^please\n\nComments on fragments:\n\n1\. \[my message\]\n> quote c1\n→ text c1\n\n2\./);
});

it('a file comment names its path in the batch line', async () => {
  const f = cm('f1', { anchor: { source: { kind: 'file', path: 'docs/n.md' }, start: 0, end: 5, quote: 'hello', prefix: '', suffix: '' } });
  const { sent, box } = setup([f]);
  await userEvent.type(box, 'go{Enter}');
  expect((sent[0] as Extract<ClientMessage, { type: 'send' }>).text).toContain('1. [docs/n.md]\n> hello\n→ text f1');
});

it('the label shows the count', () => {
  setup([cm('c1'), cm('c2')]);
  expect(screen.getByRole('button', { name: 'Send (2)' })).toBeInTheDocument(); // composer (the closed panel is aria-hidden)
  expect(document.getElementById('cSend')).toHaveTextContent('Send (2)');
});

it('the bubble lists its sent comments', () => {
  const { store } = setup();
  act(() => {
    store.dispatch(serverEvent({ kind: 'user', id: 'u1', text: 'general part\n\nComments on fragments:\n\n1. [x]\n> q\n→ t', ts: 5 }));
    store.dispatch(serverEvent({ kind: 'comments', items: [cm('c1', { status: 'sent', sentIn: 'u1' })] }));
  });
  const bubble = document.querySelector('[data-item-id="u1"]')!;
  expect(bubble).toHaveTextContent('general part');
  const details = bubble.querySelector('details')!;
  expect(details).toHaveAttribute('data-anchor-skip');
  expect(details.querySelector('summary')).toHaveTextContent('1 comment');
  expect(details.querySelector('blockquote')).toHaveTextContent('quote c1');
  expect(details).toHaveTextContent('text c1');
  expect(bubble.textContent).not.toContain('1. [x]');
});

it('a replayed batch without known comments shows the raw tail', () => {
  const { store } = setup();
  act(() => void store.dispatch(serverEvent({ kind: 'user', id: 'u2', text: 'hi\n\nКомментарии к фрагментам:\n\n1. [x]\n> q', ts: 0, historic: true })));
  const bubble = document.querySelector('[data-item-id="u2"]')!;
  expect(bubble.querySelector('details')).toHaveTextContent('[x]'); // the raw tail is rendered as markdown now
  expect(bubble.querySelector('details blockquote')).toHaveTextContent('q');
  expect(bubble.querySelector('details')).toHaveAttribute('data-anchor-skip');
});

it('sending with only comments and no text works', async () => {
  const { sent } = setup([cm('c1')]);
  await userEvent.click(screen.getByRole('button', { name: 'Send (1)' }));
  expect(sent).toHaveLength(1);
  const m = sent[0] as Extract<ClientMessage, { type: 'send' }>;
  expect(m.text.startsWith('Comments on fragments:')).toBe(true);
  expect(m.commentIds).toEqual(['c1']);
});

it('the panel button sends the same batch', async () => {
  const { sent } = setup([cm('c1')]);
  await userEvent.click(document.getElementById('cSend')!);
  expect(sent).toHaveLength(1);
  expect(sent[0]).toMatchObject({ type: 'send', commentIds: ['c1'] });
});

it('nothing at all sends nothing', async () => {
  const { sent, box } = setup();
  await userEvent.type(box, '{Enter}');
  expect(sent).toHaveLength(0);
});

const sentOf = (m: ClientMessage) => m as Extract<ClientMessage, { type: 'send' }>;

it('pending stays pending after a send and becomes sent only after the echo', async () => {
  const { sent, store, box } = setup([cm('c1'), cm('c2')]);
  await userEvent.type(box, 'go{Enter}');
  expect(sent).toHaveLength(1);
  expect(store.getState().comments.items.every((c) => c.status === 'pending')).toBe(true);
  expect(screen.getByRole('button', { name: 'Send' })).toBeInTheDocument(); // in flight: not counted
  act(() => void store.dispatch(serverEvent({ kind: 'comments', items: [cm('c1', { status: 'sent', sentIn: 'm' }), cm('c2', { status: 'sent', sentIn: 'm' })] })));
  expect(store.getState().comments.sendingIds).toEqual([]);
  expect(screen.getByRole('button', { name: 'Send' })).toBeInTheDocument();
});

it('the label stays Send (2) until the echo', () => {
  const { store } = setup([cm('c1'), cm('c2')]);
  expect(screen.getByRole('button', { name: 'Send (2)' })).toBeInTheDocument();
  act(() => void store.dispatch(serverEvent({ kind: 'comments', items: [cm('c1'), cm('c2')] })));
  expect(screen.getByRole('button', { name: 'Send (2)' })).toBeInTheDocument();
});

it('a second Enter before the echo sends nothing', async () => {
  const { sent, box } = setup([cm('c1')]);
  await userEvent.type(box, '{Enter}{Enter}');
  expect(sent).toHaveLength(1);
});

it('Cmd+Enter with comments while busy sends force:true', async () => {
  const { sent, store, box } = setup([cm('c1')]);
  act(() => void store.dispatch(serverEvent({ kind: 'user', id: 'u9', text: 'work', ts: 3 })));
  await userEvent.type(box, '{Meta>}{Enter}{/Meta}');
  expect(sent).toHaveLength(1);
  expect(sentOf(sent[0]).force).toBe(true);
});

it('the draft clears after a send', async () => {
  const { box } = setup([cm('c1')]);
  await userEvent.type(box, 'draft{Enter}');
  expect(box.value).toBe('');
});

it('offline keeps the draft and the pending comments and shows the notice', async () => {
  const { sent, store, box } = setup([cm('c1')], false);
  await userEvent.type(box, 'keep{Enter}');
  expect(sent).toHaveLength(0);
  expect(box.value).toBe('keep');
  expect(store.getState().comments.sendingIds).toEqual([]);
  expect(screen.getByRole('button', { name: 'Send (1)' })).toBeInTheDocument();
  expect(screen.getByText('no connection to the server…')).toBeInTheDocument();
});

it('the panel send includes the draft', async () => {
  const { sent, box } = setup([cm('c1')]);
  await userEvent.type(box, 'also this');
  await userEvent.click(document.getElementById('cSend')!);
  expect(sentOf(sent[0]).text.startsWith('also this\n\nComments on fragments:')).toBe(true);
  expect(box.value).toBe('');
});

it('a foreign comments event that still lists our ids as pending does not re-enable send', async () => {
  const { sent, store, box } = setup([cm('c1'), cm('c2')]);
  await userEvent.type(box, '{Enter}');
  act(() => void store.dispatch(serverEvent({ kind: 'comments', items: [cm('c1'), cm('c2'), cm('c3')] })));
  expect(store.getState().comments.sendingIds).toEqual(['c1', 'c2']);
  expect(screen.getByRole('button', { name: 'Send (1)' })).toBeInTheDocument(); // only the new c3
  act(() => void store.dispatch(serverEvent({ kind: 'comments', items: [cm('c1', { status: 'sent', sentIn: 'm' }), cm('c3')] }))); // c1 sent, c2 deleted
  expect(store.getState().comments.sendingIds).toEqual([]);
  expect(sent).toHaveLength(1);
});

it('with sent comments server-owned, the echo of a racing stale set reports them sent: in-flight ids clear, no second send', async () => {
  const { sent, store, box } = setup([cm('c1')]);
  await userEvent.type(box, 'go{Enter}');
  // another window's stale full set reached the server first: its echo still lists c1 pending
  act(() => void store.dispatch(serverEvent({ kind: 'comments', items: [cm('c1')] })));
  expect(store.getState().comments.sendingIds).toEqual(['c1']);
  // the server's markSent echo, and the echo of any later stale set (the server keeps its sent copy)
  act(() => void store.dispatch(serverEvent({ kind: 'comments', items: [cm('c1', { status: 'sent', sentIn: 'm' })] })));
  act(() => void store.dispatch(serverEvent({ kind: 'comments', items: [cm('c1', { status: 'sent', sentIn: 'm' })] })));
  expect(store.getState().comments.sendingIds).toEqual([]);
  await userEvent.type(box, 'again{Enter}');
  expect(sent).toHaveLength(2);
  expect(sentOf(sent[1]!).commentIds).toBeUndefined();
});

it('images: composer first, then comment images; labels and the batch line', async () => {
  const A = 'a'.repeat(64), B = 'b'.repeat(64);
  const { sent, store, box } = setup([cm('c1', { images: [B] })]);
  act(() => void store.dispatch(addImage({ id: A, mediaType: 'image/png' })));
  await userEvent.type(box, 'see{Enter}');
  const m = sentOf(sent[0]!);
  expect(m.images).toEqual([
    { id: A, mediaType: 'image/png', label: '[image 1]' },
    { id: B, mediaType: expect.any(String), label: '[image 2 · for comment 1]' },
  ]);
  expect(m.text).toContain('→ text c1\n📎 images: 2');
  expect(store.getState().composer.images).toEqual([]);
});

it('images only, no text and no comments, still sends; an upload in flight blocks the send', async () => {
  const A = 'a'.repeat(64);
  const { sent, store, box } = setup();
  act(() => void store.dispatch(uploadStarted()));
  act(() => void store.dispatch(addImage({ id: A, mediaType: 'image/png' })));
  await userEvent.type(box, '{Enter}');
  expect(sent).toHaveLength(0);
  act(() => void store.dispatch(uploadFinished()));
  await userEvent.type(box, '{Enter}');
  expect(sentOf(sent[0]!)).toMatchObject({ text: '', images: [{ id: A, label: '[image 1]' }] });
});

it('only comment images: the ref sits on the comment that owns them, numbering is global', async () => {
  const B = 'b'.repeat(64);
  const { sent, box } = setup([cm('c1'), cm('c2', { images: [B] })]);
  await userEvent.type(box, '{Enter}');
  const m = sentOf(sent[0]!);
  expect(m.images).toMatchObject([{ id: B, label: '[image 1 · for comment 2]' }]);
  expect(m.text).toMatch(/1\. \[[^\]]*\]\n> quote c1\n→ text c1\n\n2\. \[[^\]]*\]\n> quote c2\n→ text c2\n📎 images: 1$/);
});

it('labels follow the language at send time, not at add time', async () => {
  const A = 'a'.repeat(64);
  const { sent, store, box } = setup([cm('c1')]);
  setLang('ru');
  act(() => void store.dispatch(addImage({ id: A, mediaType: 'image/png' })));
  setLang('en');
  await userEvent.type(box, 'x{Enter}');
  expect(sentOf(sent[0]!).images?.[0]?.label).toBe('[image 1]');
});

it('a send from a file tab switches to the chat, where the reply shows; offline stays on the file', () => {
  const { store } = setup([cm('c1')]);
  act(() => { store.dispatch(openFile('notes.md')); });
  expect(store.getState().tabs.active).toBe('file:notes.md');
  let r: unknown;
  act(() => { r = store.dispatch(sendBatch(false)); });
  expect(r).toBe('sent');
  expect(store.getState().tabs.active).toBe('chat');
  cleanup();

  const off = setup([cm('c2')], false).store;
  act(() => { off.dispatch(openFile('notes.md')); });
  act(() => { r = off.dispatch(sendBatch(false)); });
  expect(r).toBe('offline');
  expect(off.getState().tabs.active).toBe('file:notes.md');
});

const lastSend = (sent: ClientMessage[]) => sent.filter((m) => m.type === 'send').at(-1) as Extract<ClientMessage, { type: 'send' }>;

it('send-refused restores the draft, the images and the comment ids, and toasts', async () => {
  resetToasts();
  const { sent, store, box } = setup([cm('c1')]);
  act(() => void store.dispatch(addImage({ id: 'a'.repeat(64) + '.png', mediaType: 'image/png' })));
  await userEvent.type(box, 'please{Enter}');
  const m = lastSend(sent);
  expect(box.value).toBe('');
  expect(store.getState().comments.sendingIds).toEqual(['c1']);
  act(() => void store.dispatch(serverEvent({ kind: 'send-refused', id: m.id, reason: 'switching' })));
  expect(box.value).toBe('please');
  expect(store.getState().composer.images).toHaveLength(1);
  expect(store.getState().comments.sendingIds).toEqual([]);
  expect(getToasts().map((x) => x.title)).toContain('Not sent: a session switch is in progress');
});

it('send-refused keeps a newer draft, and says what it was', async () => {
  resetToasts();
  const { sent, store, box } = setup([]);
  await userEvent.type(box, 'first{Enter}');
  await userEvent.type(box, 'second');
  act(() => void store.dispatch(serverEvent({ kind: 'send-refused', id: lastSend(sent).id, reason: 'switching' })));
  expect(box.value).toBe('second');
  const t = getToasts().find((x) => x.title === 'Not sent: a session switch is in progress');
  expect(t?.msg).toContain('first');
});

it('the echo ends the wait: a later send-refused with that id restores nothing', async () => {
  resetToasts();
  const { sent, store, box } = setup([]);
  await userEvent.type(box, 'ok{Enter}');
  const m = lastSend(sent);
  act(() => void store.dispatch(serverEvent({ kind: 'user', id: m.id, text: 'ok', ts: 9 })));
  act(() => void store.dispatch(serverEvent({ kind: 'send-refused', id: m.id, reason: 'switching' })));
  expect(box.value).toBe('');
});

it('send numbers a media comment\'s images frame-then-layer within the global numbering; the header names file, time and size', async () => {
  setLang('en');
  const A = 'a'.repeat(64), B = 'b'.repeat(64);
  const F = 'f'.repeat(64) + '.jpg', L = 'e'.repeat(64) + '.png';
  const m = cm('m1', {
    images: [F, L],
    anchor: { kind: 'media', source: { kind: 'file', path: 'media/clip.mp4' }, width: 1280, height: 720, time: 4.24, shapes: [{ kind: 'rect', color: '#ff3b30', x: 0.1, y: 0.1, w: 0.2, h: 0.2 }] },
  });
  const { sent, store, box } = setup([cm('c0', { images: [B] }), m]);
  act(() => void store.dispatch(addImage({ id: A, mediaType: 'image/png' })));
  await userEvent.type(box, 'go{Enter}');
  const msg = sentOf(sent[0]!);
  expect(msg.images?.map((i) => i.label)).toEqual(['[image 1]', '[image 2 · for comment 1]', '[image 3 · for comment 2]', '[image 4 · for comment 2]']);
  expect(msg.text).toContain('2. [media/clip.mp4 @ 0:04.240 · 1280×720]\n> rect');
  expect(msg.text).toContain('📎 images: 3 (frame with marks), 4 (marks only, transparent)');

});

it('the "earlier version" line: only for a media comment whose drawn version differs from the known current one', async () => {
  setLang('en');
  const shape = { kind: 'rect', color: '#ff3b30', x: 0.1, y: 0.1, w: 0.2, h: 0.2 } as const;
  const at = (path: string, version?: string) => ({ kind: 'media', source: { kind: 'file', path }, width: 10, height: 10, shapes: [shape], ...(version && { version }) }) as Comment['anchor'];
  const { sent, store, box } = setup([
    cm('changed', { anchor: at('a.png', 'W/"1"') }), // current W/"2": changed
    cm('same', { anchor: at('b.png', 'W/"5"') }), // current W/"5": not
    cm('unknown', { anchor: at('c.png', 'W/"7"') }), // no tab has c.png: unknown, not claimed
  ]);
  act(() => {
    store.dispatch(setFileVersion({ path: 'a.png', version: 'W/"2"' }));
    store.dispatch(setFileVersion({ path: 'b.png', version: 'W/"5"' }));
  });
  await userEvent.type(box, 'go{Enter}');
  const blocks = sentOf(sent[0]!).text.split(/\n(?=\d+\. \[)/);
  const of = (p: string) => blocks.find((b) => b.includes(`[${p} `))!;
  expect(of('a.png')).toContain('marked on an earlier version of the file');
  expect(of('b.png')).not.toContain('earlier version');
  expect(of('c.png')).not.toContain('earlier version');
});
