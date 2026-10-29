import { TAKEN_OVER_CODE, type ClientMessage, type ServerEvent } from '@nota-bene/shared';

const RECONNECT_MS = 1000;

export type SocketState = 'open' | 'closed' | 'taken';
export type Connection = { send(m: ClientMessage): boolean; close(): void; reconnect?(): void };

export function defaultSocketUrl(loc: Location | URL): string {
  return `${loc.protocol === 'https:' ? 'wss' : 'ws'}://${loc.host}/ws`;
}

/** `url` may be a function: read at every (re)connect, so a retry can carry what changed since (`&passive=1`) */
export function connect(
  url: string | (() => string),
  onEvent: (ev: ServerEvent) => void,
  onState: (s: SocketState) => void,
  WS: typeof WebSocket = WebSocket,
): Required<Connection> {
  let ws: WebSocket | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  let reportedClosed = true; // no 'closed' until we have been open

  const open = () => {
    timer = null;
    const sock = new WS(typeof url === 'function' ? url() : url);
    ws = sock;
    // not `open` on the WebSocket's open: a socket is attached only when the server's replay arrives. A newcomer in the
    // reload grace, or an occupied one, gets none, and must neither resync nor send (M7-15 fix round 1)
    sock.onopen = () => {};
    sock.onmessage = (e) => {
      let ev: ServerEvent;
      try {
        ev = JSON.parse(String(e.data)) as ServerEvent;
      } catch (err) {
        console.warn('socket: dropped unparseable frame', err);
        return;
      }
      if (ev.kind === 'replay' && ws === sock && reportedClosed) {
        reportedClosed = false;
        onState('open');
      }
      onEvent(ev);
    };
    sock.onclose = (e) => {
      if (ws === sock) ws = null;
      if (e.code === TAKEN_OVER_CODE && !stopped) { // another tab took the window (R-M7-5): never reconnect by ourselves
        // another tab owns the window now: stay down until the user asks (reconnect())
        stopped = true;
        reportedClosed = true;
        onState('taken');
        return;
      }
      if (!reportedClosed) {
        reportedClosed = true;
        onState('closed');
      }
      if (!stopped && !timer) timer = setTimeout(open, RECONNECT_MS);
    };
  };
  open();

  // a page put into the back/forward cache (a navigation to another URL, e.g. adding `?nudge`) keeps its socket open:
  // the server still sees it as the owner past the reload grace, and the next page lands on "already open". So close
  // on the way in; a restored page reconnects as on a drop (`taken` stays down: that is the user's call)
  const onHide = (e: PageTransitionEvent) => {
    if (!e.persisted || stopped) return;
    if (timer) clearTimeout(timer);
    timer = null;
    const sock = ws;
    ws = null;
    if (sock) sock.onclose = null;
    sock?.close();
    hidden = true;
  };
  const onShow = (e: PageTransitionEvent) => {
    if (!e.persisted || !hidden) return;
    hidden = false;
    if (!reportedClosed) {
      reportedClosed = true;
      onState('closed');
    }
    if (!stopped) open();
  };
  let hidden = false;
  const win = typeof window === 'undefined' ? null : window;
  win?.addEventListener('pagehide', onHide);
  win?.addEventListener('pageshow', onShow);

  return {
    send(m) {
      if (!ws || ws.readyState !== WS.OPEN || (reportedClosed && m.type !== 'takeover')) return false; // not attached yet (grace, occupied): only `takeover` goes out
      ws.send(JSON.stringify(m));
      return true;
    },
    /** after a 4001: opens a new socket (the caller sends `takeover` once `occupied` arrives) */
    reconnect() {
      if (ws) return;
      stopped = false;
      if (timer) clearTimeout(timer);
      open();
    },
    close() {
      stopped = true;
      win?.removeEventListener('pagehide', onHide);
      win?.removeEventListener('pageshow', onShow);
      if (timer) clearTimeout(timer);
      timer = null;
      ws?.close();
    },
  };
}
