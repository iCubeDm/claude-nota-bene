import { act, cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Provider } from 'react-redux';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { PROTOCOL, type ClientMessage, type ServerEvent } from '@nota-bene/shared';
import { setLang } from '@/i18n/index.ts';
import { makeStore, serverEvent } from '@/store/store.ts';
import { Feed } from './Feed.tsx';

beforeEach(() => setLang('en'));
afterEach(cleanup);

function setup() {
  const sent: ClientMessage[] = [];
  const store = makeStore({ url: 'ws://x', connect: ((_u: unknown, _e: unknown, onState: (s: 'open') => void) => (onState('open'), { send: (m: ClientMessage) => (sent.push(m), true), close() {} })) as never });
  const feed = (ev: ServerEvent) => act(() => void store.dispatch(serverEvent(ev)));
  feed({ kind: 'hello', protocol: PROTOCOL });
  render(<Provider store={store}><Feed /></Provider>);
  return { sent, feed };
}
const start = (id = 'r1', cmd = 'npm test'): ServerEvent => ({ kind: 'shell-start', id, cmd, ts: 1 });
const end = (o: Partial<Extract<ServerEvent, { kind: 'shell-end' }>> = {}): ServerEvent => ({ kind: 'shell-end', id: 'r1', cmd: 'npm test', output: '', truncated: false, code: 0, ts: 2, ...o });

it('a running command shows the command, the output so far and Stop; Stop sends shell-stop once', async () => {
  const { sent, feed } = setup();
  feed(start());
  feed({ kind: 'shell-out', id: 'r1', text: 'line 1\n', truncated: false });
  expect(screen.getByTestId('shell-cmd')).toHaveTextContent('npm test');
  expect(screen.getByTestId('shell-output')).toHaveTextContent('line 1');
  expect(screen.getByText(/running…/)).toBeInTheDocument();
  const stop = screen.getByRole('button', { name: 'Stop' });
  await userEvent.click(stop);
  expect(sent).toEqual([{ type: 'shell-stop', id: 'r1' }]);
  expect(stop).toBeDisabled(); // asked: no second Stop
});

it('Stop is usable again when the stop did not go out (offline)', async () => {
  const sent: ClientMessage[] = [];
  let ok = false;
  const store = makeStore({ url: 'ws://x', connect: ((_u: unknown, _e: unknown, onState: (s: 'open') => void) => (onState('open'), { send: (m: ClientMessage) => (sent.push(m), ok), close() {} })) as never });
  act(() => void store.dispatch(serverEvent({ kind: 'shell-start', id: 'r1', cmd: 'sleep 9', ts: 1 })));
  render(<Provider store={store}><Feed /></Provider>);
  await userEvent.click(screen.getByRole('button', { name: 'Stop' }));
  expect(screen.getByRole('button', { name: 'Stop' })).toBeEnabled();
  ok = true;
  await userEvent.click(screen.getByRole('button', { name: 'Stop' }));
  expect(sent).toHaveLength(2);
  expect(screen.getByRole('button', { name: 'Stop' })).toBeDisabled();
});

it('a finished command shows the exit code; the Stop button is gone', () => {
  const { feed } = setup();
  feed(start());
  feed(end({ output: 'ok\n' }));
  expect(screen.queryByRole('button', { name: 'Stop' })).toBeNull();
  expect(screen.getByTestId('shell-how')).toHaveTextContent('exit 0');
  expect(screen.getByTestId('shell-how')).not.toHaveClass('text-destructive');
});

it('a failed command shows its code in the warning color and nothing else', () => {
  const { feed } = setup();
  feed(start());
  feed(end({ code: 2, output: 'boom\n' }));
  expect(screen.getByTestId('shell-how')).toHaveTextContent(/^exit 2$/);
  expect(screen.getByTestId('shell-how')).toHaveClass('text-destructive');
});

it('says why a stopped command ended: the user, the timeout, or a failure to start', () => {
  const { feed } = setup();
  feed(start('a')); feed(end({ id: 'a', code: null, stop: 'user' }));
  feed(start('b')); feed(end({ id: 'b', code: null, stop: 'timeout' }));
  feed(start('c')); feed(end({ id: 'c', code: null, error: 'spawn /bin/sh ENOENT' }));
  const how = screen.getAllByTestId('shell-how').map((e) => e.textContent);
  expect(how).toEqual(['stopped', 'stopped: it ran longer than 10 minutes', 'could not run: spawn /bin/sh ENOENT']);
});

it('marks a cut output, and says so when a command printed nothing', () => {
  const { feed } = setup();
  feed(start('a')); feed(end({ id: 'a', output: 'tail', truncated: true }));
  expect(screen.getByText('earlier output cut · the last 64 KB')).toBeInTheDocument();
  feed(start('b')); feed(end({ id: 'b', output: '' }));
  expect(screen.getByText('(no output)')).toBeInTheDocument();
});

it('a block restored from the transcript has no exit code to show', () => {
  const { feed } = setup();
  feed(start()); feed(end({ code: null, output: 'x' }));
  expect(screen.queryByTestId('shell-how')).toBeNull();
});

it('keeps its place among the messages', () => {
  const { feed } = setup();
  feed({ kind: 'user', id: 'u1', text: 'before', ts: 1 });
  feed(start());
  feed({ kind: 'user', id: 'u2', text: 'after', ts: 3 });
  const kinds = [...document.querySelectorAll('[data-kind]')].map((e) => e.getAttribute('data-kind')).filter((k) => k === 'user' || k === 'shell');
  expect(kinds).toEqual(['user', 'shell', 'user']);
});
