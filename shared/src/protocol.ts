import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';

/** `ref`: the branch a file comes from when it is not this window's checkout (a branch, or a worktree's branch). */
export type AnchorSource = { kind: 'message'; id: string } | { kind: 'file'; path: string; ref?: string };
export type Anchor = { source: AnchorSource; start: number; end: number; quote: string; prefix: string; suffix: string };
export const QUICK_LABEL_IDS = ['looks-good', 'clarify', 'verify', 'example', 'overview', 'patterns',
  'alternatives', 'no-regression', 'out-of-scope', 'needs-tests'] as const;
export type QuickLabelId = (typeof QUICK_LABEL_IDS)[number];
export const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] as const;
export type ImageType = (typeof IMAGE_TYPES)[number];
/** id = sha256 hex (64 chars) of the stored bytes */
export type ImageRef = { id: string; mediaType: ImageType; label: string };
export type TreeEntry = { name: string; dir: boolean };
/**
 * Where files are read from (M3-16, read-only). Stable ids (persisted in tabs and tree state): 'here' (this window's
 * checkout), `ref:<branch>` (any other local branch), `dir:<12 hex of sha1(realpath)>` (a detached worktree).
 * `kind`/`dir` describe how it is served NOW: 'worktree' = from that live folder (absolute, realpath), 'branch' = from
 * git blobs. `ref`: the branch name ('' for a non-repo or a detached `here`; `(detached) <folder>` for a detached
 * worktree). `alias`: 'here' as the server was started with, when that differs from its realpath.
 */
export type Source = { id: string; kind: 'checkout' | 'worktree' | 'branch'; label: string; ref: string; dir?: string; alias?: string };
export type Comment = {
  id: string; anchor: Anchor; text: string; label?: QuickLabelId;
  status: 'pending' | 'sent'; createdAt: number;
  /** id of the user message that carried it */
  sentIn?: string;
  /** attachment ids; labels are assigned at send time */
  images?: string[];
};

export type ClientMessage =
  | { type: 'send'; id: string; text: string; force?: boolean; commentIds?: string[]; images?: ImageRef[] }
  /** full replacement of this session's comment set */
  | { type: 'comments'; items: Comment[] }
  | { type: 'interrupt' }
  | { type: 'permission'; id: string; allow: boolean };

export type ServerEvent =
  | { kind: 'replay'; events: ServerEvent[] }
  | { kind: 'sdk'; m: SDKMessage; ts: number }
  | { kind: 'user'; id: string; text: string; ts: number; force?: boolean; historic?: boolean; images?: ImageRef[] }
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
    && (o.commentIds === undefined || isStringArray(o.commentIds))
    && (o.images === undefined || (Array.isArray(o.images) && o.images.every(isImageRef)));
}

const IMAGE_ID = /^[0-9a-f]{64}$/;

function isImageId(v: unknown): v is string {
  return typeof v === 'string' && IMAGE_ID.test(v);
}

function isImageRef(v: unknown): v is ImageRef {
  return isObj(v) && isImageId(v.id) && (IMAGE_TYPES as readonly unknown[]).includes(v.mediaType)
    && typeof v.label === 'string';
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
  const refOk = s.ref === undefined || (typeof s.ref === 'string' && s.ref.length > 0 && s.ref.length <= 200);
  const sourceOk = (s.kind === 'message' && typeof s.id === 'string') || (s.kind === 'file' && typeof s.path === 'string' && refOk);
  return sourceOk && isOffset(v.start) && isOffset(v.end) && v.end >= v.start
    && typeof v.quote === 'string' && typeof v.prefix === 'string' && typeof v.suffix === 'string';
}

function isComment(v: unknown): v is Comment {
  if (!isObj(v) || typeof v.id !== 'string' || !isAnchor(v.anchor) || typeof v.text !== 'string') return false;
  const labelOk = v.label === undefined || (QUICK_LABEL_IDS as readonly unknown[]).includes(v.label);
  // empty text is allowed only for a one-click quick label
  const textOk = v.text !== '' || v.label !== undefined;
  return labelOk && textOk && (v.status === 'pending' || v.status === 'sent') && isOffset(v.createdAt)
    && (v.sentIn === undefined || typeof v.sentIn === 'string')
    && (v.images === undefined || (Array.isArray(v.images) && v.images.every(isImageId)));
}

function isPermission(o: Obj): boolean {
  return typeof o.id === 'string' && typeof o.allow === 'boolean';
}

function toSource(s: AnchorSource): AnchorSource {
  if (s.kind === 'message') return { kind: 'message', id: s.id };
  return s.ref === undefined ? { kind: 'file', path: s.path } : { kind: 'file', path: s.path, ref: s.ref };
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
    ...(c.images === undefined ? {} : { images: [...c.images] }),
  };
}

function toImageRef(i: ImageRef): ImageRef {
  return { id: i.id, mediaType: i.mediaType, label: i.label };
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
      if (!isSend(m)) return { error: 'send needs string id, string text, optional boolean force and optional string[] commentIds and optional images: ImageRef[]' };
      return {
        type: 'send', id: m.id as string, text: m.text as string,
        ...(m.force === undefined ? {} : { force: m.force as boolean }),
        ...(m.commentIds === undefined ? {} : { commentIds: m.commentIds as string[] }),
        ...(m.images === undefined ? {} : { images: (m.images as ImageRef[]).map(toImageRef) }),
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
