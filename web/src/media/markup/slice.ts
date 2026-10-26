import { createSlice, type PayloadAction } from '@reduxjs/toolkit';
import { MARK_COLORS, type MarkColor, type MediaShape } from '@nota-bene/shared';
import type { RootState } from '../../store/store.ts';
import { enterRoot } from '../../tabs/slice.ts';

export type MarkTool = 'rect' | 'ellipse' | 'pen' | 'arrow';
/** One media tab's unfinished drawing. In memory only: a page reload loses it, a tab or folder switch does not. */
export type Draft = { on: boolean; tool: MarkTool; color: MarkColor; shapes: MediaShape[] };
/** `drafts`: the current folder's, by tab id; `parked`: the other folders' (by root), put back on a switch back. */
export type MarkupState = { drafts: Record<string, Draft>; root: string | null; parked: Record<string, Record<string, Draft>> };

const EMPTY: Draft = { on: false, tool: 'rect', color: MARK_COLORS[0], shapes: [] };
const draftOf = (s: MarkupState, tabId: string): Draft => (s.drafts[tabId] ??= { ...EMPTY, shapes: [] });

export const markupSlice = createSlice({
  name: 'markup',
  initialState: (): MarkupState => ({ drafts: {}, root: null, parked: {} }),
  reducers: {
    setMode: {
      reducer: (s, a: PayloadAction<{ tabId: string; on: boolean }>) => void (draftOf(s, a.payload.tabId).on = a.payload.on),
      prepare: (tabId: string, on: boolean) => ({ payload: { tabId, on } }),
    },
    setTool: {
      reducer: (s, a: PayloadAction<{ tabId: string; tool: MarkTool }>) => void (draftOf(s, a.payload.tabId).tool = a.payload.tool),
      prepare: (tabId: string, tool: MarkTool) => ({ payload: { tabId, tool } }),
    },
    setColor: {
      reducer: (s, a: PayloadAction<{ tabId: string; color: MarkColor }>) => void (draftOf(s, a.payload.tabId).color = a.payload.color),
      prepare: (tabId: string, color: MarkColor) => ({ payload: { tabId, color } }),
    },
    addShape: {
      reducer: (s, a: PayloadAction<{ tabId: string; shape: MediaShape }>) => void draftOf(s, a.payload.tabId).shapes.push(a.payload.shape),
      prepare: (tabId: string, shape: MediaShape) => ({ payload: { tabId, shape } }),
    },
    undo: (s, a: PayloadAction<string>) => void s.drafts[a.payload]?.shapes.pop(),
    /**
     * The comment made of `shapes` was added: those shapes leave the draft (one match each, by value); a stroke drawn
     * while it was being saved stays. The mode stays on, with its tool and colour, for the next comment (Esc or ✕ leaves).
     */
    dropShapes: {
      reducer: (s, a: PayloadAction<{ tabId: string; shapes: MediaShape[] }>) => {
        const d = s.drafts[a.payload.tabId];
        if (!d) return;
        const left = [...d.shapes];
        for (const sh of a.payload.shapes) {
          const k = JSON.stringify(sh);
          const i = left.findIndex((x) => JSON.stringify(x) === k);
          if (i >= 0) left.splice(i, 1);
        }
        d.shapes = left;
      },
      prepare: (tabId: string, shapes: MediaShape[]) => ({ payload: { tabId, shapes } }),
    },
    /** Drops the shapes and leaves the mode; the tool and colour stay for the next drawing. */
    clear: (s, a: PayloadAction<string>) => {
      const d = s.drafts[a.payload];
      if (d) s.drafts[a.payload] = { ...d, on: false, shapes: [] };
    },
  },
  // another folder: its tabs are other files even when a path is the same, so the drafts are parked under the folder
  // left and the new folder's own come back (the first root merges: drafts made before it was known are its own)
  extraReducers: (b) => b.addCase(enterRoot, (s, a) => {
    const { root, first } = a.payload;
    if (!first && root !== s.root) {
      if (s.root !== null && Object.keys(s.drafts).length) s.parked[s.root] = s.drafts;
      s.drafts = s.parked[root] ?? {};
      delete s.parked[root];
    }
    s.root = root;
  }),
});

export const { setMode, setTool, setColor, addShape, undo, clear, dropShapes } = markupSlice.actions;

export const selectDraft = (s: RootState, tabId: string): Draft => s.markup.drafts[tabId] ?? EMPTY;
