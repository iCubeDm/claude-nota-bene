import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { setLang } from '@/i18n/index.ts';
import { PanelResizer, usePanelWidth } from './PanelResizer.tsx';

beforeEach(() => {
  setLang('en');
  localStorage.clear();
  Object.defineProperty(window, 'innerWidth', { value: 1440, configurable: true });
  // jsdom has no pointer capture
  HTMLElement.prototype.setPointerCapture = () => {};
});
afterEach(cleanup);

function Panel({ edge = 'right' as 'left' | 'right' }) {
  const s = usePanelWidth('w', 300, 200);
  return (
    <aside data-testid="panel" style={{ width: s.width }}>
      <PanelResizer edge={edge} width={s.width} onWidth={s.set} onReset={s.reset} min={200} label="Width" />
    </aside>
  );
}
const panel = () => screen.getByTestId('panel');
const bar = () => screen.getByRole('separator', { name: 'Width' });
const drag = (dx: number) => {
  fireEvent.pointerDown(bar(), { button: 0, clientX: 500, pointerId: 1 });
  fireEvent.pointerMove(bar(), { clientX: 500 + dx, pointerId: 1 });
  fireEvent.pointerUp(bar(), { clientX: 500 + dx, pointerId: 1 });
};

it('dragging the right edge outwards widens the panel and the width is persisted', () => {
  render(<Panel />);
  drag(80);
  expect(panel().style.width).toBe('380px');
  expect(localStorage.getItem('w')).toBe('380');
  cleanup();
  render(<Panel />);
  expect(panel().style.width).toBe('380px');
});

it('a left-edge panel (the comments) widens when dragged left', () => {
  render(<Panel edge="left" />);
  drag(-60);
  expect(panel().style.width).toBe('360px');
});

it('the width stays between the minimum and 45% of the window', () => {
  render(<Panel />);
  drag(-500);
  expect(panel().style.width).toBe('200px');
  drag(5000);
  expect(panel().style.width).toBe('648px'); // 0.45 * 1440
});

it('keyboard: arrows step 16 px, Home and double-click restore the default', () => {
  render(<Panel />);
  bar().focus();
  fireEvent.keyDown(bar(), { key: 'ArrowRight' });
  expect(panel().style.width).toBe('316px');
  expect(bar()).toHaveAttribute('aria-valuenow', '316');
  fireEvent.keyDown(bar(), { key: 'Home' });
  expect(panel().style.width).toBe('300px');
  expect(localStorage.getItem('w')).toBeNull();
  drag(40);
  fireEvent.doubleClick(bar());
  expect(panel().style.width).toBe('300px');
});

it('a stored width wider than the window allows is clamped on load', () => {
  localStorage.setItem('w', '2000');
  render(<Panel />);
  expect(panel().style.width).toBe('648px');
});
