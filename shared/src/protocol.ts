import type { WireAgentEvent } from './agent.ts';

/** A tool-use id as the wire carries it (the Agent call's id, `agent` of a source, `tool` of `/subagent`): ids only, never path pieces. */
export const TOOL_USE_ID = /^[A-Za-z0-9_-]{1,128}$/;
/** A task id as the wire carries it (`task-stop`, `/task-output?task=`): the CLI's own ids (`b4k2x9...`), never a path piece. */
export const TASK_ID = /^[A-Za-z0-9_-]{1,128}$/;
/** A `! cmd` run's id (`shell-run`, `shell-stop`, the `shell-*` events): the client's uuid. */
export const SHELL_ID = /^[A-Za-z0-9_-]{1,128}$/;
/** The longest `cmd` of `shell-run` the server takes, in bytes. */
export const SHELL_CMD_MAX = 32 * 1024;
/** The last `cap` characters of `s`, never starting inside a surrogate pair. */
export function cutTail(s: string, cap: number): string {
  if (s.length <= cap) return s;
  const t = s.slice(s.length - cap);
  const c = t.charCodeAt(0);
  return c >= 0xdc00 && c <= 0xdfff ? t.slice(1) : t;
}
/** What a `! cmd` run keeps of its output (in the feed, and for the agent): the last 64 K characters, the cut marked `truncated`. */
export const SHELL_OUTPUT_CAP = 64 * 1024;

/** `ref`: the branch a file comes from when it is not this window's checkout (a branch, or a worktree's branch). */
export type AnchorSource = { kind: 'message'; id: string; /** the toolUseId of the subagent whose conversation holds the item (protocol 7); absent: the main chat */ agent?: string } | { kind: 'file'; path: string; ref?: string };
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
/** A 3D view's camera (protocol 9): where it is, what it looks at, its vertical field of view in degrees (0 < fov < 180). */
export type ModelCamera = { position: [number, number, number]; target: [number, number, number]; fov: number };
export type MediaAnchor = {
  kind: 'media'; source: FileSource; width: number; height: number;
  /** seconds at the pause (video only), ms precision */
  time?: number;
  /** the /file ETag when drawn */
  version?: string;
  /** a 3D model comment (protocol 9): the camera the frame was rendered from. A model comment has no `time`. */
  camera?: ModelCamera;
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
  /** media comments: how many leading `images` the app generated (the frame, plus the transparent layer in old comments); the rest were pasted. Absent = 2 (old comments). */
  genImages?: number;
};

/** The number of leading generated images of a comment (0 for a non-media one); the pasted ones follow. */
export const generatedImages = (c: Comment): number => (isMediaAnchor(c.anchor) ? c.genImages ?? 2 : 0);

/**
 * What this server understands beyond the base protocol, announced in `hello` on connect. Every window serves the one
 * shared `web/dist`, so a reloaded page can be newer than its server (until "Restart the server"): the page sends a newer
 * message only to a server that announced it. 1: `activity` and `idle-compact`; 2: `mode` ids answered with `ack`; 3: the `fire` quick label; 4: media anchors and `/marks`;
 * 5: the agent's output as `agent` events (AgentEvent) instead of raw SDK frames; `replay.earlier`; one tab per window
 * (`occupied`, `taken-over`, the client's `takeover`, close code 4001, `?tab=` and `?passive=1` on the ws url);
 * `hello.capabilities`;
 * 6: the model and effort switch: the client's `model` (ids answered with `ack`), the server's `model` and `models` events,
 * `capabilities.models`;
 * 7: a message anchor may name a subagent (`source.agent`, the Agent call's tool-use id) and `GET /subagent` serves its conversation;
 * 8: the client's `task-stop` and `task-background`, and `GET /task-output` (a shell task's output tail);
 * 9: a media anchor may carry a `camera` (a comment on a 3D model view); an older server would drop it, so the client offers markup on a model only from 9;
 * 10: the server's `commands` event (the slash menu's list); an older server sends none, so the menu stays closed;
 * 11: `! cmd` in the composer: the client's `shell-run` and `shell-stop`, the server's `shell-start`, `shell-out` and `shell-end` events. An older server would send `! cmd` to the agent, so the page runs it as a shell command only from 11.
 */
export const PROTOCOL = 11;

/** close code the owner gets when another tab takes the window over (R-M7-5/8); the page never reconnects after it by itself */
export const TAKEN_OVER_CODE = 4001;

export const MODES = ['default', 'acceptEdits', 'plan', 'auto'] as const;
export type Mode = (typeof MODES)[number];

export const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type EffortLevel = (typeof EFFORT_LEVELS)[number];
/**
 * A model the agent offers. `value` is what is sent back to pick it (an alias such as `sonnet`); `resolved` the full id
 * the agent reports for it once running (`claude-…`), to match the two; `efforts` only for a model that has effort levels.
 */
export type ModelOption = { value: string; name: string; description: string; resolved?: string; efforts?: EffortLevel[] };
/**
 * A slash command or skill the composer's `/` menu offers (already filtered by the server: nothing bound to a terminal).
 * `hint` is the argument hint (`[name]`), `aliases` other names that run it; `builtin`: the agent's own, not the user's or a plugin's.
 */
export type SlashCommand = { name: string; description: string; hint?: string; aliases?: string[]; builtin?: boolean };
/** a model with its effort; the model alone when the effort is the model's default */
export type ModelChoice = { model: string; effort?: EffortLevel };

/**
 * What the agent behind the server can do (R-M7-15), announced in `hello`; the UI hides a control whose capability is
 * false and the server refuses the matching client message. `modes`: the permission modes it offers (empty: no mode pill).
 * `models`: it lists models and switches model and effort on a running session (the server refuses the `model` message otherwise).
 */
export type Capabilities = {
  compact: boolean; clear: boolean; modes: Mode[]; usage: boolean; fileSuggestions: boolean; fork: boolean; idleCompact: boolean; models: boolean;
  /** the server runs with the experimental 3D viewer on (env NOTA_BENE_EXPERIMENTAL_3D=1); absent / false: model files are plain files. Set by the server, not by the agent. */
  model3d?: boolean;
};
/** Claude Code's set; the web assumes it when `hello` carries none (a server older than protocol 5). */
export const CLAUDE_CAPABILITIES: Capabilities = {
  compact: true, clear: true, modes: [...MODES], usage: true, fileSuggestions: true, fork: true, idleCompact: true, models: true,
};
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
  /** `model` is a `ModelOption.value`; no `effort` = the model's default. `id`: echoed as the `model` event's `ack` */
  | { type: 'model'; model: string; effort?: EffortLevel; id?: string }
  | { type: 'command'; name: 'compact' | 'clear' }
  /** id null = a new session in dir; dir is absolute */
  | { type: 'switch'; id: string | null; dir: string }
  | { type: 'restart' }
  /** the user touched the UI (throttled by the client): the idle-compaction clock starts again */
  | { type: 'activity' }
  /** idle compaction on or off for this project */
  | { type: 'idle-compact'; on: boolean }
  /** from an occupied socket (R-M7-5): the window moves here; the old owner is closed with 4001 */
  | { type: 'takeover' }
  /** protocol 8: stop the running task `id` (a task_id); a refusal comes back as a `server-error` */
  | { type: 'task-stop'; id: string }
  /** protocol 8: move the foreground task started by the tool call `toolUseId` to the background; a refusal (or no match) comes back as a `server-error` */
  | { type: 'task-background'; toolUseId: string }
  /** protocol 11: run `cmd` (at most SHELL_CMD_MAX bytes) as a shell command in the project folder, outside the agent; a refusal comes back as a `server-error` */
  | { type: 'shell-run'; id: string; cmd: string }
  /** protocol 11: stop the run `id` (TERM, then KILL); no match is no news */
  | { type: 'shell-stop'; id: string };

/**
 * Idle compaction of this window's project. `on` is the project's setting; `blocked`: `"idleCompaction": false` in the
 * user's Claude Code settings.json keeps it off whatever `on` says.
 */
/** `minutes` after the last turn, if the window saw no activity for `awayMinutes` */
export type IdleCompact = { on: boolean; blocked: boolean; minutes: number; awayMinutes: number; minTokens: number };

export type ServerEvent =
  /** another tab owns the window (R-M7-5): to a later socket only, followed by `hello`; no replay, no state */
  | { kind: 'occupied' }
  /** to the owner just before it is closed with code 4001: another tab took the window over */
  | { kind: 'taken-over' }
  /** right after the replay on every connection (servers before it send none: protocol 0) */
  | { kind: 'hello'; protocol: number; capabilities?: Capabilities; /** the UI language chosen on any window (server prefs.json); absent = none chosen yet */ lang?: 'ru' | 'en' }
  /** `earlier`: how many segments of this conversation, from before its compactions, `/history` holds (R-M7-4); absent for none */
  | { kind: 'replay'; events: ServerEvent[]; earlier?: number }
  /** what the agent said (R-M7-14); `init` and `rate-limit` are server-internal and never sent */
  | { kind: 'agent'; e: WireAgentEvent; ts: number }
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
  /** the model the agent runs (null until known) and its effort when set; never stored. `ack`: the id of the `model` message this answers */
  | { kind: 'model'; model: string | null; effort?: EffortLevel; ack?: string }
  /** the models the agent offers; never stored */
  | { kind: 'models'; models: ModelOption[] }
  /** the slash commands and skills of the session (user's first), replacing the last list; never stored */
  | { kind: 'commands'; commands: SlashCommand[] }
  /** never stored in history */
  | { kind: 'idle-compact'; state: IdleCompact }
  /** stored once after the replayed transcript of a resumed session; the only source of the "resumed" notice */
  | { kind: 'resumed'; id: string }
  | { kind: 'server-error'; where: string; message: string }
  /** to the asking socket only, never stored: a `send` the server did not take (the web side clears its pending state) */
  | { kind: 'send-refused'; id: string; reason: 'busy' | 'switching' }
  /** a `! cmd` run began (protocol 11); stored, so a reload shows the block */
  | { kind: 'shell-start'; id: string; cmd: string; ts: number }
  /**
   * the output of the run `id` so far, ANSI stripped, stdout and stderr merged: the last SHELL_OUTPUT_CAP characters, REPLACING what the
   * page shows (`truncated`: more came before). Sent at most about ten times a second, and not to a socket that is far behind, so
   * a flood cannot pile up in the server; live only. A new socket gets the output so far in one of these.
   */
  | { kind: 'shell-out'; id: string; text: string; truncated: boolean }
  /** to the asking socket only, never stored: a `shell-run` the server did not take (the page puts the draft back) */
  | { kind: 'shell-refused'; id: string; reason: 'running' | 'switching' }
  /**
   * the run `id` ended. `output`: its merged output, the last SHELL_OUTPUT_CAP characters (`truncated`: more came before).
   * `code`: the exit code (null: killed by a signal, or never started); `stop`: why the server stopped it (the user's
   * `shell-stop`, the timeout; a switch or a close stops quietly and ends nothing); `error`: it could not start. `cmd` again: the start may have been archived by then.
   */
  | { kind: 'shell-end'; id: string; cmd: string; output: string; truncated: boolean; code: number | null; stop?: ShellStop; error?: string; ts: number };

export type ShellStop = 'user' | 'timeout';

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
/** Slack for a box that ends at the edge: its ends are rounded to 4 decimals independently. */
const EDGE_EPS = 1e-4;
const isMarkColor = (v: unknown): v is MarkColor => (MARK_COLORS as readonly unknown[]).includes(v);

function isMediaShape(v: unknown): v is MediaShape {
  if (!isObj(v) || !isMarkColor(v.color)) return false;
  switch (v.kind) {
    case 'rect':
    case 'ellipse':
      return isRel(v.x) && isRel(v.y) && isRel(v.w) && isRel(v.h) && v.w > 0 && v.h > 0
        && v.x + v.w <= 1 + EDGE_EPS && v.y + v.h <= 1 + EDGE_EPS; // inside the media
    case 'arrow':
      return isRel(v.x1) && isRel(v.y1) && isRel(v.x2) && isRel(v.y2);
    case 'pen':
      return Array.isArray(v.points) && v.points.length >= 2 && v.points.length <= PEN_MAX_VALUES
        && v.points.length % 2 === 0 && v.points.every(isRel);
    default:
      return false;
  }
}

const isVec3 = (v: unknown): v is [number, number, number] => Array.isArray(v) && v.length === 3 && v.every((x) => typeof x === 'number' && Number.isFinite(x));
function isCamera(v: unknown): v is ModelCamera {
  return isObj(v) && isVec3(v.position) && isVec3(v.target) && typeof v.fov === 'number' && Number.isFinite(v.fov) && v.fov > 0 && v.fov < 180;
}

function isMediaAnchorShape(v: Obj): boolean {
  return isObj(v.source) && isFileSource(v.source) && isPos(v.width) && isPos(v.height)
    && (v.time === undefined || (typeof v.time === 'number' && Number.isFinite(v.time) && v.time >= 0))
    && (v.version === undefined || (typeof v.version === 'string' && v.version.length <= 200))
    && (v.camera === undefined || (isCamera(v.camera) && v.time === undefined)) // a model comment has no time
    && (v.scale === undefined || (typeof v.scale === 'number' && v.scale > 0 && v.scale < 1))
    && Array.isArray(v.shapes) && v.shapes.length > 0 && v.shapes.every(isMediaShape);
}

function isAnchor(v: unknown): v is Anchor {
  if (!isObj(v)) return false;
  if (v.kind === 'media') return isMediaAnchorShape(v);
  if (!isObj(v.source)) return false;
  const s = v.source;
  const sourceOk = (s.kind === 'message' && typeof s.id === 'string' && (s.agent === undefined || (typeof s.agent === 'string' && TOOL_USE_ID.test(s.agent)))) || isFileSource(s);
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
    && (v.images === undefined || (Array.isArray(v.images) && v.images.every(isImageId)))
    && (v.genImages === undefined || isOffset(v.genImages));
}

function isPermission(o: Obj): boolean {
  return typeof o.id === 'string' && typeof o.allow === 'boolean' && (o.input === undefined || isObj(o.input));
}

const SESSION_ID = /^[0-9a-f-]{36}$/i;
const isMode = (v: unknown): v is Mode => (MODES as readonly unknown[]).includes(v);
const isEffort = (v: unknown): v is EffortLevel => (EFFORT_LEVELS as readonly unknown[]).includes(v);
const isSessionId = (v: unknown): v is string => typeof v === 'string' && SESSION_ID.test(v);

function toSource(s: AnchorSource): AnchorSource {
  if (s.kind === 'message') return s.agent === undefined ? { kind: 'message', id: s.id } : { kind: 'message', id: s.id, agent: s.agent };
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

const toCamera = (c: ModelCamera): ModelCamera => ({ position: [c.position[0], c.position[1], c.position[2]], target: [c.target[0], c.target[1], c.target[2]], fov: c.fov });

/** exported for tests */
export function toAnchor(a: Anchor): Anchor {
  if (isMediaAnchor(a)) {
    return {
      kind: 'media', source: toSource(a.source) as FileSource, width: a.width, height: a.height,
      ...(a.time === undefined ? {} : { time: a.time }),
      ...(a.version === undefined ? {} : { version: a.version }),
      ...(a.camera === undefined ? {} : { camera: toCamera(a.camera) }),
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
    ...(c.genImages === undefined ? {} : { genImages: c.genImages }),
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
    case 'model':
      if (typeof m.model !== 'string' || m.model === '' || m.model.length > 200) return { error: 'model needs a model id string' };
      if (m.effort !== undefined && !isEffort(m.effort)) return { error: `effort must be one of ${EFFORT_LEVELS.join(', ')}` };
      if (m.id !== undefined && (typeof m.id !== 'string' || m.id.length > 64)) return { error: 'model id must be a short string' };
      return { type: 'model', model: m.model, ...(m.effort !== undefined && { effort: m.effort }), ...(m.id !== undefined && { id: m.id }) };
    case 'command':
      if (m.name !== 'compact' && m.name !== 'clear') return { error: 'command name must be compact or clear' };
      return { type: 'command', name: m.name };
    case 'switch':
      if (m.id !== null && !isSessionId(m.id)) return { error: 'switch needs id: session uuid or null' };
      if (typeof m.dir !== 'string' || !m.dir.startsWith('/')) return { error: 'switch needs an absolute dir' };
      return { type: 'switch', id: m.id, dir: m.dir };
    case 'restart':
      return { type: 'restart' };
    case 'takeover':
      return { type: 'takeover' };
    case 'activity':
      return { type: 'activity' };
    case 'task-stop':
      if (typeof m.id !== 'string' || !TASK_ID.test(m.id)) return { error: 'task-stop needs a task id' };
      return { type: 'task-stop', id: m.id };
    case 'task-background':
      if (typeof m.toolUseId !== 'string' || !TOOL_USE_ID.test(m.toolUseId)) return { error: 'task-background needs a tool-use id' };
      return { type: 'task-background', toolUseId: m.toolUseId };
    case 'shell-run':
      if (typeof m.id !== 'string' || !SHELL_ID.test(m.id)) return { error: 'shell-run needs a run id' };
      if (typeof m.cmd !== 'string' || m.cmd.trim() === '') return { error: 'shell-run needs a command' };
      if (new TextEncoder().encode(m.cmd).length > SHELL_CMD_MAX) return { error: `shell-run command is longer than ${SHELL_CMD_MAX} bytes` };
      return { type: 'shell-run', id: m.id, cmd: m.cmd };
    case 'shell-stop':
      if (typeof m.id !== 'string' || !SHELL_ID.test(m.id)) return { error: 'shell-stop needs a run id' };
      return { type: 'shell-stop', id: m.id };
    case 'idle-compact':
      if (typeof m.on !== 'boolean') return { error: 'idle-compact needs boolean on' };
      return { type: 'idle-compact', on: m.on };
    default:
      return { error: `unknown message type: ${String(m.type)}` };
  }
}

export type { AgentEvent, StopReason, WireAgentEvent } from './agent.ts';
export { FINISHED_CAP, orderedTasks, reduceTasks, taskKind, type Task, type TaskKind, type TasksState, type TaskStatus } from './tasks.ts';

/** `GET /subagent` (protocol 7): a subagent's conversation as feed events, whether it still runs, and what the Agent call named it. */
export type SubagentView = { events: ServerEvent[]; running: boolean; type: string; description: string };

/** `GET /task-output` (protocol 8): the end of a shell / Monitor task's output (at most 8 KiB, may hold escape sequences), its size, and whether it still runs. */
export type TaskOutputView = { output: string; totalBytes: number; truncated: boolean; running: boolean };
