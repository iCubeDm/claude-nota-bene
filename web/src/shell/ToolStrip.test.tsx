import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { Provider } from 'react-redux';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip.tsx';
import { setLang } from '@/i18n/index.ts';
import { makeStore } from '@/store/store.ts';
import { LeftStrip, RightStrip } from './ToolStrip.tsx';

beforeEach(() => { setLang('en'); localStorage.clear(); });
afterEach(cleanup);

const setup = () => {
  const store = makeStore({ url: 'ws://x', connect: () => ({ send: () => true, close() {} }) });
  render(
    <Provider store={store}>
      <TooltipProvider>
        <LeftStrip />
        <RightStrip />
      </TooltipProvider>
    </Provider>,
  );
  return store;
};

it('Files sits on the left strip, Comments on the right; each icon toggles its panel', () => {
  const store = setup();
  const files = screen.getByRole('button', { name: 'Files' });
  const comments = screen.getByRole('button', { name: 'Comments' });
  expect(files.closest('[data-strip]')).toHaveAttribute('data-strip', 'left');
  expect(comments.closest('[data-strip]')).toHaveAttribute('data-strip', 'right');
  // both panels start open (R-M6-3)
  expect(files).toHaveAttribute('aria-pressed', 'true');
  expect(comments).toHaveAttribute('aria-pressed', 'true');
  fireEvent.click(files);
  expect(store.getState().tree.open).toBe(false);
  expect(files).toHaveAttribute('aria-pressed', 'false');
  fireEvent.click(comments);
  expect(store.getState().comments.ui.panelOpen).toBe(false);
  fireEvent.click(files);
  expect(store.getState().tree.open).toBe(true);
});

it('a closed tree stays closed on the next load', () => {
  setup();
  act(() => void fireEvent.click(screen.getByRole('button', { name: 'Files' })));
  expect(localStorage.getItem('panel:tree')).toBe('0');
  cleanup();
  expect(makeStore({ url: 'ws://x', connect: () => ({ send: () => true, close() {} }) }).getState().tree.open).toBe(false);
});
