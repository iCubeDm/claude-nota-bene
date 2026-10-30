import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Provider } from 'react-redux';
import { App } from './App.tsx';
import { loginFromFragment } from './net/auth.ts';
import { defaultSocketUrl } from './net/socket.ts';
import { makeStore } from './store/store.ts';
import './fonts.css';
import './theme.css';

// the window is opened on `/#t=<token>`: trade it for the login cookie before the first request and the socket need it
void loginFromFragment().then(() => {
  const store = makeStore({ url: defaultSocketUrl(location) });
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <Provider store={store}>
        <App />
      </Provider>
    </StrictMode>,
  );
});
