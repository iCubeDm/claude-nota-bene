# Media comments Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** In an image tab, or a video tab paused on a frame, the user draws shapes and writes a comment that joins the
batch. The agent gets the file, relative and pixel coordinates, the timecode, and two files in the project: the frame
with the marks, and the marks alone on a transparent layer.

**Architecture:**
- **Data.** A media comment is a `Comment` whose `anchor` is a new `MediaAnchor` (`kind: 'media'`). Shapes are stored
  in relative coordinates.
- **Drawing.** The drawing surface is an SVG overlay with `viewBox="0 0 1 1"` laid exactly over the media's content
  box. Relative coordinates are then native, both when drawing and when showing marks.
- **Rendering.** On "add", the browser renders the composite and the layer on a canvas at the media's natural size.
  - It uploads both at full size to a new server route, which writes them under `<root>/.nota-bene/marks/<commentId>/`.
  - It also uploads downscaled copies through the existing `/attach`, so the agent sees them.
- **Deletion.** When a comment disappears from its session's set, the server deletes its folder.

**Tech Stack:** React 19 + Redux Toolkit (web), Node TS (server, runs `.ts` directly), vitest, Playwright (Chrome,
ffmpeg fixtures). No new dependencies.

**Spec:** `docs/superpowers/specs/2026-10-26-media-comments-design.md`

## Global Constraints

- **Tools.** Rectangle, ellipse ("circle"), freehand pen, arrow, colour, undo.
- **Video.** A still frame only: entering the markup mode pauses it. No time ranges.
- **Coordinates.** Relative to the media's top-left, as fractions of its natural width and height, rounded to 4
  decimals. Pixels are given in natural size.
- **Files.**
  - `<root>/.nota-bene/marks/<commentId>/frame.jpg` and `layer.png`;
  - `<root>/.nota-bene/.gitignore` containing exactly `*\n`;
  - the user's `.gitignore` is never touched.
- **Layer resolution.** `layer.png` is at the natural size.
  - Only if the PNG exceeds `MARK_MAX_BYTES` (25 MB) is it downscaled, and the batch then states the scale.
  - `frame.jpg` is JPEG quality 0.9, at natural size up to the same cap.
- **Deletion.** Deleting a comment (pending or sent) deletes its folder in the same step. Sent comments keep their
  files.
- **Server writes into the project only under `.nota-bene/marks/`:**
  - only server-generated names;
  - the comment id must match `/^[0-9a-f-]{36}$/` (`crypto.randomUUID`);
  - it refuses a symlinked `.nota-bene` or `marks`.

  This code gets an independent review.
- **Gating.** `PROTOCOL` becomes 4. The markup mode is offered only when `controls.protocol >= 4`.
- **Video marks.** A video mark is drawn only while the video is paused within `max(0.5 / fps, 0.04)` s of its time
  (fps unknown → 0.04 s). Opening the comment seeks there and pauses.
- **Unfinished drawing.** In memory per tab, kept across tab switches. Esc, leaving the mode, or closing the tab
  asks before discarding a drawing that has shapes.
- **Performance.** Drawing follows the pointer at display rate on a 4K image. No React re-render of the whole pane
  per pointer move; the live stroke is updated in place.
- **Tests** only on ports 4790–4795. Never touch a live window. Run `npx tsc -b`, `npm test`, `npm run e2e`.

## Review Focus

1. **Letterboxed media** (`object-fit: contain`, the pane wider or taller than the image): shapes must land on the
   pixels the user drew on, not offset by the letterbox. → Task 2 unit test + Task 9 e2e.
2. **Natural-size mode scrolled** to the bottom-right: same mapping. → Task 2 unit test + Task 9 e2e.
3. **The media file overwritten by a regeneration** while a comment is pending: the mark stays and says "file changed";
   the batch says it was marked on an earlier version. → Tasks 4, 7, 8 tests.
4. **A turn ending while the markup mode is open:** the media must not reload under the drawing. → Task 5 test.
5. **The user cancels the popup after the files were uploaded:** no orphan folder is left. → Task 6 test.

---

### Task 1: Shared types, validation, protocol 4

**Files:**
- Modify: `shared/src/protocol.ts`
- Test: `shared/src/protocol.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type FileSource = Extract<AnchorSource, { kind: 'file' }>;
  export type MarkColor = '#ff3b30' | '#ffcc00' | '#34c759' | '#0a84ff' | '#ffffff';
  export type MediaShape =
    | { kind: 'rect' | 'ellipse'; color: MarkColor; x: number; y: number; w: number; h: number } // relative bbox
    | { kind: 'arrow'; color: MarkColor; x1: number; y1: number; x2: number; y2: number }
    | { kind: 'pen'; color: MarkColor; points: number[] }; // flat [x0,y0,x1,y1,…], relative
  export type MediaAnchor = {
    kind: 'media'; source: FileSource; width: number; height: number; // natural px
    time?: number;     // seconds at the pause (video only), ms precision
    version?: string;  // the /file ETag when drawn
    shapes: MediaShape[];
  };
  export type TextAnchor = { source: AnchorSource; start: number; end: number; quote: string; prefix: string; suffix: string };
  export type Anchor = TextAnchor | MediaAnchor;
  export const isMediaAnchor = (a: Anchor): a is MediaAnchor => (a as MediaAnchor).kind === 'media';
  export const MARK_COLORS: readonly MarkColor[];
  export const PROTOCOL = 4; // doc line: "4: media anchors and /marks"
  ```
- Every existing use of `anchor.quote` / `start` / `end` must narrow with `isMediaAnchor` (tsc lists them).
  Text-only code (HighlightLayer, resolve, SelectionButton, fileComments) filters media comments out.

- [ ] **Step 1: Failing tests in `protocol.test.ts`**
  - `parses a comment with a media anchor (rect, ellipse, arrow, pen; time; version)`: a round-trip through
    `parseClientMessage({type:'comments', …})` keeps every field.
  - `rejects media anchors that are out of range or malformed`:
    - x > 1;
    - pen with an odd number of values;
    - pen over 20000 values;
    - an unknown colour;
    - shapes empty;
    - width <= 0;
    - `source.kind !== 'file'`.
  - `toAnchor copies a media anchor deeply`: mutating the parsed copy's points does not change the input.
- [ ] **Step 2:** `npx vitest run shared` → FAIL.
- [ ] **Step 3:** Implement the types and update `isAnchor` / `toAnchor` in `protocol.ts`. Coordinates must be finite
  and within [0, 1] (arrow and pen too); rect/ellipse need `w, h > 0`. Bump `PROTOCOL` and its doc line. Fix every
  tsc error by narrowing; do not change any behaviour for text anchors.
- [ ] **Step 4:** `npx tsc -b && npm test` → all PASS.
- [ ] **Step 5:** Commit `feat(media): media anchor type, validation, protocol 4`.

### Task 2: Geometry — content box, pointer → relative, summaries

**Files:**
- Create: `web/src/media/markup/geometry.ts`
- Test: `web/src/media/markup/geometry.test.ts`

**Interfaces:**
- Produces:
  ```ts
  /** The rendered media's content box in client px: object-fit: contain inside `el`'s box, or the element box at natural size. */
  export function contentBox(elRect: DOMRect, natW: number, natH: number, fit: 'contain' | 'natural'): DOMRect;
  /** Pointer → relative [0,1]², clamped, 4 decimals. */
  export function toRel(clientX: number, clientY: number, box: DOMRect): { x: number; y: number };
  export const round4: (v: number) => number;
  /** Drop pen points closer than `eps` (relative) to the previous kept one; always keeps the first and last. */
  export function simplify(points: number[], eps?: number /* 0.0015 */): number[];
  /** Normalised rect from a drag's two corners (any direction). */
  export function rectFrom(a: { x: number; y: number }, b: { x: number; y: number }): { x: number; y: number; w: number; h: number };
  /** One line per shape for the batch, e.g. `rect x=0.42 y=0.40 w=0.16 h=0.24 (px 806,432 307×259)`. */
  export function describeShape(s: MediaShape, natW: number, natH: number): string;
  ```

- [ ] **Step 1: Failing tests**
  - `contain letterboxes horizontally`: elRect 1000×500, natural 1000×1000 → content box x=250, w=500, h=500.
  - `contain letterboxes vertically`: elRect 500×1000, natural 1000×500 → y=375, h=250.
  - `natural uses the element box as is` (scrolled element: elRect x=-300 → box x=-300).
  - `toRel maps corners exactly and clamps outside`: box (100, 50, 400, 200): (100,50) → (0,0), (500,250) → (1,1),
    (700,0) → (1,0).
  - `rectFrom normalises any drag direction`.
  - `simplify keeps first/last, drops near duplicates, never empties a 2-point stroke`.
  - `describeShape` exact strings:
    - rect (0.42, 0.40, 0.16, 0.24) on 1920×1080 → `rect x=0.42 y=0.4 w=0.16 h=0.24 (px 806,432 307×259)`;
    - pen → `pen 38 pts, bbox x=… (px …)`;
    - ellipse → `ellipse cx=… cy=… rx=… ry=… (px …)`;
    - arrow → `arrow (0.3,0.55)→(0.41,0.5) (px …→…)`.

    Pixels are `Math.round(rel × natural)`.
- [ ] **Step 2:** `npx vitest run web/src/media/markup` → FAIL.
- [ ] **Step 3:** Implement as above.
- [ ] **Step 4:** Tests PASS.
- [ ] **Step 5:** Commit `feat(media): markup geometry`.

### Task 3: Rendering the composite and the layer

**Files:**
- Create: `web/src/media/markup/render.ts`
- Test: `web/src/media/markup/render.test.ts`

**Interfaces:**
- Consumes: `MediaShape` (Task 1).
- Produces:
  ```ts
  /** Draws shapes on a 2D context sized w×h (relative → px). Stroke width max(3, round(min(w,h)/250)) px. */
  export function drawShapes(ctx: CanvasRenderingContext2D, shapes: MediaShape[], w: number, h: number): void;
  /** `frame.jpg` (q 0.9, the source drawn first) and `layer.png` (shapes only, transparent), both natural size; `scale` < 1 only when a file exceeded MARK_MAX_BYTES. */
  export async function renderMarks(source: CanvasImageSource, w: number, h: number, shapes: MediaShape[]): Promise<{ frame: Blob; layer: Blob; scale: number }>;
  export const MARK_MAX_BYTES = 25 * 1024 * 1024;
  ```

- [ ] **Step 1: Failing test.** `drawShapes issues the expected path calls`, using a recording fake ctx:
  - rect → `strokeRect(806, 432, 307, 259)` on 1920×1080;
  - ellipse → `ellipse(cx, cy, rx, ry, …)`;
  - arrow → a line plus a 2-segment head;
  - pen → `moveTo` + `lineTo` per point;
  - `strokeStyle` = the shape colour, `lineWidth` = 4 on 1920×1080.

  `renderMarks` itself is covered in e2e (jsdom has no canvas).
- [ ] **Step 2:** FAIL.
- [ ] **Step 3:** Implement. Use `OffscreenCanvas` when available, otherwise `document.createElement('canvas')`. If a
  blob is over the cap, retry at scale × 0.75 until it fits.
- [ ] **Step 4:** PASS.
- [ ] **Step 5:** Commit `feat(media): render frame and layer`.

### Task 4: Server — mark files in the project, deletion, ETag on /file

**Files:**
- Create: `server/src/marks.ts`
- Modify: `server/src/server.ts` (routes, the `comments` case), `server/src/fileRoutes.ts` (ETag)
- Test: `server/src/marks.test.ts`, `server/src/fileRoutes.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export const MARK_ID = /^[0-9a-f-]{36}$/;
  export class MarkFiles {
    constructor(o: { root: () => string });
    /** Writes `frame.jpg` | `layer.png` for comment `id` (creates `.nota-bene/.gitignore` = "*\n" if missing). Throws on a bad id/name/type, a symlinked dir, or bytes > MARK_MAX_BYTES. */
    write(id: string, name: 'frame.jpg' | 'layer.png', bytes: Buffer): void;
    /** Removes the comment's folder; a missing folder is fine. */
    remove(id: string): void;
    /** Media comments present in `prev` and absent from `next` lose their folder. */
    sync(prev: Comment[], next: Comment[]): void;
  }
  ```
- Routes (same host/origin checks as `/attach`):
  - `POST /marks/<id>/<frame.jpg|layer.png>` (body = bytes, Content-Type `image/jpeg` | `image/png`) → 204;
  - `DELETE /marks/<id>` → 204.
- `/file` responses gain `ETag: W/"<size>-<mtimeMs>"` (absent for branch sources is fine).

- [ ] **Step 1: Failing tests in `marks.test.ts`** (temp root):
  - `write creates the folder, the file and a self-ignoring .gitignore once`: the `.gitignore` content is exactly
    `*\n`; an existing user `.gitignore` at the root is untouched.
  - `write refuses`:
    - an id `../x`;
    - a 35-char id;
    - name `x.png`;
    - a symlinked `.nota-bene` → throws, and nothing is written outside.
  - `sync removes only media comments that disappeared`: text comments and still-present ones are kept, and a
    missing folder does not throw.
  - `remove is idempotent`.

  In `fileRoutes.test.ts`: `/file sends a weak ETag that changes when the file changes`.
- [ ] **Step 2:** FAIL.
- [ ] **Step 3:** Implement.
  - Check with `fs.lstatSync` that `.nota-bene` and `marks` are real dirs before writing.
  - Write to `tmp` + `rename`.
  - In the `comments` case of `server.ts`: `marks.sync(store.get(id), merged)` after `store.merge` succeeds (report
    errors, never fail the merge).
- [ ] **Step 4:** PASS. `npx tsc -b`.
- [ ] **Step 5:** Commit `feat(media): mark files in the project, deleted with their comment`.

### Task 5: Markup mode in the media tab

**Files:**
- Create: `web/src/media/markup/MarkupLayer.tsx`, `web/src/media/markup/MarkupToolbar.tsx`,
  `web/src/media/markup/slice.ts`
- Modify: `web/src/files/FileView.tsx` (mount the layer; skip click-to-zoom and the after-turn media reload while the
  mode is on), `web/src/store/store.ts` (reducer), `web/src/i18n/{ru,en}.ts`
- Test: `web/src/media/markup/MarkupLayer.test.tsx`, `web/src/files/FileView.test.tsx`

**Interfaces:**
- Consumes: Task 2 geometry; `controls.protocol` (>= 4 to offer the mode).
- Produces:
  ```ts
  // slice 'markup': per tab id, in memory only
  type Draft = { on: boolean; tool: 'rect' | 'ellipse' | 'pen' | 'arrow'; color: MarkColor; shapes: MediaShape[] };
  export const markupSlice; // actions: setMode(tabId, on), setTool, setColor, addShape, undo, clear(tabId)
  export const selectDraft: (s: RootState, tabId: string) => Draft;
  export function MarkupLayer(p: { tabId: string; media: HTMLImageElement | HTMLVideoElement; fit: 'contain' | 'natural'; onAdd: (shapes: MediaShape[]) => void }): JSX.Element | null;
  ```
- UI:
  - a "✎ Mark up" toggle in the media tab's top-right; while on, the toolbar shows: tools, 5 colours (`MARK_COLORS`),
    undo, "Comment", ✕;
  - keys within the mode: R, E (ellipse), P, A, 1–5 colours, Cmd/Ctrl+Z undo, Enter = Comment, Esc = leave;
  - leaving with shapes uses the existing `ConfirmDialog`.

- [ ] **Step 1: Failing tests**
  - `the mode is not offered to a server below protocol 4`.
  - `entering the mode pauses a playing video`.
  - `a drag with the rect tool adds a rect in relative coordinates of the content box`: a stubbed
    `getBoundingClientRect`, a letterboxed case.
  - `pen strokes update in place during the drag and are simplified on pointerup`: assert the slice is dispatched
    once, on pointerup only.
  - `undo removes the last shape; Esc with shapes asks before discarding; Esc without shapes just leaves`.
  - `the draft survives a tab switch` (the slice keeps it; the layer remounts with it).
  - In `FileView.test.tsx`:
    - `an image click does not toggle the zoom while marking`;
    - `a turn ending while marking does not reload the media` (Review Focus 4).
- [ ] **Step 2:** FAIL.
- [ ] **Step 3:** Implement.
  - The SVG overlay is positioned at `contentBox(...)`, recomputed on resize/scroll via `ResizeObserver` + the pane's
    scroll event.
  - Shapes use `vector-effect: non-scaling-stroke`.
  - The live pen stroke is a ref'd `<polyline>` whose `points` attribute is set directly. No state update per move.
- [ ] **Step 4:** PASS.
- [ ] **Step 5:** Commit `feat(media): markup mode`.

### Task 6: From drawing to comment

**Files:**
- Modify: `web/src/comments/CommentPopup.tsx` (accept any `Anchor` plus a `prepare` hook),
  `web/src/files/FileView.tsx` (wire `onAdd`), `web/src/comments/slice.ts`
- Create: `web/src/media/markup/createMediaComment.ts`
- Test: `web/src/media/markup/createMediaComment.test.ts`, `web/src/comments/CommentPopup.test.tsx`

**Interfaces:**
- Consumes: `renderMarks` (Task 3); `uploadImage` + `prepareImage` (`web/src/attachments/image.ts`); the routes from
  Task 4.
- Produces:
  ```ts
  /** Renders, uploads the natural-size files to /marks/<id>/…, uploads downscaled copies to /attach; returns the ids. On any failure deletes /marks/<id>. */
  export async function prepareMediaComment(id: string, source: CanvasImageSource, anchor: MediaAnchor): Promise<{ images: string[] /* [frameAttachId, layerAttachId] */ }>;
  ```
  `CommentPopup` props become:
  ```ts
  { pending: { anchor: Anchor; rect: DOMRect; text?: string; id?: string; prepare?: () => Promise<{ images: string[] }> }; onClose }
  ```
  With `prepare` set, "Add" awaits it (the button shows a spinner and is disabled), then dispatches
  `addComment({ id, anchor, text, label, images: [...prepared, ...pasted] })`. `addComment` accepts an optional
  caller-given `id` (the folder is named by it).
- Video source: the paused `<video>` element; `anchor.time = round(currentTime, 3)`. Image: the `<img>`.
  `anchor.version` = the media response's ETag (read via a `HEAD /file?...` when the mode is entered).

- [ ] **Step 1: Failing tests**
  - `prepare uploads frame and layer to /marks/<id>/ and both copies to /attach, frame first`: fetch is mocked;
    assert the call order and bodies' types.
  - `a failed upload deletes /marks/<id> and rejects`.
  - `cancelling the popup after prepare ran deletes /marks/<id>` (Review Focus 5).
  - `the popup quote for a media anchor shows the file and the shape count, not a text quote`.
- [ ] **Step 2:** FAIL.
- [ ] **Step 3:** Implement. The draft is cleared and the mode left only after `addComment`.
- [ ] **Step 4:** PASS.
- [ ] **Step 5:** Commit `feat(media): add a media comment`.

### Task 7: Marks on the media, the card, jumping to a comment

**Files:**
- Create: `web/src/media/markup/MediaMarks.tsx`
- Modify: `web/src/files/FileView.tsx`, `web/src/comments/CommentCard.tsx`, `web/src/comments/slice.ts`
  (`selectMediaComments(path, ref)`)
- Test: `web/src/media/markup/MediaMarks.test.tsx`, `web/src/comments/CommentCard.test.tsx`

**Interfaces:**
- Consumes: `contentBox` (Task 2); `openCommentCard` (existing); `MediaAnchor.version`, `time`.
- Produces: `MediaMarks({ tabId, media, fit, path, ref })`, an SVG overlay of pending (accent) and sent (dimmed)
  shapes.
  - A click on a shape opens the card.
  - For video, marks show only while paused within `max(0.5/fps, 0.04)` s of `anchor.time`.
  - The card shows a thumbnail (`/attach/<images[0]>`, ≤ 96 px high), the file name and, for video, the time.
  - It flags "file changed since" when the current ETag ≠ `anchor.version`.
  - Its jump opens the tab; for video it seeks to `time` and pauses.

- [ ] **Step 1: Failing tests**
  - `marks of this file only, pending and sent styled differently`.
  - `video marks hidden while playing or away from the time, shown when paused at it`.
  - `a click on a mark opens its card`.
  - `the card of a media comment shows the thumbnail and "file changed" when the ETag differs`
    (Review Focus 3).
  - `jump seeks and pauses the video`.
- [ ] **Step 2:** FAIL.
- [ ] **Step 3:** Implement. `pointer-events` only on the shapes, never over the native video controls (the bottom
  48 px of a video stay free).
- [ ] **Step 4:** PASS.
- [ ] **Step 5:** Commit `feat(media): marks on media, card, jump`.

### Task 8: The batch

**Files:**
- Modify: `web/src/comments/compose.ts`, `web/src/comments/send.ts` (`whereOf`), `web/src/i18n/{ru,en}.ts`
- Test: `web/src/comments/compose.test.ts`, `web/src/comments/send.test.tsx`

**Interfaces:**
- Consumes: `describeShape` (Task 2); `isMediaAnchor` (Task 1).
- Produces: the exact block (English example; `ru` translates the words, not the format):
  ```
  3. [media/scene_v6.png · 1920×1080]
  > rect x=0.42 y=0.4 w=0.16 h=0.24 (px 806,432 307×259)
  > pen 38 pts, bbox x=0.3 y=0.5 w=0.1 h=0.08 (px 576,540 192×86)
  → The character sits here
  📎 images: 4 (frame with marks), 5 (marks only, transparent)
     files: .nota-bene/marks/<id>/frame.jpg, .nota-bene/marks/<id>/layer.png
  ```
  - Video: `[media/clip.mp4 @ 0:04.240 · 1280×720]`.
  - Changed file: an extra line `   (marked on an earlier version of the file; the frame shows it)`.
  - Scaled layer: `layer.png (scaled ×0.75)`.

- [ ] **Step 1: Failing tests:** these three formats exactly, and `send numbers a media comment's images
  frame-then-layer within the global numbering`.
- [ ] **Step 2:** FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** PASS.
- [ ] **Step 5:** Commit `feat(media): media comments in the batch`.

### Task 9: End to end

**Files:**
- Modify: `e2e/files.spec.ts`. Fixtures: `docs/big.png`; the generated video from the `files` project. Add a
  1000×500 image `media/wide.png` to the fixture generator for letterboxing.
- Test: `e2e/files.spec.ts`

- [ ] **Step 1: Write the tests (`@files`)**
  - `mark up an image: rect + pen, comment, files in the project, coordinates in the batch`:
    - draw a rect from the content box's 25%/25% to 75%/50% on `media/wide.png` in a pane that letterboxes it;
    - the batch (captured websocket frame) has `rect x=0.25 y=0.25 w=0.5 h=0.25 (px 250,125 500×125)` ± 0.005;
    - `.nota-bene/marks/<id>/layer.png` exists in the fixture project at 1000×500;
    - a pixel at (500, 125) of `layer.png` is opaque and (10, 10) is transparent.
  - `natural size, scrolled to the bottom-right: the same mapping` (Review Focus 2).
  - `mark up a paused video frame: the time is in the batch; the mark shows only when paused there`.
  - `deleting the comment removes its folder`.
  - `4K-ish drawing stays responsive`: draw a 300-point pen stroke over a 3840×2160 fixture; the stroke completes,
    and the pointer-move handler's time per event (measured with `performance.now` in the page) has a median under
    4 ms.
- [ ] **Step 2:** `npm run e2e` → the new tests FAIL before Tasks 1–8, PASS after.
- [ ] **Step 3:** Commit `test(media): e2e for media comments`.

### Task 10: Review and finish

- [ ] **Step 1:** An independent review of Task 4 (project writes, deletion, path safety) and Task 6 (cleanup on
  failure). Fix the findings.
- [ ] **Step 2:** `npx tsc -b && npm test && npm run e2e`, all green.
- [ ] **Step 3:** Run the server once on 4790 with a temp project and temp `NOTA_BENE_HOME`; check that `/info` answers.
- [ ] **Step 4:** Merge to main, `npm run build -w web`. Ask the user for "▾ → Restart the server" and verify that the
  pid changed.
