import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';

/** `ref`: the branch a file comes from when it is not this window's checkout (a branch, or a worktree's branch). */
export type AnchorSource = { kind: 'message'; id: string } | { kind: 'file'; path: string; ref?: string };
export type FileSource = Extract<AnchorSource, { kind: 'file' }>;
export const MARK_COLORS = ['#ff3b30', '#ffcc00', '#34c759', '#0a84ff', '#ffffff'] as const;
export type MarkColor = (typeof MARK_COLORS)[number];
/** the largest mark image (`/marks`) the server takes */
export const MARK_MAX_BYTES = 25 * 1024 * 1024;
/** the most values (x and y each count) a pen stroke may carry */
export const PEN_MAX_VALUES = 20000;
/** all coordinates are relative to the media's natural size, 0..1 */
export type MediaShape =
  | { kind: 'rect' | 'ellipse'; color: MarkColor; x: number; y: number; w: number; h: number }
  | { kind: 'arrow'; color: MarkColor; x1: number; y1: number; x2: number; y2: number }
  | { kind: 'pen'; color: MarkColor; points: number[] };
export type MediaAnchor = {
  kind: 'media'; source: FileSource; width: number; height: number;
  /** seconds at the pause (video only), ms precision */
  time?: number;
  /** the /file ETag when drawn */
  version?: string;
  /** set only when the frame and layer files were downscaled to fit MARK_MAX_BYTES (0 < scale < 1; both files) */
  scale?: number;
  shapes: MediaShape[];
};
export type TextAnchor = { source: AnchorSource; start: number; end: number; quote: string; prefix: string; suffix: string };
export type Anchor = TextAnchor | MediaAnchor;
export const isMediaAnchor = (a: Anchor): a is MediaAnchor => (a as MediaAnchor).kind === 'media';
export const QUICK_LABEL_IDS = ['looks-good', 'fire', 'clarify', 'verify', 'example', 'overview', 'patterns',
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

/**
 * What this server understands beyond the base protocol, announced in `hello` on connect. Every window serves the one
 * shared `web/dist`, so a reloaded page can be newer than its server (until "Restart the server"): the page sends a newer
 * message only to a server that announced it. 1: `activity` and `idle-compact`; 2: `mode` ids answered with `ack`; 3: the `fire` quick label; 4: media anchors and `/marks`.
 */
export const PROTOCOL = 4;

export const MODES = ['default', 'acceptEdits', 'plan', 'auto'] as const;
export type Mode = (typeof MODES)[number];
/** percent 0..100 */
export type Limit = { utilization: number; resets_at: string | null };
export type Stats = {
  context: { used: number; max: number; pct: number } | null;
  limits: { five_hour: Limit | null; seven_day: Limit | null } | null;
  cost: number | null;
};

export type ClientMessage =
  | { type: 'send'; id: string; text: string; force?: boolean; commentIds?: string[]; images?: ImageRef[] }
  /** full replacement of this session's comment set */
  | { type: 'comments'; sessionId: string | null; items: Comment[] }
  | { type: 'interrupt' }
  /** `input` is ignored by the server (an allow always runs the original input); no client sends it. */
  | { type: 'permission'; id: string; allow: boolean; input?: Record<string, unknown> }
  /** `id`: echoed back as the `mode` event's `ack`, so the sender can tell its own echo from the others */
  | { type: 'mode'; mode: Mode; id?: string }
  | { type: 'command'; name: 'compact' | 'clear' }
  /** id null = a new session in dir; dir is absolute */
  | { type: 'switch'; id: string | null; dir: string }
  | { type: 'restart' }
  /** the user touched the UI (throttled by the client): the idle-compaction clock starts again */
  | { type: 'activity' }
  /** idle compaction on or off for this project */
  | { type: 'idle-compact'; on: boolean };

/**
 * Idle compaction of this window's project. `on` is the project's setting; `blocked`: `"idleCompaction": false` in the
 * user's Claude Code settings.json keeps it off whatever `on` says.
 */
/** `minutes` after the last turn, if the window saw no activity for `awayMinutes` */
export type IdleCompact = { on: boolean; blocked: boolean; minutes: number; awayMinutes: number; minTokens: number };

export type ServerEvent =
  /** right after the replay on every connection (servers before it send none: protocol 0) */
  | { kind: 'hello'; protocol: number }
  | { kind: 'replay'; events: ServerEvent[] }
  | { kind: 'sdk'; m: SDKMessage; ts: number }
  /** `idle`: a `/compact` the server sent itself after the session sat idle */
  | { kind: 'user'; id: string; text: string; ts: number; force?: boolean; historic?: boolean; images?: ImageRef[]; idle?: boolean }
  | { kind: 'permission'; id: string; toolName: string; input: Record<string, unknown>; ts: number }
  | { kind: 'permission-done'; id: string; allow: boolean; ts: number }
  /** full comment set; never stored in history, so no ts */
  | { kind: 'comments'; items: Comment[] }
  | { kind: 'session'; id: string | null; root: string; title: string | null; model: string | null }
  /** never stored in history */
  | { kind: 'stats'; stats: Stats }
  /** never stored in history */
  /** `ack`: the id of the `mode` message this answers (none when the mode changed otherwise) */
  | { kind: 'mode'; mode: Mode; ack?: string }
  /** never stored in history */
  | { kind: 'idle-compact'; state: IdleCompact }
  /** stored once after the replayed transcript of a resumed session; the only source of the "resumed" notice */
  | { kind: 'resumed'; id: string }
  | { kind: 'server-error'; where: string; message: string }
  /** to the asking socket only, never stored: a `send` the server did not take (the web side clears its pending state) */
  | { kind: 'send-refused'; id: string; reason: 'busy' | 'switching' };

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

function isFileSource(s: Obj): boolean {
  const refOk = s.ref === undefined || (typeof s.ref === 'string' && s.ref.length > 0 && s.ref.length <= 200);
  return s.kind === 'file' && typeof s.path === 'string' && refOk;
}

const isRel = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1;
const isPos = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0;
const isMarkColor = (v: unknown): v is MarkColor => (MARK_COLORS as readonly unknown[]).includes(v);

function isMediaShape(v: unknown): v is MediaShape {
  if (!isObj(v) || !isMarkColor(v.color)) return false;
  switch (v.kind) {
    case 'rect':
    case 'ellipse':
      return isRel(v.x) && isRel(v.y) && isRel(v.w) && isRel(v.h) && v.w > 0 && v.h > 0;
    case 'arrow':
      return isRel(v.x1) && isRel(v.y1) && isRel(v.x2) && isRel(v.y2);
    case 'pen':
      return Array.isArray(v.points) && v.points.length >= 2 && v.points.length <= PEN_MAX_VALUES
        && v.points.length % 2 === 0 && v.points.every(isRel);
    default:
      return false;
  }
}

function isMediaAnchorShape(v: Obj): boolean {
  return isObj(v.source) && isFileSource(v.source) && isPos(v.width) && isPos(v.height)
    && (v.time === undefined || (typeof v.time === 'number' && Number.isFinite(v.time) && v.time >= 0))
    && (v.version === undefined || (typeof v.version === 'string' && v.version.length <= 200))
    && (v.scale === undefined || (typeof v.scale === 'number' && v.scale > 0 && v.scale < 1))
    && Array.isArray(v.shapes) && v.shapes.length > 0 && v.shapes.every(isMediaShape);
}

function isAnchor(v: unknown): v is Anchor {
  if (!isObj(v)) return false;
  if (v.kind === 'media') return isMediaAnchorShape(v);
  if (!isObj(v.source)) return false;
  const s = v.source;
  const sourceOk = (s.kind === 'message' && typeof s.id === 'string') || isFileSource(s);
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
  return typeof o.id === 'string' && typeof o.allow === 'boolean' && (o.input === undefined || isObj(o.input));
}

const SESSION_ID = /^[0-9a-f-]{36}$/i;
const isMode = (v: unknown): v is Mode => (MODES as readonly unknown[]).includes(v);
const isSessionId = (v: unknown): v is string => typeof v === 'string' && SESSION_ID.test(v);

function toSource(s: AnchorSource): AnchorSource {
  if (s.kind === 'message') return { kind: 'message', id: s.id };
  return s.ref === undefined ? { kind: 'file', path: s.path } : { kind: 'file', path: s.path, ref: s.ref };
}

function toShape(s: MediaShape): MediaShape {
  switch (s.kind) {
    case 'rect':
    case 'ellipse': return { kind: s.kind, color: s.color, x: s.x, y: s.y, w: s.w, h: s.h };
    case 'arrow': return { kind: 'arrow', color: s.color, x1: s.x1, y1: s.y1, x2: s.x2, y2: s.y2 };
    case 'pen': return { kind: 'pen', color: s.color, points: [...s.points] };
  }
}

/** exported for tests */
export function toAnchor(a: Anchor): Anchor {
  if (isMediaAnchor(a)) {
    return {
      kind: 'media', source: toSource(a.source) as FileSource, width: a.width, height: a.height,
      ...(a.time === undefined ? {} : { time: a.time }),
      ...(a.version === undefined ? {} : { version: a.version }),
      ...(a.scale === undefined ? {} : { scale: a.scale }),
      shapes: a.shapes.map(toShape),
    };
  }
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
      if (m.sessionId !== null && typeof m.sessionId !== 'string') return { error: 'comments needs sessionId: string | null' };
      if (!Array.isArray(m.items) || !m.items.every(isComment)) return { error: 'comments needs items: valid Comment[]' };
      return { type: 'comments', sessionId: m.sessionId, items: (m.items as Comment[]).map(toComment) };
    case 'interrupt':
      return { type: 'interrupt' };
    case 'permission':
      if (!isPermission(m)) return { error: 'permission needs string id and boolean allow' };
      return {
        type: 'permission', id: m.id as string, allow: m.allow as boolean,
        ...(m.input === undefined ? {} : { input: m.input as Record<string, unknown> }),
      };
    case 'mode':
      if (!isMode(m.mode)) return { error: `mode must be one of ${MODES.join(', ')}` };
      if (m.id !== undefined && (typeof m.id !== 'string' || m.id.length > 64)) return { error: 'mode id must be a short string' };
      return { type: 'mode', mode: m.mode, ...(m.id !== undefined && { id: m.id }) };
    case 'command':
      if (m.name !== 'compact' && m.name !== 'clear') return { error: 'command name must be compact or clear' };
      return { type: 'command', name: m.name };
    case 'switch':
      if (m.id !== null && !isSessionId(m.id)) return { error: 'switch needs id: session uuid or null' };
      if (typeof m.dir !== 'string' || !m.dir.startsWith('/')) return { error: 'switch needs an absolute dir' };
      return { type: 'switch', id: m.id, dir: m.dir };
    case 'restart':
      return { type: 'restart' };
    case 'activity':
      return { type: 'activity' };
    case 'idle-compact':
      if (typeof m.on !== 'boolean') return { error: 'idle-compact needs boolean on' };
      return { type: 'idle-compact', on: m.on };
    default:
      return { error: `unknown message type: ${String(m.type)}` };
  }
}
