import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Provider } from 'react-redux';
import { App } from './App.tsx';
import { defaultSocketUrl } from './net/socket.ts';
import { makeStore } from './store/store.ts';
import './fonts.css';
import './theme.css';

const store = makeStore({ url: defaultSocketUrl(location) });

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Provider store={store}>
      <App />
    </Provider>
  </StrictMode>,
);
