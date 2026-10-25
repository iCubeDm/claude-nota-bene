import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { Provider } from 'react-redux';
import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip.tsx';
import { setLang } from '@/i18n/index.ts';
import { makeStore } from '@/store/store.ts';
import { CommentPopup } from './CommentPopup.tsx';
import { loadEmoji } from './emoji.ts';
import type { PendingSelection } from './SelectionButton.tsx';

const pending: PendingSelection = {
  anchor: { source: { kind: 'message', id: 'a1' }, start: 6, end: 17, quote: 'brave world', prefix: 'hello ', suffix: '' },
  rect: { left: 10, right: 50, top: 20, bottom: 40, width: 40, height: 20, x: 10, y: 20, toJSON() {} } as DOMRect,
};

beforeAll(() => loadEmoji());
beforeEach(() => {
  setLang('en');
  localStorage.clear();
});
afterEach(() => cleanup());

function setup() {
  const store = makeStore({ url: 'ws://x', connect: ((_u: string, _e: unknown, s: (x: 'open') => void) => (s('open'), { send: () => true, close() {} })) as never });
  const onClose = vi.fn();
  render(
    <Provider store={store}>
      <TooltipProvider>
        <CommentPopup pending={pending} onClose={onClose} />
      </TooltipProvider>
    </Provider>,
  );
  const box = screen.getByPlaceholderText('Comment…') as HTMLTextAreaElement;
  const openMenu = () => {
    fireEvent.click(screen.getByRole('button', { name: 'Emoji' }));
    return screen.getByRole('dialog', { name: 'Emoji' });
  };
  return { onClose, box, openMenu };
}

it('search filters by shortcode', async () => {
  const { openMenu } = setup();
  const menu = openMenu();
  await waitFor(() => expect(within(menu).getAllByRole('button').length).toBeGreaterThan(1000), { timeout: 5000 }); // groups arrive one per frame; slow under a loaded full-suite run
  fireEvent.change(within(menu).getByPlaceholderText('Search emoji…'), { target: { value: 'thumbsup' } });
  const btns = within(menu).getAllByRole('button');
  expect(btns.map((b) => b.textContent)).toContain('👍');
  expect(btns.length).toBeLessThan(5);
  fireEvent.change(within(menu).getByPlaceholderText('Search emoji…'), { target: { value: 'ZZZZnope' } });
  expect(within(menu).queryAllByRole('button')).toHaveLength(0);
});

it('click inserts at the caret', () => {
  const { box, openMenu, onClose } = setup();
  fireEvent.change(box, { target: { value: 'ab' } });
  box.setSelectionRange(1, 1);
  const menu = openMenu();
  fireEvent.change(within(menu).getByPlaceholderText('Search emoji…'), { target: { value: 'thumbsup' } });
  fireEvent.click(within(menu).getByText('👍'));
  expect(box.value).toBe('a👍b');
  expect(box.selectionStart).toBe(1 + '👍'.length);
  expect(document.activeElement).toBe(box);
  expect(screen.queryByRole('dialog', { name: 'Emoji' })).toBeNull();
  expect(screen.getByRole('dialog')).toBeTruthy(); // the popup stays
  expect(onClose).not.toHaveBeenCalled();
});

it('recent emoji appear first after use', () => {
  const { openMenu } = setup();
  let menu = openMenu();
  expect(within(menu).queryByText('Recent')).toBeNull();
  fireEvent.change(within(menu).getByPlaceholderText('Search emoji…'), { target: { value: 'rocket' } });
  fireEvent.click(within(menu).getByText('🚀'));
  expect(JSON.parse(localStorage.getItem('emoji:recent')!)).toEqual(['🚀']);
  menu = openMenu();
  const first = menu.querySelector('section')!;
  expect(within(first).getByText('Recent')).toBeTruthy();
  expect(within(first).getByText('🚀')).toBeTruthy();
});

it('Esc closes only the menu; a mousedown inside it does not close the popup', () => {
  const { openMenu, onClose } = setup();
  const menu = openMenu();
  fireEvent.mouseDown(within(menu).getByPlaceholderText('Search emoji…'));
  expect(onClose).not.toHaveBeenCalled();
  fireEvent.keyDown(within(menu).getByPlaceholderText('Search emoji…'), { key: 'Escape' });
  expect(screen.queryByRole('dialog', { name: 'Emoji' })).toBeNull();
  expect(onClose).not.toHaveBeenCalled();
  fireEvent.keyDown(document.body, { key: 'Escape' });
  expect(onClose).toHaveBeenCalledTimes(1);
});

it('recent list is capped at 16 and survives corrupt storage', () => {
  localStorage.setItem('emoji:recent', '{oops');
  const { openMenu } = setup();
  openMenu(); // must not throw
  cleanup();
  localStorage.setItem('emoji:recent', JSON.stringify(Array.from({ length: 30 }, (_, i) => String.fromCodePoint(0x1f600 + i))));
  const again = setup();
  const first = again.openMenu().querySelector('section')!;
  expect(within(first).getAllByRole('button')).toHaveLength(16);
});

it('an outside mousedown closes the menu (and the popup)', () => {
  const { openMenu, onClose } = setup();
  openMenu();
  fireEvent.mouseDown(document.body);
  expect(screen.queryByRole('dialog', { name: 'Emoji' })).toBeNull();
  expect(onClose).toHaveBeenCalled();
});

it('a pick replaces the selection', () => {
  const { box, openMenu } = setup();
  fireEvent.change(box, { target: { value: 'abcd' } });
  box.setSelectionRange(1, 3);
  const menu = openMenu();
  fireEvent.change(within(menu).getByPlaceholderText('Search emoji…'), { target: { value: 'rocket' } });
  fireEvent.click(within(menu).getByText('🚀'));
  expect(box.value).toBe('a🚀d');
});

it('recents move to the front without duplicates', () => {
  const { openMenu } = setup();
  for (const [q, e] of [['rocket', '🚀'], ['thumbsup', '👍'], ['rocket', '🚀']]) {
    const menu = openMenu();
    fireEvent.change(within(menu).getByPlaceholderText('Search emoji…'), { target: { value: q } });
    fireEvent.click(within(menu).getByText(e));
  }
  expect(JSON.parse(localStorage.getItem('emoji:recent')!)).toEqual(['🚀', '👍']);
});

it('a tampered recent list with duplicates shows one button per emoji', () => {
  localStorage.setItem('emoji:recent', JSON.stringify(['🚀', '🚀', '👍']));
  const { openMenu } = setup();
  const first = openMenu().querySelector('section')!;
  expect(within(first).getAllByRole('button').map((b) => b.textContent)).toEqual(['🚀', '👍']);
});

it('typing right after open finds emoji from groups not yet rendered', () => {
  const { openMenu } = setup();
  const menu = openMenu(); // synchronous: later groups have not rendered yet
  fireEvent.change(within(menu).getByPlaceholderText('Search emoji…'), { target: { value: 'rocket' } });
  expect(within(menu).getByText('🚀')).toBeTruthy();
});
