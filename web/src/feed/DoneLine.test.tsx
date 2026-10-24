import { render } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { setLang } from '@/i18n/index.ts';
import { DoneLine } from './DoneLine.tsx';

afterEach(() => setLang('ru'));

it('labels status and duration through t(), with the error text', () => {
  setLang('ru');
  const { container, rerender } = render(<DoneLine item={{ kind: 'done', secs: 3, ts: 0, status: 'failed', error: 'boom' }} />);
  expect(container).toHaveTextContent('ошибка · 3с · boom');
  setLang('en');
  rerender(<DoneLine item={{ kind: 'done', secs: 2, ts: 0, status: 'interrupted' }} />);
  expect(container).toHaveTextContent(/^interrupted · 2s$/);
});
