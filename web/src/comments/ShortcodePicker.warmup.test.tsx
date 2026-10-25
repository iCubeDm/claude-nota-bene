import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createRef } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { ShortcodePicker } from './ShortcodePicker.tsx';

let release!: () => void;
vi.mock('./emoji.ts', () => ({
  loadEmoji: () => new Promise<void>((r) => { release = r; }),
  searchShortcodes: (q: string) => (q === '+1' ? [{ code: '+1', emoji: '👍' }] : []),
}));
afterEach(cleanup);

it('a caret moved onto a closed :+1: while emoji data loads is not replaced', async () => {
  const ref = createRef<HTMLTextAreaElement>();
  render(<><textarea ref={ref} /><ShortcodePicker target={ref} /></>);
  const box = ref.current!;
  box.focus();
  box.value = ':+1: x :sm';
  box.setSelectionRange(box.value.length, box.value.length);
  fireEvent.input(box); // starts the (pending) load
  box.setSelectionRange(4, 4); // user moves the caret right after ":+1:"
  await act(async () => release());
  expect(box.value).toBe(':+1: x :sm');
  expect(screen.queryByRole('listbox')).toBeNull();
});
