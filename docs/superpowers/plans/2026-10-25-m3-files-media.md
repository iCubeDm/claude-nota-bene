# M3 Files & Media Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The daily file and media workflow of the prototype, inside the rebuild:
- a tab strip with the chat pinned first, and a context menu on tabs;
- a file tree;
- file tabs with viewers for md, code, image, video and audio, with Range seeking;
- picture-in-picture without the prototype's loop;
- clickable project paths;
- `@` mentions;
- image attachments;
- comments on files;
- read-only browsing of other branches and worktrees.

M3 is the first of three milestones (M3 → M4 → M5) that bring the rebuild to full prototype parity, so that the user can switch. M2 comes after M5 (spec → Milestones → Order).

**Architecture:**
- **The server owns the file system and attachments.**
  - `/tree`, `/file` (Range) and `/complete` are scoped to the project root, symlinks included.
  - Attachments are content-addressed blobs under `~/.nota-bene/attachments/`, and only their ids travel over the socket.
- **The web adds a `tabs` slice.**
  - All open tabs stay mounted. Inactive ones are only hidden, so media keeps playing and the chat keeps its scroll.
  - Each pane (chat or file) has its own highlight layer, and comments are matched to a pane by their `AnchorSource`.

**Tech Stack:** as M1 (Node 26 TS, React 19, Redux Toolkit 2.13, Tailwind 4, shadcn/ui on `radix-ui` 1.8.1, marked, highlight.js, DOMPurify, Vitest 5, Playwright 1.64). No new dependencies: the context menu is `radix-ui`'s ContextMenu.

**Spec:** `docs/superpowers/specs/2026-10-24-nota-bene-rebuild-design.md`. Relevant sections:
- Parity checklist → Files & media (M3);
- the tab strip and tab context menu items under Agents & tasks;
- Follow-ups → Media and picture-in-picture loop;
- Server → Range.

**Base:** branch `m3-files` from `main` (00533f2 + this plan).

## Global Constraints

- M0 and M1 rules still hold.
  - One task is one small commit with What / Why / Verified by and the trailer `Task: M3-NN`.
  - Every UI string goes through `t()` in both ru and en.
  - No state in the repo; state lives in `~/.nota-bene/` (`NOTA_BENE_HOME`).
  - `prototype/` is untouched, except for bug fixes.
- The server binds 127.0.0.1.
  - Every route checks Host.
  - Every non-GET route also requires an `Origin` header from the allowed list (403 otherwise). This is new for `POST /attach`; it is the prototype's `originOk`.
- Ports:
  - 4790 for manual smoke runs;
  - 4791–4793 for e2e;
  - never 4777–4781 (live windows).
- Values copied from the prototype, verbatim:
  - `VIDEO = /\.(mp4|mov|webm|m4v)$/i`, `AUDIO = /\.(mp3|wav|m4a|ogg)$/i`, `IMAGE = /\.(png|jpe?g|gif|webp|svg)$/i`;
  - `AT_RE = /(^|\s)@("[^"]*|[^\s"]*)$/`;
  - `isPath(p) = !/^(https?:|~|\/)/.test(p) && !/[\n`<>|*]/.test(p) && (/\//.test(p) || /\.[a-z0-9]{1,5}$/i.test(p))`;
  - `IMG_OK = ['image/png','image/jpeg','image/gif','image/webp']`, `IMG_EDGE = 1568`, `IMG_BYTES = 3.5e6`;
  - the tree hides `.git`, `node_modules` and `.DS_Store`, sorts folders first, then `localeCompare(b, 'ru', { numeric: true })`;
  - `/complete` returns at most 30 paths;
  - i18n keys from the prototype: `noFile`, `imgLabel(k)`, `imgLabelC(k, ci)`, `imgRef(ks)`, `atNone`, `onlyImages`, `imgFail`, with the prototype's ru and en texts.
- Text files larger than 2 MB, or with a NUL byte in their first 8 KB, are not rendered: the tab shows a note and a raw link instead.
- An attachment is at most 5 MB (413 above), and its type must be in `IMG_OK` (415 otherwise).

## Review Focus

1. **Non-ASCII and unusual names.** Cyrillic, spaces, `#`, `%` and `?` in file and folder names must survive `/tree`, `/file` (including Range), tabs, refs, `@` picks and file comments. A Russian-speaking user has such files. Test in M3-02 (server) and M3-14 (e2e, a file named `Отчёт #1 (final).md`).
2. **Escaping the root.** `..`, an absolute path, an encoded `%2e%2e`, and a symlink inside the root that points outside must all get 403 and must never be listed or served. Test in M3-02.
3. **Huge and binary files.**
   - A 1 GB video seeks by Range without being read whole.
   - A 50 MB log or a binary opens as a note with a raw link and never enters the DOM.
   - `bytes=<size>-` returns 416, which was the prototype's crash.
   - Test in M3-02 (Range) and M3-08 (text guard).
4. **A file that changes or disappears while its tab is open** (the agent edits or deletes it).
   - After the live turn ends, the tab reloads.
   - Anchors re-resolve or become orphaned; they never mark the wrong text.
   - A deleted file shows `t('fileGone')` and its tab stays open.
   - Test in M3-08 and M3-13.
5. **Several media tabs and switching.**
   - Exactly one medium plays, and there is no PiP loop.
   - Leaving a playing video for a non-media tab sends it to PiP; switching between media tabs pauses the previous one.
   - Closing a tab stops its medium.
   - The chat keeps its scroll position.
   - Test in M3-09 (unit, with a stubbed PiP API) and M3-14 (e2e: play A, open B, open C).

---

## File structure

```
shared/src/protocol.ts                + ImageRef, send.images, user.images, Comment.images
server/src/files.ts                   resolveInRoot, listDir, listFiles (cached walk)
server/src/range.ts                   parseRange (RFC 9110 single range)
server/src/fileRoutes.ts              GET /tree, GET|HEAD /file, GET /complete
server/src/fuzzy.ts                   fuzzyScore (prototype `fuzzy`)
server/src/attachments.ts             AttachmentStore + POST /attach, GET /attach/<id>
server/src/agent/{types,sdk,fake}.ts  send.images, fileSuggestions
server/src/agent/transcript.ts        user images → attachment ids
server/src/http.ts / server.ts        wire routes, Origin check for non-GET
web/src/tabs/slice.ts                 tabs slice + persistence
web/src/tabs/TabStrip.tsx             strip + context menu
web/src/files/FileTree.tsx            tree sheet
web/src/files/FileView.tsx            viewers
web/src/files/kinds.ts                VIDEO/AUDIO/IMAGE/MD, fileUrl, isPath
web/src/media/mediaController.ts      PiP and pause rules
web/src/refs/refs.ts                  ref marking + open
web/src/composer/MentionPicker.tsx    @ picker
web/src/attachments/image.ts          prepareImage, upload
web/src/attachments/Attachments.tsx   thumbs + Lightbox
server/src/git.ts                     sources: this checkout, worktrees, branches
web/src/files/SourcePicker.tsx        source selector in the tree
e2e/files.spec.ts, e2e/fixtures/project/   test project with media, Cyrillic names, symlink
```

---

### M3-01: Protocol for images and files

**Files:**
- Modify: `shared/src/protocol.ts`.
- Test: `shared/src/protocol.test.ts`.

**Interfaces:**
- Produces:
```ts
export const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] as const;
export type ImageType = (typeof IMAGE_TYPES)[number];
export type ImageRef = { id: string; mediaType: ImageType; label: string }; // id = sha256 hex (64 chars)
// ClientMessage 'send' gains: images?: ImageRef[]
// ServerEvent 'user' gains:   images?: ImageRef[]
// Comment gains:              images?: string[]   // attachment ids; labels are assigned at send time
export type TreeEntry = { name: string; dir: boolean };
```

- [ ] **Step 1: Failing tests.**
  - `send with images keeps only valid refs`: a 64-hex id, a known type and a string label pass. An unknown key on a ref is dropped. A bad id (`../x`) or type (`image/heic`) rejects the whole message.
  - `comment images are ids`: a comment with `images: ['<64hex>']` round-trips, and a non-hex id is rejected.
- [ ] **Step 2: Run** `npm test -w shared` → FAIL.
- [ ] **Step 3: Implement.** Extend `isSend` and `isComment`, and the `toComment` sanitising, with `isImageRef(v): v is ImageRef` (`/^[0-9a-f]{64}$/`).
- [ ] **Step 4: Run** `npm test` and `npx tsc -b` → PASS.
- [ ] **Step 5: Commit** `feat(shared): image refs in send, user events and comments`.

### M3-02: Files on the server: tree, file, Range

**Files:**
- Create: `server/src/files.ts`, `server/src/range.ts`, `server/src/fileRoutes.ts`, and their tests.
- Modify: `server/src/http.ts` (extra routes and the Origin check for non-GET), `server/src/server.ts` (wiring).

**Interfaces:**
- Produces:
```ts
// files.ts
export function resolveInRoot(root: string, rel: string): string | null; // null = outside (also via symlink: realpath of the deepest existing ancestor must stay in realpath(root))
export function listDir(abs: string): Promise<TreeEntry[]>;
export function listFiles(root: string): Promise<string[]>; // relative, '/'-separated, skips .git/node_modules, cap 20 000, cached 10 s
// range.ts
export function parseRange(header: string | undefined, size: number): { start: number; end: number } | 'unsatisfiable' | null; // null = serve 200 whole
// fileRoutes.ts
export function fileRoutes(o: { root: string; hub: EventHub; complete: (q: string) => Promise<string[]> }): Record<string, RequestListener>; // '/tree', '/file', '/complete'
```
- Routes:
  - `GET /tree?path=<rel>` returns `TreeEntry[]` JSON. A missing folder gives 404 with `[]`; a path outside the root gives 403.
  - `GET|HEAD /file?path=<rel>` returns 200 with `Accept-Ranges: bytes`, or 206 with `Content-Range`. An unsatisfiable range gives 416 with `Content-Range: bytes */<size>`. A missing file gives 404; a path outside the root gives 403. The content type comes from the prototype's `MIME` table (`server.mjs` `MIME`), with `application/octet-stream` as the default. Every non-media file gets `text/plain; charset=utf-8` when it is a known text extension (`.md .txt .json .ts .tsx .js .mjs .css .html .py .sh .yml .yaml .toml .csv .log`).
  - A stream error ends only that response, through `reportError`.

- [ ] **Step 1: Failing tests.**
  - `parseRange`:
    - `bytes=0-99` gives {0,99};
    - `bytes=100-` gives {100,size-1};
    - `bytes=-50` gives the last 50 bytes;
    - an end past the size is clamped;
    - `bytes=<size>-` gives 'unsatisfiable';
    - `bytes=5-2` gives 'unsatisfiable';
    - a multi-range or garbage gives null.
  - `resolveInRoot`:
    - `a/../b` resolves inside the root;
    - `../x`, `/etc/passwd` and `%2e%2e` (decoded by the caller) give null;
    - a symlink `root/link → /tmp/outside` gives null for `link/file`;
    - a Cyrillic `Отчёт #1.md` resolves.
  - Routes, on a temp dir:
    - `/tree` lists folders first, sorted numerically (`2.md` before `10.md`), and hides `.git`;
    - `/file` with `Range: bytes=0-3` gives 206 and the first 4 bytes;
    - `/file` with `Range: bytes=<size>-` gives 416 and the server stays up;
    - HEAD on a missing file gives 404;
    - `/file?path=..%2Fx` gives 403;
    - `POST /attach` with a foreign Origin gives 403 (the route is stubbed here and filled in M3-03).
- [ ] **Step 2: Run** `npm test -w server` → FAIL.
- [ ] **Step 3: Implement.** The Range semantics are the prototype's `serveFile`. The Origin rule goes in `httpHandler`: any method other than GET or HEAD needs `allowedOrigins.includes(req.headers.origin)`. `allowedOrigins` is passed like `allowedHosts`.
- [ ] **Step 4: Run** `npm test` and `npx tsc -b` → PASS.
- [ ] **Step 5: Commit** `feat(server): project tree and files with Range`.

### M3-03: Attachments

**Files:**
- Create: `server/src/attachments.ts` and its test.
- Modify:
  - `server/src/agent/types.ts`, `sdk.ts`, `fake.ts` (send with images);
  - `server/src/session.ts` (resolve refs; user event carries `images`);
  - `server/src/agent/transcript.ts` (images in history become ids);
  - `server/src/server.ts`;
  - their tests.

**Interfaces:**
- Produces:
```ts
export class AttachmentStore {
  constructor(o: { dir: string });               // stateDir()/attachments
  put(bytes: Buffer, mediaType: ImageType): string; // sha256 hex; written atomically (tmp + rename) only if absent
  get(id: string): { bytes: Buffer; mediaType: ImageType } | null; // id must match /^[0-9a-f]{64}$/
}
// AgentSession.send(m: { uuid; text; priority; images?: { mediaType: ImageType; data: string /* base64 */; label: string }[] })
// SessionManager.send({ id, text, force?, images?: ImageRef[] })
export function attachmentRoutes(store: AttachmentStore): Record<string, RequestListener>; // 'POST /attach', 'GET /attach/<id>'
```
- Routes:
  - `POST /attach` takes the raw body with `content-type` set to one of `IMAGE_TYPES`. It returns `{ id, mediaType }`. A body over 5 MB gives 413 (stop reading at the cap); an unknown type gives 415.
  - `GET /attach/<id>` returns the bytes with their type and `cache-control: private, max-age=31536000, immutable`. An unknown id gives 404. Because the prefix is dynamic, http.ts matches `/attach/` with `startsWith` as a special case.
- SDK content: same as the prototype's `toContent`. A text block comes first, then a `[label text, image block]` pair for each image.
- Fake agent: a script turn may set `echoImages: true`. The reply text then ends with `images: <n>`, the number of images the turn received. M3-14 uses this.
- Transcript: a user message's base64 image blocks are `put` into the store. The user event gets `images: ImageRef[]`, where each label is the preceding text block if it looks like a label, else `[image]`. The label text blocks are removed from the bubble text.

- [ ] **Step 1: Failing tests.**
  - The same bytes stored twice give the same id and one file.
  - `get('../../etc')` gives null.
  - A 6 MB POST gives 413.
  - An `image/heic` POST gives 415.
  - A send with two refs reaches the fake agent as text, label, image, label, image, and the hub's user event carries `images` with no base64.
  - A transcript with an inline image replays as a user event with one `ImageRef`, and the stored file exists.
  - An unknown ref id in a send gives `server-error` (`where: 'attach'`). The message still goes out, without that image.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** `npm test` and `npx tsc -b` → PASS.
- [ ] **Step 5: Commit** `feat(server): content-addressed image attachments`.

### M3-04: `@` completion on the server

**Files:**
- Create: `server/src/fuzzy.ts` and its test.
- Modify: `server/src/agent/types.ts`, `sdk.ts`, `fake.ts`, `server/src/fileRoutes.ts`.

**Interfaces:**
- Produces:
```ts
export function fuzzyScore(path: string, q: string): number; // the prototype's `fuzzy`, -1 = no match
// AgentSession.fileSuggestions(query: string): Promise<string[]>
//   sdk:  q.request({ subtype: 'file_suggestions', query }) (internal API, cast), paths only
//   fake: returns the script's `suggestions` or []
export function complete(o: { session: AgentSession; root: string }, raw: string): Promise<string[]>;
// CLI hits (minus the query itself, max 30); when there are none and q is not empty: listFiles + fuzzyScore, sorted, max 30
```
- Also warm the CLI index 2 s after start with `fileSuggestions('')` (prototype); failures are ignored.

- [ ] **Step 1: Failing tests.**
  - `fuzzyScore('src/App.tsx','app')` is greater than `fuzzyScore('apps/x/readme.md','app')`, because a file-name hit ranks higher.
  - A non-subsequence gives -1.
  - `complete` uses the CLI hits when there are any.
  - `complete` falls back to the walk when the CLI throws or returns [].
  - `complete` never returns more than 30 paths.
- [ ] **Step 2–4.** **Step 5: Commit** `feat(server): @ file completion with fuzzy fallback`.

### M3-05: Tabs slice

**Files:**
- Create: `web/src/tabs/slice.ts` and its test.
- Modify: `web/src/store/store.ts` (reducer; extend the one `store.subscribe` persistence, R12).

**Interfaces:**
- Produces:
```ts
export type Tab = { id: 'chat'; kind: 'chat' } | { id: `file:${string}`; kind: 'file'; path: string };
export type TabsState = { open: Tab[]; active: Tab['id'] };      // open[0] is always the chat
export const fileTabId = (path: string) => `file:${path}` as const;
// actions
openFile(path: string)        // opens or activates
activate(id)
closeTab(id)                   // chat: no-op; closing the active one activates its left neighbour
closeOthers(id)                // keeps chat + id
closeRight(id)
closeAll()                     // keeps chat, activates it
// selectors
selectTabs(s), selectActiveTab(s): Tab
// persistence: localStorage `tabs:<root>` = { paths: string[], active: string } written on change, restored when `session.root` first arrives
```

- [ ] **Step 1: Failing tests.**
  - The chat can never be closed, by any action.
  - Opening twice keeps one tab.
  - Closing the active tab activates its left neighbour.
  - `closeRight` on the chat keeps only the chat.
  - The tabs are restored per root, and a different root does not restore them.
- [ ] **Step 2–4.** **Step 5: Commit** `feat(web): tabs slice with the chat pinned`.

### M3-06: Tab strip and context menu

**Files:**
- Create: `web/src/tabs/TabStrip.tsx`, `web/src/tabs/Panes.tsx`, and their tests.
- Modify: `web/src/App.tsx`, `web/src/shell/Header.tsx` (the comments toggle stays in the header), i18n.

**Interfaces:**
- Consumes: the M3-05 slice.
- Produces:
  - `<TabStrip/>` sits below the header. Each tab shows an icon, its name (the file's basename; the chat shows `t('chat')`) and a × button (none on the chat). It shows a pending-comment badge, and the `▶` dot that M3-09 sets through `data-playing`.
  - Middle click closes a tab.
  - The right-click menu (radix ContextMenu) has `t('close')`, `t('closeOthers')`, `t('closeRight')`, `t('closeAll')`, plus `t('copyPath')` and `t('revealInTree')` on file tabs. On the chat it offers only Close Others and Close All.
  - `<Panes/>` renders the chat `<main data-chat-pane data-pane="chat">` and one `<FileView/>` per file tab (a placeholder until M3-08). They are all mounted, and inactive panes get `hidden`.
  - `revealInTree(path)` is a thunk that opens the tree and expands to the path. Its event `tree/reveal` is consumed in M3-07.

- [ ] **Step 1: Failing tests (RTL).**
  - The context menu on the chat has no Close.
  - Close Others keeps the chat and that tab.
  - Middle click closes a tab.
  - Copy Path writes the relative path (`navigator.clipboard` stubbed).
  - The chat's scroll position survives switching to a file tab and back: the pane is the same element, not remounted.
- [ ] **Step 2–4.** **Step 5: Commit** `feat(web): tab strip with VS Code style context menu`.

### M3-07: File tree

**Files:**
- Create: `web/src/files/FileTree.tsx` and its test.
- Modify: `web/src/shell/Header.tsx` (a `#toggleTree` button), `web/src/store/feed.ts` (a `turnSeq` counter that increments on a live `result`; replay does not count), i18n.

**Interfaces:**
- Produces:
  - A left overlay sheet, 300 px wide, with a filter input, a ↻ button that spins while loading, and lazy folders through `/tree?path=`.
  - Clicking a file dispatches `openFile`.
  - The open folders are kept across refresh and are persisted in `localStorage tree:<root>`.
  - The filter hides loaded file rows whose name does not include the text. Folders stay visible; this is the prototype's `applyFilter`.
  - Each file row has a pending-comment badge.
  - `selectTurnSeq(s): number`. The tree refreshes when it changes, keeping the open folders and its scroll position.
  - `tree/reveal` opens the sheet and expands every ancestor of the path.
  - A load error shows `t('serverError', '/tree')` inline, and the rest of the tree stays usable.

- [ ] **Step 1: Failing tests.**
  - Expanding a folder fetches it once.
  - Refresh keeps the open folders.
  - A live result triggers a refresh; a replayed one does not.
  - The filter keeps folders.
  - Reveal expands the ancestors of a path.
- [ ] **Step 2–4.** **Step 5: Commit** `feat(web): file tree sheet with refresh and filter`.

### M3-08: File viewers

**Files:**
- Create: `web/src/files/kinds.ts`, `web/src/files/FileView.tsx`, and their tests.
- Modify: `web/src/feed/Markdown.tsx` (import `fileUrl` from kinds.ts; add a `baseDir` prop for relative image paths), i18n.

**Interfaces:**
- Produces:
```ts
// kinds.ts
export const VIDEO, AUDIO, IMAGE, MD = /\.(md|markdown)$/i;
export type FileKind = 'md' | 'image' | 'video' | 'audio' | 'text';
export function kindOf(path: string): FileKind;
export function fileUrl(p: string, baseDir?: string): string; // moved from Markdown.tsx; relative paths resolve against baseDir
export function isPath(p: string): boolean;                 // prototype, verbatim
// FileView
export function FileView(props: { path: string; active: boolean }): JSX.Element;
```
- Behaviour by kind:
  - **md:** `Markdown` with `final` and `baseDir`, so relative images resolve.
  - **image:** fitted to the pane; a click toggles 100 % size.
  - **video and audio:** `<video controls preload="metadata">` and `<audio controls>`.
  - **text:** highlight.js by extension, falling back to auto-detection, with line wrap off.
- Text guard: a HEAD request first. If the file is over 2 MB, or the first 8 KB contain `\0` (one `Range: bytes=0-8191` request), show the `t('tooLarge')` or `t('binary')` note with a raw link (`target=_blank`).
- Errors: 404 shows the `t('fileGone')` note and the tab stays open. Any other error shows the error text.
- The text root has `data-file-path={path}` and `data-pane={fileTabId(path)}`, which the anchors use in M3-13.
- Reload: when `turnSeq` changes, an active text or md view refetches at once, and an inactive one refetches the next time it becomes active. A ↻ button in the view toolbar reloads by hand.

- [ ] **Step 1: Failing tests.**
  - `kindOf` covers each regex.
  - `fileUrl('img/a b.png', 'docs')` gives `/file?path=docs%2Fimg%2Fa%20b.png`.
  - A 3 MB HEAD shows the too-large note and fetches no body.
  - A NUL in the probe shows the binary note.
  - 404 shows `fileGone`.
  - A `turnSeq` bump refetches the active view.
- [ ] **Step 2–4.** **Step 5: Commit** `feat(web): file viewers for markdown, code, images and media`.

### M3-09: Media rules and picture-in-picture

**Files:**
- Create: `web/src/media/mediaController.ts` and its test.
- Modify: `FileView.tsx` (register its media element), `Panes.tsx` (switch hook), `TabStrip.tsx` (`▶` dot), the tabs slice (close stops media).

**Interfaces:**
- Produces:
```ts
export type PipApi = { request(v: HTMLVideoElement): Promise<void>; exit(): Promise<void>; current(): Element | null };
export class MediaController {
  constructor(o: { pip: PipApi; activate: (tabId: string) => void });
  register(tabId: string, el: HTMLMediaElement): () => void;   // returns unregister
  onSwitch(from: string, to: string): void;                    // call before `to` is shown
  onClose(tabId: string): void;                                 // pause + exit PiP if it is this one
  playing(): string | null;                                      // tab id of the playing media, for the ▶ dot
}
```
- Rules (spec → Follow-ups, verbatim intent):
  - **Media to media:** switching from a playing media tab to another media tab never uses PiP. The previous medium pauses.
  - **Video to non-media tab:** leaving a playing **video** for a non-media tab (chat, text file) requests PiP. There is at most one PiP window: before requesting, exit any other.
  - **Audio:** leaving a playing **audio** tab lets it keep playing.
  - **Back to tab:** PiP's "back to tab" (`leavepictureinpicture` while the medium is not ended) calls only `activate(itsTab)`. It never starts playback or PiP anywhere else. A guard ignores the `leavepictureinpicture` fired by our own `exit()`.
  - **Close:** closing a tab pauses its medium and exits PiP.

- [ ] **Step 1: Failing tests (stub PipApi, fake media elements).**
  - Play A, then switch to B (media) and C (media): A and B are paused, only C may play, and `pip.request` is never called.
  - Play a video, then switch to the chat: `pip.request` is called once.
  - Play a video, then go to the chat (PiP), then to another video tab: the first is paused, `exit` is called, and no new request is made.
  - Our own `exit` produces no `activate` call.
  - A user's "back to tab" produces `activate` once.
  - Audio keeps playing on a switch.
  - Closing the tab pauses its medium.
- [ ] **Step 2–4.** **Step 5: Commit** `feat(web): media switching rules and picture-in-picture`.

### M3-10: Clickable project paths

**Files:**
- Create: `web/src/refs/refs.ts` and its test.
- Modify:
  - `web/src/feed/Markdown.tsx` (postProcess, final only);
  - `web/src/feed/UserMessage.tsx` (@mentions);
  - `Feed.tsx` and `FileView.tsx` (a delegated click handler).

**Interfaces:**
- Produces:
```ts
export function markRefs(root: HTMLElement, baseDir?: string): void;
// inline `code` (not inside pre) whose text passes isPath, and <a href> that is relative (not http(s), mailto, #)
// → class `ref`, data-path = normalized path (relative to baseDir for md files)
export function splitMentions(text: string): ({ text: string } | { mention: string })[];
// the prototype's linkMentions regex, on plain text: /(^|\s)@("[^"]+"|[^\s"]+)/g; quotes stripped from `mention`
export const openRef: (path: string, el: HTMLElement) => AppThunk<Promise<void>>;
// HEAD /file; ok → openFile(path); else el.classList.add('missing'); el.title = t('noFile')
```
- Styling: `.ref` is dotted-underlined with a pointer cursor; `.missing` is struck through and muted.
- A click opens the path only when the selection is collapsed, so selecting text to comment on does not open files.

- [ ] **Step 1: Failing tests.**
  - `markRefs` marks `` `src/App.tsx` `` and `[x](docs/a.md)`.
  - It does not mark `` `npm test` ``, `https://…` or a code block.
  - `splitMentions('see @"a b.md" and @x/y')` gives two mentions.
  - A click with a non-collapsed selection does nothing.
  - A missing file gets `.missing`.
- [ ] **Step 2–4.** **Step 5: Commit** `feat(web): clickable project paths and mentions`.

### M3-11: `@` mention picker

**Files:**
- Create: `web/src/composer/MentionPicker.tsx` and its test.
- Modify: `Composer.tsx`, `web/src/comments/CommentPopup.tsx`, i18n.

**Interfaces:**
- Produces: `<MentionPicker target={RefObject<HTMLTextAreaElement>} />`.
  - It opens when `AT_RE` matches the text before the caret, and queries `/complete?q=`. A sequence guard drops stale answers (prototype `atUpdate`).
  - Keys are window capture while open, with the same contract as M1's ShortcodePicker: ↑↓ move; Enter or Tab picks; Esc closes with `preventDefault` + `stopPropagation`, so neither the popup nor the agent sees it.
  - A pick inserts `@path ` or, if the path contains whitespace, `@"path" `. A folder (`…/`) inserts no space and keeps the picker open with a re-query.
  - Rows show an icon by kind, the basename with matched characters marked, and the folder dimmed. With no results the picker shows `t('atNone')`.
  - It sits above the field when there is room, otherwise below.

- [ ] **Step 1: Failing tests.**
  - Typing `@ap` queries `q=ap`.
  - A stale response is ignored.
  - Picking `a b/c.md` inserts `@"a b/c.md" `.
  - Picking a folder keeps the picker open.
  - Esc closes the picker, the composer does not interrupt and the popup stays open.
  - Enter while the picker is open does not send the message.
- [ ] **Step 2–4.** **Step 5: Commit** `feat(web): @ file mention picker`.

### M3-12: Image attachments

**Files:**
- Create: `web/src/attachments/image.ts`, `web/src/attachments/Attachments.tsx`, and their tests.
- Modify:
  - `web/src/composer/slice.ts` (`images`);
  - `Composer.tsx` (paste, drop, 📎);
  - `CommentPopup.tsx` (paste, drop, 📎; saves `Comment.images`);
  - `web/src/comments/send.ts` and `compose.ts` (labels and `imgRef`);
  - `UserMessage.tsx` and `CommentCard.tsx` (thumbnails);
  - i18n.

**Interfaces:**
- Produces:
```ts
export function prepareImage(file: File): Promise<Blob>;       // prototype readImage: ≤IMG_EDGE, re-encode png, jpeg 0.9 if > IMG_BYTES or type not in IMG_OK
export function uploadImage(b: Blob): Promise<{ id: string; mediaType: ImageType }>; // POST /attach
export function Attachments(props: { ids: { id: string; mediaType: ImageType }[]; onRemove?: (id: string) => void }): JSX.Element;
export function Lightbox(...): JSX.Element;                     // Esc / click closes; Esc preventDefault (Esc protocol)
// composer slice: images: { id: string; mediaType: ImageType }[]; addImages, removeImage; cleared with the draft
```
- Paste and drop accept image files only. Anything else shows `t('onlyImages')`, and a failed read shows `t('imgFail')`; both appear in the connection flash spot.
- On send, the images are labelled like the prototype:
  - composer images get `t('imgLabel', k)`;
  - comment images get `t('imgLabelC', k, ci)` and are appended after them;
  - each comment line in the batch gets `t('imgRef', [k…])`.
- Sending with images only, and no text or comments, is allowed.
- `<img src="/attach/<id>">` thumbnails show in the composer, the popup, the card and the sent bubble. A click opens the Lightbox.

- [ ] **Step 1: Failing tests.**
  - `prepareImage` downsizes a 4000×1000 image to 1568 px on the long edge (canvas stubbed).
  - A heic file is re-encoded.
  - Pasting a PDF shows `onlyImages`.
  - A send with 1 composer image and 1 comment image produces `images` labels `[image 1]` and `[image 2 · for comment 1]`, and the batch line contains `📎 images: 2`.
  - The bubble renders 2 thumbnails.
  - Esc in the lightbox does not interrupt the agent.
- [ ] **Step 2–4.** **Step 5: Commit** `feat(web): image attachments in the composer and comments`.

### M3-13: Comments on files

**Files:**
- Modify:
  - `web/src/comments/SelectionButton.tsx` (accept `[data-file-path]` roots, so the source kind is `file`; listen to scroll on the active pane, `[data-pane]`, not only the chat);
  - `HighlightLayer.tsx` (`HighlightLayer({ pane })`, mounted per pane; it paints only comments whose source belongs to that pane);
  - `CommentCard.tsx` (jump to source on a file opens the tab, then scrolls to the fragment; orphan state for a file follows the view's load state);
  - `send.ts` (`whereOf` for a file is its path);
  - `TabStrip.tsx` and `FileTree.tsx` (badges, already wired to the selector);
  - tests.

**Interfaces:**
- Consumes: `rangeForAnchor` (M1), and `FileView`'s `data-file-path` (M3-08).
- Produces: `selectPendingCountByPath(s): Record<string, number>`, used by the badges.

- [ ] **Step 1: Failing tests.**
  - Selecting text in an md view gives an anchor with `{ kind: 'file', path }`.
  - Its mark paints in that file pane and not in the chat.
  - "Jump to source" from the panel opens the closed file tab and scrolls to the fragment.
  - Editing the file so the quote disappears makes the comment orphaned after a reload, and nothing else gets marked.
  - The batch line names the path.
  - The tab badge and tree badge show 1.
- [ ] **Step 2–4.** **Step 5: Commit** `feat(web): comments on open files`.

### M3-14: e2e for files and media

**Files:**
- Create: `e2e/files.spec.ts` and `e2e/fixtures/project/`, which contains:
  - `docs/Отчёт #1 (final).md` (with a relative image and a `src/a.ts` ref);
  - `src/a.ts`;
  - `media/a.mp4`, `media/b.mp4`, `media/c.mp4` (tiny, generated with ffmpeg at test setup, or committed if under 50 KB each);
  - `media/s.mp3`;
  - `big.log` (generated, 3 MB);
  - `link-out` (a symlink to `/tmp`, created at setup).
- Modify: `e2e/serve.mjs` (serve this project for the files project), `e2e/playwright.config.ts` (a `files` project on port 4793, or the next free one in 4791–4793 per the config).

Specs:
- [ ] Open the tree, expand `docs`, then open the Cyrillic file: the md renders, the relative image loads and `src/a.ts` is a ref. Clicking the ref opens a code tab.
- [ ] Context menu: Close Others keeps the chat and the current tab; Close All leaves only the chat; the chat has no Close item.
- [ ] Video: open `a.mp4` and seek (`currentTime = 1`); the request log shows a 206. Then play A, open B, open C: exactly one video is unpaused, and the PiP request count stays 0 (`HTMLVideoElement.prototype.requestPictureInPicture` stubbed).
- [ ] `big.log` shows the too-large note. `/file?path=link-out/x` returns 403.
- [ ] `@` in the composer: type `@Отч`, Enter. The text contains `@"docs/Отчёт #1 (final).md" `, and after sending, the mention in the bubble opens the file.
- [ ] Paste a PNG (synthetic ClipboardEvent with a File) into the composer and send. The bubble shows one thumbnail. The fake agent's reply echoes `images: 1` (fake script option `echoImages`).
- [ ] Comment on a fragment of the md file and send. The batch frame contains the path. After a reload the file mark is still there.
- [ ] **Run** `npm run e2e` twice, then with `--repeat-each=2` → green.
- [ ] **Commit** `test(e2e): files, tabs, media and attachments`.

### M3-16: Branches and worktrees (read-only)

This is new and goes beyond the prototype. The user asked for it on 2026-10-25, because they cannot see what agents write on other branches. The window's own checkout is **never** switched: a live window may run from it.

**Files:**
- Create: `server/src/git.ts`, `web/src/files/SourcePicker.tsx`, and their tests.
- Modify:
  - `shared/src/protocol.ts` (`AnchorSource` file gains `ref?: string`, and `toSource` keeps it);
  - `server/src/fileRoutes.ts` (`src` parameter);
  - `FileTree.tsx`, the tabs slice, `FileView.tsx`, `refs.ts`;
  - `send.ts` (`whereOf` gives `path @ branch`);
  - i18n.

**Interfaces:**
- Produces:
```ts
// git.ts — every git call is execFile('git', [...], { cwd: root }), never a shell
export type Source = { id: string; kind: 'checkout' | 'worktree' | 'branch'; label: string; ref: string; dir?: string };
// id: 'here' for this checkout; 'wt:<n>' for worktrees, in `git worktree list --porcelain` order; 'br:<name>' for local branches without a worktree
export function listSources(root: string): Promise<Source[]>;   // [] beyond 'here' when root is not a git repo
export function readTree(root: string, src: Source, rel: string): Promise<TreeEntry[]>;   // worktree: listDir in src.dir; branch: git ls-tree <ref> -- <rel>/
export function readFile(root: string, src: Source, rel: string): Promise<Buffer | null>; // branch: git show <ref>:<rel>, maxBuffer 50 MB
```
- Routes:
  - `GET /sources` returns `Source[]`.
  - `/tree`, `/file` and `/complete` accept `src=<id>`, which must be an id from the current `listSources`; any other value gives 400.
    - For worktree sources, `resolveInRoot` applies with `src.dir` as the root, and Range works.
    - For branch sources, `/file` serves the blob whole, with no Range, and a 50 MB cap (413 above).
    - Raw paths are never accepted.
- Tabs:
  - The file tab id becomes ``file:${src}:${path}``, with `src` defaulting to `here`, and the tab shows a branch chip when the source is not `here`.
  - Views of non-`here` sources are read-only. There is no edit UI anyway; they also skip the `turnSeq` reload, except for worktrees, which do reload.
- Tree: the picker sits at the top of the sheet. Switching it keeps a separate set of open folders per source.
- Refs: `isPath` stays the same. Additionally, an absolute path inside the `dir` of any worktree source opens from that source. A relative ref that is missing in `here` is tried in the worktrees, and the first hit wins.
- Comments: a file anchor has `ref` set to the branch name when the source is not `here`. The batch line reads `path @ branch`.

- [ ] **Step 1: Failing tests.** Use a temp git repo with a main checkout, a worktree on `feature/x` and a branch `old` without a worktree.
  - `listSources` lists all three. A non-repo returns only `here`.
  - `readTree` and `readFile` on `old` return committed content that is absent from the working tree.
  - `src=wt:0` with `path=../x` gives 403.
  - An unknown `src` gives 400.
  - A branch name with `/` and a Cyrillic file name work.
  - An absolute worktree path in a reply opens from that worktree.
  - A comment on an `old` file has `ref: 'old'`, and the batch line says `@ old`.
- [ ] **Step 2–4.** Also add an e2e spec in `e2e/files.spec.ts`: the fixture project is a git repo with one worktree; pick it in the tree, open a file, and the tab chip shows its branch.
- [ ] **Step 5: Commit** `feat: read-only branches and worktrees in the file tree`.

### M3-17: Real-agent smoke and docs

- [ ] Run on port 4790 with a temp project that holds a real video and a Cyrillic md file, through Chrome:
  - open the tree, the md file and the video;
  - check PiP when going to the chat;
  - paste a screenshot and ask the agent what it shows;
  - `@`-mention a file and ask about it;
  - comment on the md file and send;
  - restart with `--continue`: the tabs, the file comments and the bubble thumbnails are restored;
  - open a file from a worktree that an agent created, and comment on it.

  Record the results in the task report, then clean up.
- [ ] Update root `CLAUDE.md`: `~/.nota-bene/attachments/` and the new routes.
- [ ] **Commit** `chore: M3 smoke and docs`. After the final review and its fix wave, merge into `main` and tag `m3`.
