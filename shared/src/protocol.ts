import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';

export type ClientMessage =
  | { type: 'send'; id: string; text: string; force?: boolean }
  | { type: 'interrupt' }
  | { type: 'permission'; id: string; allow: boolean };

export type ServerEvent =
  | { kind: 'replay'; events: ServerEvent[] }
  | { kind: 'sdk'; m: SDKMessage; ts: number }
  | { kind: 'user'; id: string; text: string; ts: number; force?: boolean; historic?: boolean }
  | { kind: 'permission'; id: string; toolName: string; input: Record<string, unknown>; ts: number }
  | { kind: 'permission-done'; id: string; allow: boolean; ts: number }
  | { kind: 'session'; id: string | null; root: string }
  /** stored once after the replayed transcript of a resumed session; the only source of the "resumed" notice */
  | { kind: 'resumed'; id: string }
  | { kind: 'server-error'; where: string; message: string };

type Obj = Record<string, unknown>;

function isSend(o: Obj): o is Obj & ClientMessage {
  return typeof o.id === 'string' && typeof o.text === 'string'
    && (o.force === undefined || typeof o.force === 'boolean');
}

function isPermission(o: Obj): boolean {
  return typeof o.id === 'string' && typeof o.allow === 'boolean';
}

export function parseClientMessage(raw: string): ClientMessage | { error: string } {
  let o: unknown;
  try {
    o = JSON.parse(raw);
  } catch {
    return { error: 'invalid JSON' };
  }
  if (typeof o !== 'object' || o === null || Array.isArray(o)) return { error: 'message must be an object' };
  const m = o as Obj;
  switch (m.type) {
    case 'send':
      if (!isSend(m)) return { error: 'send needs string id, string text and optional boolean force' };
      return m.force === undefined
        ? { type: 'send', id: m.id as string, text: m.text as string }
        : { type: 'send', id: m.id as string, text: m.text as string, force: m.force as boolean };
    case 'interrupt':
      return { type: 'interrupt' };
    case 'permission':
      if (!isPermission(m)) return { error: 'permission needs string id and boolean allow' };
      return { type: 'permission', id: m.id as string, allow: m.allow as boolean };
    default:
      return { error: `unknown message type: ${String(m.type)}` };
  }
}
