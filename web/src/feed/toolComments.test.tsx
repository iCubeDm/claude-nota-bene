import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Provider } from 'react-redux';
import { afterEach, beforeEach, expect, it } from 'vitest';
import type { Comment, ServerEvent } from '@nota-bene/shared';
import { TooltipProvider } from '@/components/ui/tooltip.tsx';
import { setLang } from '@/i18n/index.ts';
import { makeStore, selectReplyLabel, serverEvent } from '@/store/store.ts';
import { CommentCard } from '@/comments/CommentCard.tsx';
import { HighlightLayer } from '@/comments/HighlightLayer.tsx';
import { SelectionButton } from '@/comments/SelectionButton.tsx';
import { whereOf } from '@/comments/send.ts';
import { Feed } from './Feed.tsx';

const rect = (left: number, top: number, w: number, h: number) =>
  ({ left, top, right: left + w, bottom: top + h, width: w, height: h, x: left, y: top, toJSON() {} }) as DOMRect;

beforeEach(() => {
  setLang('en');
  // jsdom has no layout: one line rect per range, so marks and the selection bar can be placed
  Range.prototype.getBoundingClientRect = () => rect(10, 20, 40, 16);
  Range.prototype.getClientRects = () => [rect(10, 20, 40, 16)] as unknown as DOMRectList;
  Element.prototype.scrollTo = () => {};
});
afterEach(() => {
  cleanup();
  window.getSelection()?.removeAllRanges();
  delete (Range.prototype as Partial<Range>).getBoundingClientRect;
  delete (Range.prototype as Partial<Range>).getClientRects;
});

type Tool = { id: string; command: string; output: string };
const agent = (ts: number, e: Extract<ServerEvent, { kind: 'agent' }>['e']): ServerEvent => ({ kind: 'agent', ts, e });

/** A feed with the given actions (consecutive ones fold into a group), then a settled turn, plus the comments. */
function setup(tools: Tool[], comments: Comment[] = [], card?: string) {
  const store = makeStore({ url: 'ws://x', connect: ((_u: string, _e: unknown, onState: (s: 'open') => void) => (onState('open'), { send: () => true, close() {} })) as never });
  act(() => {
    store.dispatch(serverEvent({ kind: 'user', id: 'u1', text: 'go', ts: 0, historic: true }));
    tools.forEach((t, i) => {
      store.dispatch(serverEvent(agent(i, { t: 'tool-call', id: t.id, name: 'Bash', input: { command: t.command }, sub: false })));
      store.dispatch(serverEvent(agent(i, { t: 'tool-update', id: t.id, text: t.output, isError: false })));
    });
    store.dispatch(serverEvent({ kind: 'comments', items: comments }));
  });
  const view = render(
    <Provider store={store}>
      <TooltipProvider>
        <main data-chat-pane data-pane="chat">
          <div id="items"><Feed /></div>
          <HighlightLayer />
        </main>
        <SelectionButton onComment={() => {}} />
        {card && <CommentCard id={card} index={0} />}
      </TooltipProvider>
    </Provider>,
  );
  return { store, view };
}

const comment = (toolId: string, quote: string, prefix = '', status: Comment['status'] = 'sent'): Comment => ({
  id: 'c1', text: 'why?', status, createdAt: 1, ...(status === 'sent' ? { sentIn: 'u1' } : {}),
  anchor: { source: { kind: 'message', id: `tool:${toolId}` }, start: prefix.length, end: prefix.length + quote.length, quote, prefix, suffix: '' },
});

const panel = () => screen.getByTestId('tool-panel');
const outputPre = () => panel().querySelectorAll('pre')[1]!;

it('a selection inside a tool output becomes a comment anchored to tool:<id>, the labels and the toggle line out of its text', async () => {
  const { store } = setup([{ id: 't1', command: 'npm test', output: 'FAIL src/a.test.ts' }]);
  fireEvent.click(screen.getByRole('button', { name: /Bash · npm test/ }));
  const text = outputPre().firstChild!;
  const r = document.createRange();
  r.setStart(text, 0);
  r.setEnd(text, 4);
  window.getSelection()!.removeAllRanges();
  window.getSelection()!.addRange(r);
  await act(async () => {
    fireEvent.mouseUp(outputPre());
    await new Promise((res) => setTimeout(res, 0));
  });
  fireEvent.click(screen.getByRole('button', { name: 'Looks good' }));
  const a = store.getState().comments.items[0]!.anchor;
  expect(a.source).toEqual({ kind: 'message', id: 'tool:t1' });
  expect(a).toMatchObject({ quote: 'FAIL', prefix: 'npm test ' }); // the command, then the output: no "Input" / "Output" / "Bash ·"
});

it('the batch line names the action as "<name> command (arg)", the arg cut to 60 characters', () => {
  const long = 'echo ' + 'x'.repeat(80);
  const { store } = setup([{ id: 't1', command: 'npm test', output: 'ok' }, { id: 't2', command: long, output: 'ok' }]);
  expect(whereOf(comment('t1', 'ok'), store.getState())).toBe('Bash command (npm test)');
  expect(selectReplyLabel(store.getState(), 'tool:t2')).toBe(`Bash command (${long.slice(0, 60)}…)`);
  setLang('ru');
  expect(whereOf(comment('t1', 'ok'), store.getState())).toBe('команда Bash (npm test)');
  expect(selectReplyLabel(store.getState(), 'tool:gone')).toBeNull();
});

it('a collapsed group whose actions carry comments shows the count on its head', () => {
  setup([{ id: 't1', command: 'a', output: 'one' }, { id: 't2', command: 'b', output: 'two' }], [comment('t2', 'two', 'b ')]);
  const head = screen.getByRole('button', { name: /2 actions/ });
  expect(head).toHaveTextContent('1 comment');
  fireEvent.click(head);
  expect(screen.getByRole('button', { name: /2 actions/ })).not.toHaveTextContent('1 comment'); // open: the line carries it
  expect(screen.getByRole('button', { name: /Bash · b/ })).toHaveTextContent('1 comment');
});

it('a jump from the card opens the group, the panel and its full output, and the mark is drawn', async () => {
  const output = 'x'.repeat(20_000) + ' TAIL-MARK';
  const { store, view } = setup(
    [{ id: 't1', command: 'a', output: 'one' }, { id: 't2', command: 'b', output }],
    [comment('t2', 'TAIL-MARK', 'b ' + 'x'.repeat(20_000) + ' ', 'pending')], // pending: a sent one is also listed under its message
    'c1',
  );
  expect(screen.queryByTestId('tool-panel')).toBeNull();
  fireEvent.click(screen.getByText('TAIL-MARK'));
  expect(store.getState().feedUi).toEqual({ openTools: ['t2'], openGroups: ['t1'] });
  expect(panel()).toHaveTextContent('TAIL-MARK'); // past the 20000-character cut: a commented panel renders everything
  await waitFor(() => expect(view.container.querySelectorAll('[data-hl="pending"]')).toHaveLength(1));
  expect(screen.queryByText(/fragment changed/)).toBeNull();
});

it('a tool comment whose action is not in the feed is an orphan', () => {
  setup([{ id: 't1', command: 'a', output: 'one' }], [comment('gone', 'one', 'a ')], 'c1');
  expect(screen.getByText(/fragment changed/)).toBeInTheDocument();
});

it('the command always renders in full, so a comment on the output keeps its offsets whatever the output cap', () => {
  const long = 'echo ' + 'y'.repeat(25_000);
  setup([{ id: 't1', command: long, output: 'ok' }]);
  fireEvent.click(screen.getByRole('button', { name: /Bash · echo/ }));
  expect(panel().querySelectorAll('pre')[0]!.textContent).toBe(long);
  expect(screen.queryByRole('button', { name: /show all/i })).toBeNull();
});

it('a commented output renders up to its furthest comment plus a margin, not all of it, and the mark resolves', async () => {
  const before = 'a'.repeat(50_000) + ' ';
  const output = before + 'MID-MARK ' + 'b'.repeat(50_000);
  const { view } = setup([{ id: 't1', command: 'c', output }], [comment('t1', 'MID-MARK', 'c ' + before, 'pending')], 'c1');
  fireEvent.click(screen.getByText('MID-MARK'));
  const shown = outputPre().textContent!.length;
  expect(shown).toBeGreaterThan(before.length + 'MID-MARK'.length + 1_900);
  expect(shown).toBeLessThan(55_000);
  expect(screen.getByRole('button', { name: /show all/i })).toBeInTheDocument(); // the rest is still a click away
  await waitFor(() => expect(view.container.querySelectorAll('[data-hl="pending"]')).toHaveLength(1));
});

it('a jump to an action that is not in the feed opens nothing', () => {
  const { store } = setup([{ id: 't1', command: 'a', output: 'one' }], [comment('gone', 'one', 'a ', 'pending')], 'c1');
  fireEvent.click(screen.getByText('one'));
  expect(store.getState().feedUi).toEqual({ openTools: [], openGroups: [] });
});
