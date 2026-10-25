import type { ClientMessage, ServerEvent } from '@nota-bene/shared';

const RECONNECT_MS = 1000;

export function defaultSocketUrl(loc: Location | URL): string {
  return `${loc.protocol === 'https:' ? 'wss' : 'ws'}://${loc.host}/ws`;
}

export function connect(
  url: string,
  onEvent: (ev: ServerEvent) => void,
  onState: (s: 'open' | 'closed') => void,
  WS: typeof WebSocket = WebSocket,
): { send(m: ClientMessage): boolean; close(): void } {
  let ws: WebSocket | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  let reportedClosed = true; // no 'closed' until we have been open

  const open = () => {
    timer = null;
    const sock = new WS(url);
    ws = sock;
    sock.onopen = () => {
      reportedClosed = false;
      onState('open');
    };
    sock.onmessage = (e) => {
      let ev: ServerEvent;
      try {
        ev = JSON.parse(String(e.data)) as ServerEvent;
      } catch (err) {
        console.warn('socket: dropped unparseable frame', err);
        return;
      }
      onEvent(ev);
    };
    sock.onclose = () => {
      if (ws === sock) ws = null;
      if (!reportedClosed) {
        reportedClosed = true;
        onState('closed');
      }
      if (!stopped && !timer) timer = setTimeout(open, RECONNECT_MS);
    };
  };
  open();

  return {
    send(m) {
      if (!ws || ws.readyState !== WS.OPEN) return false;
      ws.send(JSON.stringify(m));
      return true;
    },
    close() {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = null;
      ws?.close();
    },
  };
}
