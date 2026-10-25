import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';

export type AnchorSource = { kind: 'message'; id: string } | { kind: 'file'; path: string };
export type Anchor = { source: AnchorSource; start: number; end: number; quote: string; prefix: string; suffix: string };
export const QUICK_LABEL_IDS = ['looks-good', 'clarify', 'verify', 'example', 'overview', 'patterns',
  'alternatives', 'no-regression', 'out-of-scope', 'needs-tests'] as const;
export type QuickLabelId = (typeof QUICK_LABEL_IDS)[number];
export type Comment = {
  id: string; anchor: Anchor; text: string; label?: QuickLabelId;
  status: 'pending' | 'sent'; createdAt: number;
  /** id of the user message that carried it */
  sentIn?: string;
};

export type ClientMessage =
  | { type: 'send'; id: string; text: string; force?: boolean; commentIds?: string[] }
  /** full replacement of this session's comment set */
  | { type: 'comments'; items: Comment[] }
  | { type: 'interrupt' }
  | { type: 'permission'; id: string; allow: boolean };

export type ServerEvent =
  | { kind: 'replay'; events: ServerEvent[] }
  | { kind: 'sdk'; m: SDKMessage; ts: number }
  | { kind: 'user'; id: string; text: string; ts: number; force?: boolean; historic?: boolean }
  | { kind: 'permission'; id: string; toolName: string; input: Record<string, unknown>; ts: number }
  | { kind: 'permission-done'; id: string; allow: boolean; ts: number }
  /** full comment set; never stored in history, so no ts */
  | { kind: 'comments'; items: Comment[] }
  | { kind: 'session'; id: string | null; root: string }
  /** stored once after the replayed transcript of a resumed session; the only source of the "resumed" notice */
  | { kind: 'resumed'; id: string }
  | { kind: 'server-error'; where: string; message: string };

type Obj = Record<string, unknown>;

function isSend(o: Obj): o is Obj & ClientMessage {
  return typeof o.id === 'string' && typeof o.text === 'string'
    && (o.force === undefined || typeof o.force === 'boolean')
    && (o.commentIds === undefined || isStringArray(o.commentIds));
}

function isObj(v: unknown): v is Obj {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === 'string');
}

function isOffset(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0;
}

function isAnchor(v: unknown): v is Anchor {
  if (!isObj(v) || !isObj(v.source)) return false;
  const s = v.source;
  const sourceOk = (s.kind === 'message' && typeof s.id === 'string') || (s.kind === 'file' && typeof s.path === 'string');
  return sourceOk && isOffset(v.start) && isOffset(v.end) && v.end >= v.start
    && typeof v.quote === 'string' && typeof v.prefix === 'string' && typeof v.suffix === 'string';
}

function isComment(v: unknown): v is Comment {
  if (!isObj(v) || typeof v.id !== 'string' || !isAnchor(v.anchor) || typeof v.text !== 'string') return false;
  const labelOk = v.label === undefined || (QUICK_LABEL_IDS as readonly unknown[]).includes(v.label);
  // empty text is allowed only for a one-click quick label
  const textOk = v.text !== '' || v.label !== undefined;
  return labelOk && textOk && (v.status === 'pending' || v.status === 'sent') && isOffset(v.createdAt)
    && (v.sentIn === undefined || typeof v.sentIn === 'string');
}

function isPermission(o: Obj): boolean {
  return typeof o.id === 'string' && typeof o.allow === 'boolean';
}

function toSource(s: AnchorSource): AnchorSource {
  return s.kind === 'message' ? { kind: 'message', id: s.id } : { kind: 'file', path: s.path };
}

function toAnchor(a: Anchor): Anchor {
  return { source: toSource(a.source), start: a.start, end: a.end, quote: a.quote, prefix: a.prefix, suffix: a.suffix };
}

/** rebuild from known fields only, so unknown keys never reach storage or rebroadcast */
function toComment(c: Comment): Comment {
  return {
    id: c.id, anchor: toAnchor(c.anchor), text: c.text,
    ...(c.label === undefined ? {} : { label: c.label }),
    status: c.status, createdAt: c.createdAt,
    ...(c.sentIn === undefined ? {} : { sentIn: c.sentIn }),
  };
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
      if (!isSend(m)) return { error: 'send needs string id, string text, optional boolean force and optional string[] commentIds' };
      return {
        type: 'send', id: m.id as string, text: m.text as string,
        ...(m.force === undefined ? {} : { force: m.force as boolean }),
        ...(m.commentIds === undefined ? {} : { commentIds: m.commentIds as string[] }),
      };
    case 'comments':
      if (!Array.isArray(m.items) || !m.items.every(isComment)) return { error: 'comments needs items: valid Comment[]' };
      return { type: 'comments', items: (m.items as Comment[]).map(toComment) };
    case 'interrupt':
      return { type: 'interrupt' };
    case 'permission':
      if (!isPermission(m)) return { error: 'permission needs string id and boolean allow' };
      return { type: 'permission', id: m.id as string, allow: m.allow as boolean };
    default:
      return { error: `unknown message type: ${String(m.type)}` };
  }
}
