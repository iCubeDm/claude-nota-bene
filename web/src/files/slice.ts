import { createSlice, type PayloadAction } from '@reduxjs/toolkit';
import type { RootState } from '../store/store.ts';
import { activate, enterRoot, fileArg, fileTabId, openFile } from '../tabs/slice.ts';
import type { AppThunk } from '../store/store.ts';
import { fileKey, loadSources, srcIdOfRef } from './sources.ts';

/**
 * What an open file view shows, for the comments on it. `loaded`: its text is in the DOM (anchors resolve against it);
 * `gone`: the view settled without text (deleted, too large, binary), so a comment on it is orphaned. No entry, or
 * `loading`: unknown (tab closed, not fetched yet, a transient error): a comment is neither marked nor orphaned.
 * `v` bumps on every settled load, so a reload re-runs the checks even when the state stays `loaded`.
 * Keyed by `fileKey(path, ref)`: the path alone for this folder, so a.md and a.md @ feature/x never mix (M3-16).
 */
export type FileLoad = { s: 'loading' | 'loaded' | 'gone'; v: number };
/** A file of some source: `ref` only when it is not this folder. */
export type FileRef = { path: string; ref?: string };
/**
 * `jump`: a "jump to source" waiting for that file's view to load and become active (FileView consumes it).
 * `version`: the current ETag of an open media tab's file, read when it (re)loads (only while it has a media comment
 * with a version; absent for a branch source): a media comment compares it with its anchor's for "the file has changed
 * since". No entry = unknown (tab closed): no claim either way.
 */
export type FilesState = { load: Record<string, FileLoad>; version: Record<string, string>; jump: { path: string; src: string; ref?: string; id: string } | null };

const keyOf = (f: string | FileRef) => (typeof f === 'string' ? f : fileKey(f.path, f.ref));

export const filesSlice = createSlice({
  name: 'files',
  initialState: (): FilesState => ({ load: {}, version: {}, jump: null }),
  reducers: {
    setFileLoad: (s, a: PayloadAction<FileRef & { s: FileLoad['s'] }>) => {
      const k = keyOf(a.payload);
      s.load[k] = { s: a.payload.s, v: (s.load[k]?.v ?? 0) + 1 };
    },
    dropFileLoad: (s, a: PayloadAction<string | FileRef>) => {
      delete s.load[keyOf(a.payload)];
    },
    /** The view of this file closed: a jump still waiting for it is dropped (it must not meet the next open of the file). */
    dropJump: (s, a: PayloadAction<FileRef>) => {
      if (s.jump && fileKey(s.jump.path, s.jump.ref) === keyOf(a.payload)) s.jump = null;
    },
    /** `version` undefined: unknown again (the tab closed, or the file has no ETag). */
    setFileVersion: (s, a: PayloadAction<FileRef & { version?: string }>) => {
      const k = keyOf(a.payload);
      if (a.payload.version === undefined) delete s.version[k];
      else s.version[k] = a.payload.version;
    },
    requestJump: (s, a: PayloadAction<{ path: string; src: string; ref?: string; id: string }>) => void (s.jump = a.payload),
    clearJump: (s) => void (s.jump = null),
  },
  // the user went elsewhere (another tab, or a jump to a chat comment activates the chat): the pending jump is dropped
  extraReducers: (b) =>
    b.addCase(activate, (s, a) => {
      if (s.jump && a.payload !== fileTabId(s.jump.path, s.jump.src)) s.jump = null;
    }).addCase(openFile, (s, a) => {
      const f = fileArg(a.payload);
      if (s.jump && (f.path !== s.jump.path || f.src !== s.jump.src)) s.jump = null;
    }).addCase(enterRoot, (s, a) => {
      // another root: its paths are other files; what was loaded or awaited belongs to the old one
      if (a.payload.first) return;
      s.load = {};
      s.version = {};
      s.jump = null;
    }),
});

export const { setFileLoad, dropFileLoad, setFileVersion, clearJump, dropJump } = filesSlice.actions;

/**
 * Opens (or activates) the file tab and asks its view to scroll to the comment's fragment once loaded. A comment with
 * a `ref` opens from `ref:<branch>` (the view says when that branch is gone), or from the detached worktree carrying it.
 */
export const jumpToFileComment = (path: string, id: string, ref?: string): AppThunk => (d) => {
  const go = (src: string) => {
    d(openFile({ path, src, ref }));
    d(filesSlice.actions.requestJump({ path, src, ...(ref ? { ref } : {}), id }));
  };
  const src = srcIdOfRef(ref);
  if (src) return go(src);
  void loadSources(true).then(() => {
    const again = srcIdOfRef(ref);
    if (again) go(again);
  });
};

export const selectFileLoad = (s: RootState, path: string, ref?: string): FileLoad | undefined => s.files.load[fileKey(path, ref)];
export const selectJump = (s: RootState) => s.files.jump;
export const selectFileVersion = (s: RootState, path: string, ref?: string): string | undefined => s.files.version[fileKey(path, ref)];
