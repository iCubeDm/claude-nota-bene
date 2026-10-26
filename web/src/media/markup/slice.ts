import { createSlice, type PayloadAction } from '@reduxjs/toolkit';
import { MARK_COLORS, type MarkColor, type MediaShape } from '@nota-bene/shared';
import type { RootState } from '../../store/store.ts';
import { enterRoot } from '../../tabs/slice.ts';

export type MarkTool = 'rect' | 'ellipse' | 'pen' | 'arrow';
/** One media tab's unfinished drawing. In memory only: a page reload loses it, a tab switch does not. */
export type Draft = { on: boolean; tool: MarkTool; color: MarkColor; shapes: MediaShape[] };
export type MarkupState = { drafts: Record<string, Draft> };

const EMPTY: Draft = { on: false, tool: 'rect', color: MARK_COLORS[0], shapes: [] };
const draftOf = (s: MarkupState, tabId: string): Draft => (s.drafts[tabId] ??= { ...EMPTY, shapes: [] });

export const markupSlice = createSlice({
  name: 'markup',
  initialState: (): MarkupState => ({ drafts: {} }),
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
    /** Drops the shapes and leaves the mode; the tool and colour stay for the next drawing. */
    clear: (s, a: PayloadAction<string>) => {
      const d = s.drafts[a.payload];
      if (d) s.drafts[a.payload] = { ...d, on: false, shapes: [] };
    },
  },
  // another folder: its tabs are other files even when a path is the same
  extraReducers: (b) => b.addCase(enterRoot, (s, a) => void (a.payload.first || (s.drafts = {}))),
});

export const { setMode, setTool, setColor, addShape, undo, clear } = markupSlice.actions;

export const selectDraft = (s: RootState, tabId: string): Draft => s.markup.drafts[tabId] ?? EMPTY;
