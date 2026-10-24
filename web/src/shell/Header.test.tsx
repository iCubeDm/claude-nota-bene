import { fireEvent, render, screen } from '@testing-library/react';
import { expect, it } from 'vitest';
import { setLang } from '@/i18n/index.ts';
import { Header } from './Header.tsx';

it('the toggle shows the other language and re-renders the header on click', () => {
  setLang('ru');
  render(<Header />);
  const btn = screen.getByRole('button', { name: 'EN' });
  expect(btn).toHaveAttribute('title', 'Язык интерфейса: English');
  expect(screen.getByText('подключение…')).toBeInTheDocument();
  fireEvent.click(btn);
  expect(screen.getByRole('button', { name: 'RU' })).toBeInTheDocument();
  expect(screen.getByText('connecting…')).toBeInTheDocument();
  setLang('ru');
});
