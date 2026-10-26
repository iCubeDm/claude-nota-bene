import { act, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { setLang } from '@/i18n/index.ts';
import { CompactingLine, DoneLine, MarkerLine, NoticeLine } from './DoneLine.tsx';

afterEach(() => setLang('ru'));

it('labels status and duration through t(), with the error text', () => {
  setLang('ru');
  const { container, rerender } = render(<DoneLine item={{ kind: 'done', secs: 3, ts: 0, status: 'failed', error: 'boom' }} />);
  expect(container).toHaveTextContent('ошибка · 3с · boom');
  setLang('en');
  rerender(<DoneLine item={{ kind: 'done', secs: 2, ts: 0, status: 'interrupted' }} />);
  expect(container).toHaveTextContent(/^interrupted · 2s$/);
});

it('a resume notice is muted and follows the language', () => {
  setLang('en');
  const { container } = render(<NoticeLine item={{ kind: 'notice', text: 'abcdefgh' }} />);
  act(() => setLang('ru'));
  const muted = container.querySelector('[data-kind="notice"]')!;
  expect(muted).toHaveTextContent('↻ продолжение сессии abcdefgh');
  expect(muted).not.toHaveClass('text-destructive');
});

it('the compacted line tells how long it took; a failed one is red with the error', () => {
  setLang('ru');
  const { container, rerender } = render(<MarkerLine item={{ kind: 'marker', what: 'compacted', pre: 850000, ms: 72000, ts: 0 }} />);
  expect(container).toHaveTextContent('⇣ контекст сжат · было 850k токенов · за 1:12');
  rerender(<MarkerLine item={{ kind: 'marker', what: 'compactFailed', error: 'boom', ts: 0 }} />);
  expect(container.querySelector('[data-kind="marker"]')).toHaveClass('text-destructive');
  expect(container).toHaveTextContent('⇣ сжать контекст не удалось: boom');
});

it('the compacting line counts from the server ts and fills the bar towards the usual time', () => {
  vi.useFakeTimers();
  try {
    localStorage.setItem('nb.compactMs', JSON.stringify([60_000]));
    setLang('ru');
    let clock = 10_000 + 30_000;
    const { container } = render(<CompactingLine since={10_000} now={() => clock} />);
    expect(container).toHaveTextContent('⇣ сжимаю контекст · 0:30 · обычно ~1:00');
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '45');
    clock += 30_000;
    act(() => vi.advanceTimersByTime(500));
    expect(container).toHaveTextContent('· 1:00 ·');
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '90');
  } finally {
    vi.useRealTimers();
    localStorage.clear();
  }
});
