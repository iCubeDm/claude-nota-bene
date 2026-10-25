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

it('a server-error notice reads "Server error · where: message" in the destructive style; a resume notice stays muted', () => {
  setLang('en');
  const { container, rerender } = render(<NoticeLine item={{ kind: 'notice', text: 'EACCES', tone: 'error', where: 'comments' }} />);
  const line = container.querySelector('[data-kind="notice"]')!;
  expect(line).toHaveTextContent('Server error · comments: EACCES');
  expect(line).toHaveClass('text-destructive');
  expect(line).not.toHaveClass('text-muted-foreground'); // one colour class, no cascade-order luck
  expect(line).toHaveAttribute('role', 'alert');
  act(() => setLang('ru'));
  expect(line).toHaveTextContent('Ошибка сервера · comments: EACCES');
  rerender(<NoticeLine item={{ kind: 'notice', text: 'abcdefgh' }} />);
  const muted = container.querySelector('[data-kind="notice"]')!;
  expect(muted).toHaveTextContent('↻ продолжение сессии abcdefgh');
  expect(muted).not.toHaveClass('text-destructive');
});
