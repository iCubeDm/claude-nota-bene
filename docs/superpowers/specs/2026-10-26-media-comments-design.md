# Media comments: mark up an image or a paused video frame — design

Date: 2026-10-26. Status: draft for the user's review.

## Why

The user works on media with the agent: regenerating images, editing them locally, generating and regenerating video
(e.g. a storyboard project). To point at a place in a frame today they leave Nota Bene: draw over the image
in macOS Markup, then paste the result into the chat.

A real case (image `scene_v6`, "the character should sit here"):
- the first try failed because the drawing was **on top of v6**: the generator copied the character's old pose from it (v7);
- it worked once the agent moved the yellow lines onto an empty layer by itself and passed that as a separate
  reference (v8). The agent then wrote that rule into the project's AGENTS.md.

The feature brings that whole loop into Nota Bene. On an image tab, or a video tab paused on a frame, the user draws
shapes and writes a comment, exactly like a text comment. Nota Bene attaches everything the agent needs for a precise
reference:
- the file;
- relative coordinates;
- the timecode;
- the frame with the drawing;
- **the drawing alone on a transparent layer**.

Success: the user never opens macOS Markup for this again, and the agent gets the place right the first time.

## Goals

- A media markup mode in image and video tabs: rectangle, circle (ellipse), freehand pen, arrow, colour, undo. The user explicitly wants
  "a real drawing tool, so complex shapes are possible".
- Video: entering the mode pauses the video. The markup belongs to that one frame (a still frame only).
- One comment = one markup (any number of shapes) + text, and optionally a quick label. It joins the same pending
  batch as text comments and is sent with them.
- The marked shapes stay drawn over the media as a pending mark. A click opens the comment, as text marks do (the
  user confirmed this). After sending they dim like sent text marks.
- What the agent receives for each media comment:
  - the comment text;
  - the file path (and `@ ref` for another source);
  - for video, the timecode;
  - the shapes in **relative coordinates** (fractions of the media's width and height, origin at the top-left of the
    media). The user asked for this so the zoom at which they drew does not matter;
  - pixel coordinates in the media's natural size;
  - two images:
    1. the frame with the shapes drawn on it;
    2. **the shapes alone on a transparent layer** of the frame's size.
- The comment card in the panel shows a small thumbnail of the frame with its shapes, so a media comment is
  recognisable among text comments (builder's call on the exact look).

## Non-goals (v1)

- Time ranges in video ("from 0:04 to 0:07 the hand moves wrong"). The user: useful but hard; a still frame for now.
- Several frames in one comment.
- Audio.
- Media files opened from another source as a different revision: the anchor records `ref` like text file comments
  do. No diffing between revisions.
- Editing shapes after the comment is created: delete and redraw. The comment text stays editable as today.

## Anti-goals (the user's words: what makes it a failure even if it "works")

1. **It lags.** Drawing must follow the pointer at display rate on a 4K image or video. Entering and leaving the mode,
   adding the comment, and opening a tab with many marks must not stutter.
2. **Coordinates arrive skewed.** The relative and pixel numbers must describe exactly the place the user drew.
   The known traps:
   - `object-fit: contain` letterboxing: the drawable area is the media's *content box*, not the element box;
   - the fit-vs-natural zoom toggle;
   - scrolling in natural size;
   - the device pixel ratio;
   - the video's intrinsic size versus its display size.

   Tests must cover these with known shapes on a known image.
3. **It is awkward to use.** Few clicks, keyboard-friendly, and no fighting the existing click-to-zoom or the video
   controls. Leaving the mode is obvious (Esc, the toggle) and never loses an unfinished drawing silently.

## Constraints

- The existing pieces must be reused, not paralleled:
  - comments (`shared/src/protocol.ts` `Comment` / `Anchor`, `comments/slice.ts`, the server store
    `comments/<sessionId>.json`, `composeBatch`, `sendBatch`);
  - attachments (`/attach`, content-addressed, cap `MAX_ATTACHMENT_BYTES` = 3.75 MB; comment `images` are attachment
    ids that `sendBatch` already numbers and sends to the agent as images);
  - the media tab (`files/FileView.tsx`, `nb-fit` / `nb-natural`, the media controller's pause/PiP rules);
  - `HighlightLayer`-style mark painting.
- `Anchor` is used everywhere as a text anchor. Add a media anchor as a **distinct anchor kind** (a discriminated union),
  so text code paths cannot misread it. Parsing and validation on the server (`isAnchor`, `toAnchor`) must accept it.
- **Protocol gating.** A newer page may talk to an older server; see `PROTOCOL` / `hello` in `shared/src/protocol.ts`. An
  older server would reject comments with the new anchor. Bump `PROTOCOL` to 4 (3 is the 🔥 label), and offer the markup mode only when
  the server announced >= 4.
- Images sent to the model are downscaled by the API anyway. The two attachment images must fit the attachment cap,
  so no huge PNGs of 4K frames. The coordinates, not the pictures, carry the precision.
- No new heavy dependencies. Canvas/SVG in the browser is enough. Any library must be MIT, small, and justified.
- Tests: unit tests for coordinate mapping and the anchor/batch format; e2e on a real browser, with the existing
  ffmpeg fixtures, for drawing on an image, on a paused video, and sending.

## Decided

| Topic | Decision | By |
|---|---|---|
| Tools | rectangle + circle + freehand + arrow, colour, undo | user (rectangle, circle, "full drawing"); arrow and colour: my call |
| Video | pause → one frame; no ranges | user |
| Coordinates | relative to the media's top-left, fractions of width/height; plus pixels | user (relative); pixels: my call, for scripts |
| Layer | the drawing alone on a transparent layer goes to the agent | user 👍 |
| Artifacts as files | the frame and the layer are FILES in the project, `.nota-bene/marks/<commentId>/`, named in the batch | user |
| Deletion | deleting a comment deletes its folder at once; no later cache cleaning | user |
| Mark on media | stays, click opens the comment | user 👍 |
| Composite image | the frame with the drawing also goes | my call (it is what the user did by hand) |
| Order | before the rest of M6 package B | my call, the user may override |

## Mark files in the project

The user wants the agent to be able to *use* the drawing (pass the layer to a generator or a script), not only see it.
So the two images are files in the project:

- `<root>/.nota-bene/marks/<commentId>/frame.<jpg|webp>` — the frame with the shapes drawn on it;
- `<root>/.nota-bene/marks/<commentId>/layer.png` — the shapes alone, transparent, at the media's natural size;
- `<root>/.nota-bene/.gitignore` containing `*`, written once, so the folder ignores itself. The user's own
  `.gitignore` is never touched.

Rules:

- **This is the server's first write into the project** (until now it only reads it). It writes only under
  `<root>/.nota-bene/marks/`, only names it generates (`<commentId>` must match the comment-id format, file names are
  fixed), never a path from the client, and refuses a symlinked `.nota-bene` or `marks`. This gets an independent
  review, like the other persistence code.
- **Two copies, two purposes** (revised while planning). The project files are at full resolution, for tools and
  generators. The model's view goes through the existing attachments, which are downscaled to 1568 px on the long edge
  (`IMG_EDGE`) and feed the chat bubbles and the history replay. Reusing that path avoids a second image pipeline. The
  attachment copies are content-addressed like pasted images, and are covered by the M6-15 "clean unreferenced
  attachments"; the project folder is deleted with its comment. The batch names both project files by their
  project-relative paths.
- **Lifecycle:**
  - The folder is written when the comment is added. Deleting the comment, pending or sent, removes its folder
    in the same step.
  - Sent comments keep their files, so the agent can come back to them in later turns.
  - A comment whose folder is missing (deleted by hand, another machine) is shown as such; it is never an error.
- The M6-15 Storage section shows the size of `.nota-bene/marks/` of the current project (later work).

## Batch format (to the agent)

A media comment appears in the numbered batch like a text one: `[where]`, then the "quote", then `→ text`. The
"quote" of a media comment is a compact machine-readable description, for example:

```
3. [media/scene_v6.png · 1920×1080]
> region: rect x=0.42 y=0.40 w=0.16 h=0.24 (px 806,432 307×259); pen 38 pts; arrow (0.30,0.55)→(0.41,0.50)
→ The character sits here, facing the door
📎 images: 4 (frame with marks), 5 (marks only, transparent)
   files: .nota-bene/marks/7f3c…/frame.jpg, .nota-bene/marks/7f3c…/layer.png
```

For a video: `[media/clip.mp4 @ 0:04.240 · frame 1280×720]`. The time is `currentTime` at the pause (ms precision) —
it is what `ffmpeg -ss` needs. The exact frame index is not reliably known in the browser, so it is not promised.

Freehand strokes are too long for the text. The text gives a summary (point count, bounding box). The full point
lists (relative, rounded to 4 decimals) are kept in the stored anchor. The builder decides whether they also travel as
a compact JSON line in the batch.

## Calls made after the builder check (mine, the user may override)

- **Layer resolution.** The transparent layer is always at the media's natural size, so it aligns 1:1 with the source
  for a generator or a script. A mostly empty PNG fits the cap even at 4K. Only if it does not fit is it downscaled,
  and then the batch states the scale factor. The composite may be downscaled freely, since it is for the model's eyes.
- **Captured at creation.** The frame and the layer are rendered when the comment is added, not at send time, so the
  agent gets exactly what the user drew on.
- **The media changes underneath.** A regeneration may overwrite the same path. The anchor records the natural size
  and the file's version token (the `/file` response's ETag or Last-Modified).
  - The mark keeps being drawn from the relative coordinates.
  - When the version differs, the card and the mark say "the file has changed since". The batch says so too
    ("marked on an earlier version; the attached frame shows it").
  - While the markup mode is open, the after-turn reload of the media tab is held off.
- **Video marks.** A video mark is drawn only while the video is paused at its timecode (within half a frame, or 40 ms
  when the rate is unknown). Opening the comment, or jumping to it from its card, seeks to the timecode and pauses.
  While the video plays, nothing is drawn over moving frames. Clicks on the native controls area are never taken by
  the overlay.
- **Unfinished drawing.** It is kept in memory per tab, across tab switches. Esc, or closing the tab with a drawing that
  has shapes, asks before discarding it. A page reload loses it; "Restart the server" does not reload the page.

## Left to the builder

- Canvas vs SVG for the drawing surface; how the overlay tracks fit/natural zoom and scrolling.
- Pointer handling: pressure is optional; simplify strokes, but never lose a short stroke.
- How the frame is captured from `<video>`: a canvas `drawImage` of the paused element at its intrinsic size (same
  origin). Image encoding and size: the composite as JPEG/WebP; the layer as PNG, which compresses well since it is
  mostly empty. Downscale to fit the cap.
- The toolbar's look and placement in the media tab, the keyboard shortcuts within the mode (they must not collide
  with M6-14's global keymap; coordinate with it), and the colour palette.
- The card thumbnail.
- Where marks of sent comments show (dimmed, as text) and how many marks a tab can paint without lag.

## Known gaps after v1 (deferred in review, 2026-10-26)

- No sweep of orphan mark folders: a pending media comment dropped by a session switch, a failed DELETE, or a re-rooting switch leaves `.nota-bene/marks/<id>/` behind (git-ignored, bounded).
- "Folder missing" is not shown on a card whose `.nota-bene/marks/<id>/` was deleted by hand; the batch still names the files.
- Two windows on one session (last writer wins) can now delete the mark folder of a comment the other window re-adds.
- "File changed" is known only while a tab has loaded the file's ETag.

## Open questions for later (not v1)

- Video time ranges and multi-frame comments.
- Shapes editable after creation.
- A "compare with the previous version" view for regenerated media.
