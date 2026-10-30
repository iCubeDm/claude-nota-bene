import { act, cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Provider } from 'react-redux';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { PROTOCOL, SHELL_CMD_MAX, type ClientMessage, type Comment, type ServerEvent } from '@nota-bene/shared';
import { TooltipProvider } from '@/components/ui/tooltip.tsx';
import { Feed } from '@/feed/Feed.tsx';
import { setLang } from '@/i18n/index.ts';
import { getToasts, resetToasts } from '@/shell/toast.ts';
import { makeStore, serverEvent } from '@/store/store.ts';
import { openFile } from '@/tabs/slice.ts';
import { Composer } from './Composer.tsx';
import { addImage, setDraft } from './slice.ts';

beforeEach(() => { setLang('en'); localStorage.clear(); localStorage.setItem('panel:comments', '0'); resetToasts(); });
afterEach(cleanup);

const cm = (id: string): Comment => ({
  id, anchor: { source: { kind: 'message', id: 'u0' }, start: 0, end: 1, quote: 'q', prefix: '', suffix: '' }, text: 'note', status: 'pending', createdAt: 1,
});

function setup(o: { protocol?: number; open?: boolean; comments?: Comment[] } = {}) {
  const sent: ClientMessage[] = [];
  const open = o.open ?? true;
  const store = makeStore({ url: 'ws://x', connect: ((_u: unknown, _e: unknown, onState: (s: 'open') => void) => (open && onState('open'), { send: (m: ClientMessage) => (sent.push(m), true), close() {} })) as never });
  const feed = (ev: ServerEvent) => act(() => void store.dispatch(serverEvent(ev)));
  feed({ kind: 'hello', protocol: o.protocol ?? PROTOCOL });
  feed({ kind: 'user', id: 'u0', text: 'first', ts: 0, historic: true });
  feed({ kind: 'comments', items: o.comments ?? [] });
  render(
    <Provider store={store}>
      <TooltipProvider>
        <Feed />
        <Composer />
      </TooltipProvider>
    </Provider>,
  );
  return { sent, store, feed, box: screen.getByRole('textbox') as HTMLTextAreaElement };
}
const titles = () => getToasts().map((x) => x.title);

it('a draft that starts with ! shows the shell cue and the Run button; any other draft does not', async () => {
  const { box } = setup();
  expect(screen.queryByTestId('shell-cue')).toBeNull();
  await userEvent.type(box, '!ls');
  expect(screen.getByTestId('shell-cue')).toHaveTextContent('Shell · Enter runs');
  expect(screen.getByRole('button', { name: 'Run' })).toBeInTheDocument();
  await userEvent.clear(box);
  await userEvent.type(box, 'ls !');
  expect(screen.queryByTestId('shell-cue')).toBeNull();
  expect(screen.getByRole('button', { name: 'Send' })).toBeInTheDocument();
});

it('Enter runs the command, not a message: shell-run with the text after the !, the draft cleared', async () => {
  const { sent, box } = setup();
  await userEvent.type(box, '! git status{Enter}');
  expect(sent).toHaveLength(1);
  expect(sent[0]).toMatchObject({ type: 'shell-run', cmd: 'git status' });
  expect(sent[0]).toEqual({ type: 'shell-run', id: expect.stringMatching(/^[0-9a-f-]{36}$/), cmd: 'git status' });
  expect(box.value).toBe('');
  expect(box).toHaveFocus();
});

it('the space after ! is optional', async () => {
  const { sent, box } = setup();
  await userEvent.type(box, '!echo hi{Enter}');
  expect(sent[0]).toMatchObject({ cmd: 'echo hi' });
});

it('a draft of several lines is a message, not a command: a pasted script must not run on one Enter', async () => {
  const { sent, box } = setup();
  await userEvent.type(box, '!rm -rf build{Shift>}{Enter}{/Shift}echo done');
  expect(screen.queryByTestId('shell-cue')).toBeNull();
  expect(screen.getByRole('button', { name: 'Send' })).toBeInTheDocument();
  await userEvent.keyboard('{Enter}');
  expect(sent).toMatchObject([{ type: 'send', text: '!rm -rf build\necho done' }]);
});

it('![ is a markdown image or link, a message', async () => {
  const { sent, box } = setup();
  await userEvent.type(box, '![[alt](pic.png)');
  expect(screen.queryByTestId('shell-cue')).toBeNull();
  await userEvent.keyboard('{Enter}');
  expect(sent).toMatchObject([{ type: 'send', text: '![alt](pic.png)' }]);
});

it('a refusal from the server (a second command raced, a switch began) puts the draft back', async () => {
  const { sent, box, feed } = setup();
  await userEvent.type(box, '!make test{Enter}');
  const id = (sent[0] as Extract<ClientMessage, { type: 'shell-run' }>).id;
  expect(box.value).toBe('');
  feed({ kind: 'shell-refused', id, reason: 'running' });
  expect(box.value).toBe('!make test');
  expect(titles()).toContain('Not run: a command is still running. Stop it or wait for it.');
});

it('when the user has typed something new the refused command rides in the toast instead', async () => {
  const { sent, box, feed } = setup();
  await userEvent.type(box, '!make test{Enter}');
  const id = (sent[0] as Extract<ClientMessage, { type: 'shell-run' }>).id;
  await userEvent.type(box, 'next thing');
  feed({ kind: 'shell-refused', id, reason: 'switching' });
  expect(box.value).toBe('next thing');
  expect(getToasts().find((x) => x.title.startsWith('Not run: a session switch'))?.msg).toBe('!make test');
});

it('a started command is not restored by a later refusal of something else', async () => {
  const { sent, box, feed } = setup();
  await userEvent.type(box, '!ls{Enter}');
  const id = (sent[0] as Extract<ClientMessage, { type: 'shell-run' }>).id;
  feed({ kind: 'shell-start', id, cmd: 'ls', ts: 1 });
  feed({ kind: 'shell-refused', id, reason: 'running' });
  expect(box.value).toBe('');
});

it('the Run button runs it too', async () => {
  const { sent, box } = setup();
  await userEvent.type(box, '!pwd');
  await userEvent.click(screen.getByRole('button', { name: 'Run' }));
  expect(sent).toMatchObject([{ type: 'shell-run', cmd: 'pwd' }]);
  expect(box.value).toBe('');
});

it('a bare ! runs nothing and keeps the draft', async () => {
  const { sent, box } = setup();
  await userEvent.type(box, '!  {Enter}');
  expect(sent).toHaveLength(0);
  expect(box.value).toBe('!  ');
});

it('with pending comments the command is refused with a note and the draft and the comments stay', async () => {
  const { sent, box, store } = setup({ comments: [cm('c1')] });
  await userEvent.type(box, '!ls{Enter}');
  expect(sent).toHaveLength(0);
  expect(box.value).toBe('!ls');
  expect(store.getState().comments.items.map((c) => c.status)).toEqual(['pending']);
  expect(titles()).toContain('Not run: the message has pending comments or images. Send or remove them first.');
});

it('with an image attached the command is refused the same way', async () => {
  const { sent, box, store } = setup();
  act(() => void store.dispatch(addImage({ id: 'a'.repeat(64), mediaType: 'image/png' })));
  await userEvent.type(box, '!ls{Enter}');
  expect(sent).toHaveLength(0);
  expect(box.value).toBe('!ls');
  expect(titles()).toHaveLength(1);
});

it('while a command runs a second is refused with a note and kept; once it ends it goes', async () => {
  const { sent, box, feed } = setup();
  feed({ kind: 'shell-start', id: 'r1', cmd: 'sleep 9', ts: 1 });
  await userEvent.type(box, '!ls{Enter}');
  expect(sent).toHaveLength(0);
  expect(box.value).toBe('!ls');
  expect(titles()).toContain('Not run: a command is still running. Stop it or wait for it.');
  feed({ kind: 'shell-end', id: 'r1', cmd: 'sleep 9', output: '', truncated: false, code: 0, ts: 2 });
  await userEvent.keyboard('{Enter}');
  expect(sent).toMatchObject([{ type: 'shell-run', cmd: 'ls' }]);
});

it('a command over 32 KB is refused with a note', async () => {
  const { sent, box, store } = setup();
  act(() => void store.dispatch(setDraft(`!${'x'.repeat(SHELL_CMD_MAX + 1)}`)));
  await userEvent.type(box, '{Enter}');
  expect(sent).toHaveLength(0);
  expect(titles()).toContain('Not run: the command is longer than 32 KB.');
});

it('offline: nothing goes out and the draft stays', async () => {
  const { sent, box } = setup({ open: false });
  await userEvent.type(box, '!ls{Enter}');
  expect(sent).toHaveLength(0);
  expect(box.value).toBe('!ls');
});

it('against a server older than protocol 11 a ! draft is an ordinary message', async () => {
  const { sent, box } = setup({ protocol: 10 });
  await userEvent.type(box, '!ls');
  expect(screen.queryByTestId('shell-cue')).toBeNull();
  await userEvent.keyboard('{Enter}');
  expect(sent).toMatchObject([{ type: 'send', text: '!ls' }]);
});

it('a leading space makes it a message that merely contains !', async () => {
  const { sent, box } = setup();
  await userEvent.type(box, ' !important thing{Enter}');
  expect(sent).toMatchObject([{ type: 'send', text: '!important thing' }]);
});

it('running a command shows the chat, where its block appears', async () => {
  const { sent, store, box, feed } = setup();
  act(() => void store.dispatch(openFile({ path: 'a.md' })));
  expect(store.getState().tabs.active).not.toBe('chat');
  await userEvent.type(box, '!ls{Enter}');
  expect(sent).toHaveLength(1);
  expect(store.getState().tabs.active).toBe('chat');
  feed({ kind: 'shell-start', id: 'r1', cmd: 'ls', ts: 1 });
  expect(screen.getByTestId('shell-block')).toBeInTheDocument();
});
