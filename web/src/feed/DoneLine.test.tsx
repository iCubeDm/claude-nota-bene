import { act, render } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { setLang } from '@/i18n/index.ts';
import { DoneLine, NoticeLine } from './DoneLine.tsx';

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
