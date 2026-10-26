import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Provider } from 'react-redux';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ClientMessage } from '@nota-bene/shared';
import { Composer } from '@/composer/Composer.tsx';
import { TooltipProvider } from '@/components/ui/tooltip.tsx';
import { setLang } from '@/i18n/index.ts';
import { makeStore } from '@/store/store.ts';
import { switchSession } from '@/controls/slice.ts';
import { CommentPopup } from './CommentPopup.tsx';
import { labelText, QUICK_LABELS } from './labels.ts';
import type { PendingSelection } from './SelectionButton.tsx';

const pending: PendingSelection = {
  anchor: { source: { kind: 'message', id: 'a1' }, start: 6, end: 17, quote: 'brave world', prefix: 'hello ', suffix: '' },
  rect: { left: 10, right: 50, top: 20, bottom: 40, width: 40, height: 20, x: 10, y: 20, toJSON() {} } as DOMRect,
};

beforeEach(() => setLang('en'));
afterEach(() => {
  cleanup();
  window.getSelection()?.removeAllRanges();
});

function setup() {
  const sent: ClientMessage[] = [];
  const store = makeStore({
    url: 'ws://x',
    connect: ((_u: string, _e: unknown, onState: (s: 'open') => void) => {
      onState('open');
      return { send: (m: ClientMessage) => (sent.push(m), true), close() {} };
    }) as never,
  });
  const onClose = vi.fn();
  render(
    <Provider store={store}>
      <TooltipProvider>
        <p id="outside">outside</p>
        <Composer />
        <CommentPopup pending={pending} onClose={onClose} />
      </TooltipProvider>
    </Provider>,
  );
  const comments = () => store.getState().comments.items;
  return { store, sent, onClose, comments };
}
const box = () => screen.getByPlaceholderText('Comment…');

it('shows the quote and focuses the textarea', () => {
  setup();
  expect(screen.getByText(/brave world/)).toBeInTheDocument();
  expect(box()).toHaveFocus();
});

it('⌘Enter adds with the typed text', () => {
  const { comments, onClose, store } = setup();
  fireEvent.change(box(), { target: { value: ' fix this ' } });
  fireEvent.keyDown(box(), { key: 'Enter', metaKey: true });
  expect(comments()).toHaveLength(1);
  expect(comments()[0]).toMatchObject({ text: 'fix this', anchor: pending.anchor });
  expect(comments()[0].label).toBeUndefined();
  expect(onClose).toHaveBeenCalled();
  expect(store.getState().comments.ui.panelOpen).toBe(true);
});

it('Esc cancels without adding', () => {
  const { comments, onClose } = setup();
  fireEvent.change(box(), { target: { value: 'x' } });
  fireEvent.keyDown(document, { key: 'Escape' });
  expect(comments()).toHaveLength(0);
  expect(onClose).toHaveBeenCalled();
});

it('Esc is default-prevented so it never interrupts the agent', () => {
  setup();
  expect(fireEvent.keyDown(document, { key: 'Escape' })).toBe(false);
});

it('a mousedown outside cancels; inside does not', () => {
  const { comments, onClose } = setup();
  fireEvent.mouseDown(box());
  expect(onClose).not.toHaveBeenCalled();
  fireEvent.mouseDown(document.getElementById('outside')!);
  expect(onClose).toHaveBeenCalled();
  expect(comments()).toHaveLength(0);
});

it('an empty ⌘Enter adds nothing and closes', () => {
  const { comments, onClose } = setup();
  fireEvent.keyDown(box(), { key: 'Enter', metaKey: true });
  expect(comments()).toHaveLength(0);
  expect(onClose).toHaveBeenCalled();
});

it('a chip adds a labelled comment in one click', () => {
  const { comments, onClose } = setup();
  fireEvent.change(box(), { target: { value: 'why' } });
  const chip = screen.getByRole('button', { name: 'Verify this' });
  fireEvent.click(chip);
  expect(comments()).toHaveLength(1);
  expect(comments()[0]).toMatchObject({ label: 'verify', text: 'why' });
  expect(onClose).toHaveBeenCalled();
});

it('a chip with no text adds a label-only comment', () => {
  const { comments } = setup();
  fireEvent.click(screen.getByRole('button', { name: /Looks good/ }));
  expect(comments()[0]).toMatchObject({ label: 'looks-good', text: '' });
});

it('adding clears the DOM selection', () => {
  const { onClose } = setup();
  const r = document.createRange();
  r.selectNodeContents(document.getElementById('outside')!);
  window.getSelection()!.addRange(r);
  fireEvent.keyDown(box(), { key: 'Enter', ctrlKey: true });
  expect(window.getSelection()!.isCollapsed).toBe(true);
  expect(onClose).toHaveBeenCalled();
});

it('has the emoji button in its slot', () => {
  setup();
  expect(document.querySelector('[data-slot="emoji"]')!.querySelector('button[aria-label="Emoji"]')).not.toBeNull();
});

it('⌘Enter in the popup does not reach the composer', async () => {
  const { sent } = setup();
  const seen = vi.fn();
  document.addEventListener('keydown', seen);
  await act(async () => {
    fireEvent.change(screen.getByPlaceholderText(/Message the agent/), { target: { value: 'draft' } });
  });
  fireEvent.change(box(), { target: { value: 'c' } });
  const notPrevented = fireEvent.keyDown(box(), { key: 'Enter', metaKey: true });
  document.removeEventListener('keydown', seen);
  expect(notPrevented).toBe(false);
  expect(seen).not.toHaveBeenCalled();
  expect(sent.filter((m) => m.type === 'send')).toHaveLength(0);
  expect(screen.getByPlaceholderText(/Message the agent/)).toHaveValue('draft');
});

vi.mock('@/attachments/image.ts', async (orig) => ({
  ...(await orig<typeof import('@/attachments/image.ts')>()),
  prepareImage: async (f: File) => f,
  uploadImage: async () => ({ id: 'e'.repeat(64), mediaType: 'image/png' }),
}));

it('a pasted image is saved on the comment (images-only is enough)', async () => {
  URL.createObjectURL = vi.fn(() => 'blob:x');
  URL.revokeObjectURL = vi.fn();
  const { comments, onClose } = setup();
  const f = new File(['x'], 'a.png', { type: 'image/png' });
  const ev = new Event('paste', { bubbles: true, cancelable: true });
  Object.defineProperty(ev, 'clipboardData', { value: { files: [f], items: [] } });
  act(() => void box().dispatchEvent(ev));
  await waitFor(() => expect(document.querySelector('img[src^="/attach/"]:not([data-pending])')).toBeTruthy());
  fireEvent.click(screen.getByRole('button', { name: 'Add' }));
  expect(comments()[0]).toMatchObject({ text: '', images: ['e'.repeat(64)] });
  expect(onClose).toHaveBeenCalled();
});

it('while switching: Add and the quick labels are disabled with the switching tooltip, Cmd+Enter adds nothing', () => {
  const { store, comments, onClose } = setup();
  act(() => void store.dispatch(switchSession('x', '/r')));
  const add = screen.getByRole('button', { name: 'Add' });
  expect(add).toBeDisabled();
  expect(add).toHaveAttribute('title', 'switching…');
  const chips = screen.getAllByRole('button').filter((b) => b.closest('.flex-wrap'));
  expect(chips.length).toBeGreaterThan(0);
  for (const chip of chips) expect(chip).toBeDisabled();
  fireEvent.change(box(), { target: { value: 'x' } });
  fireEvent.keyDown(box(), { key: 'Enter', metaKey: true });
  expect(comments()).toEqual([]);
  expect(onClose).not.toHaveBeenCalled();
});

it('quick-label chips show only the emoji; the label is the accessible name; at least 28px to click (M6-07)', () => {
  setup();
  const chip = screen.getByRole('button', { name: 'Looks good' });
  expect(chip).toHaveTextContent(/^👍$/);
  expect(chip.className).toMatch(/min-h-7/);
  expect(chip.className).toMatch(/min-w-7/);
  for (const l of QUICK_LABELS) {
    const b = screen.getByRole('button', { name: labelText(l.id) });
    expect(b.textContent).toBe(l.emoji);
  }
});

it('hovering a chip shows the label and the instruction in a tooltip', async () => {
  setup();
  fireEvent.focus(screen.getByRole('button', { name: 'Verify this' }));
  const tip = await screen.findByRole('tooltip');
  expect(tip).toHaveTextContent('Verify this');
  expect(tip).toHaveTextContent('Verify by reading the actual code');
});

it('while switching, a hovered chip explains why it is off', async () => {
  const { store } = setup();
  act(() => void store.dispatch(switchSession('x', '/r')));
  const chip = screen.getByRole('button', { name: 'Verify this' });
  fireEvent.focus(chip.parentElement!);
  expect(await screen.findByRole('tooltip')).toHaveTextContent('switching…');
});
