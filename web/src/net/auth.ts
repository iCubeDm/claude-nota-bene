// The page's side of the local access token (server/src/auth.ts). A window is opened on `/#t=<token>`: the fragment never
// reaches a server, a proxy or a log. The page reads it, takes it out of the address bar and the history entry, and trades
// it for an HttpOnly cookie through POST /auth. After that every request and the socket carry the cookie by themselves.

const FRAGMENT = /^#t=([0-9a-f]{64})$/;

/** Logs in with the token of the URL fragment, if there is one. True when the server set the cookie. Never throws. */
export async function loginFromFragment(loc: Location = location, hist: History = history, fetchFn: typeof fetch = fetch): Promise<boolean> {
  const m = FRAGMENT.exec(loc.hash);
  if (!m) return false;
  // before anything else: from now on a reload, a copied address or a screen share no longer holds the token
  hist.replaceState(null, '', loc.pathname + loc.search);
  try {
    const r = await fetchFn('/auth', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: m[1] }) });
    return r.ok;
  } catch {
    return false;
  }
}

/** The server answers, and says this page is not logged in (401). A server that is down or restarting is not that. */
export async function refusedForAuth(fetchFn: typeof fetch = fetch): Promise<boolean> {
  try {
    return (await fetchFn('/info', { cache: 'no-store' })).status === 401;
  } catch {
    return false;
  }
}
