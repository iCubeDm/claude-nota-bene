import { render, screen } from '@testing-library/react';
import { expect, it } from 'vitest';
import { App } from './App.tsx';

it('renders the app shell with the header logo', () => {
  render(<App />);
  expect(screen.getByAltText('Nota Bene')).toBeInTheDocument();
});
