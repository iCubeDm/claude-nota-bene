import { render, screen } from '@testing-library/react';
import { Provider } from 'react-redux';
import { expect, it } from 'vitest';
import { makeStore } from './store/store.ts';
import { App } from './App.tsx';

it('renders the app shell with the header logo', () => {
  const store = makeStore({ url: 'ws://x', connect: () => ({ send: () => true, close() {} }) });
  render(
    <Provider store={store}>
      <App />
    </Provider>,
  );
  expect(screen.getByAltText('Nota Bene')).toBeInTheDocument();
});
