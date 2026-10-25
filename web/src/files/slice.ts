import { createSlice, type PayloadAction } from '@reduxjs/toolkit';
import type { RootState } from '../store/store.ts';
import { activate, fileTabId, openFile } from '../tabs/slice.ts';
import type { AppThunk } from '../store/store.ts';

/**
 * What an open file view shows, for the comments on it. `loaded`: its text is in the DOM (anchors resolve against it);
 * `gone`: the view settled without text (deleted, too large, binary), so a comment on it is orphaned. No entry, or
 * `loading`: unknown (tab closed, not fetched yet, a transient error): a comment is neither marked nor orphaned.
 * `v` bumps on every settled load, so a reload re-runs the checks even when the state stays `loaded`.
 */
export type FileLoad = { s: 'loading' | 'loaded' | 'gone'; v: number };
/** `jump`: a "jump to source" waiting for that file's view to load and become active (FileView consumes it). */
export type FilesState = { load: Record<string, FileLoad>; jump: { path: string; id: string } | null };

export const filesSlice = createSlice({
  name: 'files',
  initialState: (): FilesState => ({ load: {}, jump: null }),
  reducers: {
    setFileLoad: (s, a: PayloadAction<{ path: string; s: FileLoad['s'] }>) => {
      s.load[a.payload.path] = { s: a.payload.s, v: (s.load[a.payload.path]?.v ?? 0) + 1 };
    },
    dropFileLoad: (s, a: PayloadAction<string>) => {
      delete s.load[a.payload];
      if (s.jump?.path === a.payload) s.jump = null;
    },
    requestJump: (s, a: PayloadAction<{ path: string; id: string }>) => void (s.jump = a.payload),
    clearJump: (s) => void (s.jump = null),
  },
  // the user went elsewhere (another tab, or a jump to a chat comment activates the chat): the pending jump is dropped
  extraReducers: (b) =>
    b.addCase(activate, (s, a) => {
      if (s.jump && a.payload !== fileTabId(s.jump.path)) s.jump = null;
    }).addCase(openFile, (s, a) => {
      if (s.jump && a.payload !== s.jump.path) s.jump = null;
    }),
});

export const { setFileLoad, dropFileLoad, clearJump } = filesSlice.actions;

/** Opens (or activates) the file tab and asks its view to scroll to the comment's fragment once loaded. */
export const jumpToFileComment = (path: string, id: string): AppThunk => (d) => {
  d(openFile(path));
  d(filesSlice.actions.requestJump({ path, id }));
};

export const selectFileLoad = (s: RootState, path: string): FileLoad | undefined => s.files.load[path];
export const selectJump = (s: RootState) => s.files.jump;
