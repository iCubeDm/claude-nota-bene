// The page's side of the local access token (server/src/auth.ts). A window is opened on `/#t=<token>`: the fragment never
// reaches a server, a proxy or a log. The page reads it, takes it out of the address bar and the history entry, and trades
// it (a login value of this launch, not the raw token) for an HttpOnly cookie through POST /auth, which also returns the page's key. The cookie (sent to every port on 127.0.0.1,
// so it opens only GET routes) goes along by itself; the key stays in localStorage (origin-scoped, port included) and is sent
// by `apiFetch` (every request but /file and /attach) and as the `nb.<key>` WebSocket subprotocol (never in the URL): both needed to write.

export const KEY_STORAGE = 'nb.key';
export const KEY_HEADER = 'x-nota-bene-key';
const FRAGMENT = /^#t=([0-9a-f]{64})$/;

export function getKey(): string | null {
  try {
    return localStorage.getItem(KEY_STORAGE);
  } catch {
    return null;
  }
}

/**
 * `fetch` with the page's key (the one place that adds it). Every request goes through it except `/file` and `/attach/<id>`, the
 * two routes the cookie alone opens because elements load them with no headers.
 */
export function apiFetch(input: RequestInfo | URL, init?: RequestInit, fetchFn: typeof fetch = fetch): Promise<Response> {
  const key = getKey();
  if (!key) return init === undefined ? fetchFn(input) : fetchFn(input, init);
  const headers = new Headers(init?.headers);
  headers.set(KEY_HEADER, key);
  return fetchFn(input, { ...init, headers });
}

/** The WebSocket subprotocols that carry the key (empty without one). */
export const socketProtocols = (): string[] => {
  const key = getKey();
  return key ? [`nb.${key}`] : [];
};

/** Logs in with the token of the URL fragment, if there is one. True when the server set the cookie. Never throws. */
export async function loginFromFragment(loc: Location = location, hist: History = history, fetchFn: typeof fetch = fetch): Promise<boolean> {
  const m = FRAGMENT.exec(loc.hash);
  if (!m) return false;
  // before anything else: from now on a reload, a copied address or a screen share no longer holds the token
  hist.replaceState(null, '', loc.pathname + loc.search);
  try {
    const r = await fetchFn('/auth', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ login: m[1] }) });
    if (!r.ok) return false;
    const j = (await r.json().catch(() => null)) as { key?: unknown } | null;
    if (j && typeof j.key === 'string') {
      try {
        localStorage.setItem(KEY_STORAGE, j.key);
      } catch { /* no storage: the cookie reads, the socket will say so */ }
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * The server answers and says this page may not use the API: 401 (no login, or the cookie and key are of an earlier launch).
 * `/info` needs the key, so a page that has the cookie but lost the key lands here too. A server that is down or restarting is
 * not that, and neither is an older server (it needs no key).
 */
export async function refusedForAuth(fetchFn: typeof fetch = fetch): Promise<boolean> {
  try {
    return (await apiFetch('/info', { cache: 'no-store' }, fetchFn)).status === 401;
  } catch {
    return false;
  }
}
