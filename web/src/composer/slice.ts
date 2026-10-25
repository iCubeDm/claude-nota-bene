import { createSlice, type PayloadAction } from '@reduxjs/toolkit';
import type { ImageType } from '@nota-bene/shared';
import type { RootState } from '../store/store.ts';

export type ImageEntry = { id: string; mediaType: ImageType };

/**
 * The composer's draft and its uploaded images live in the store so the comments panel's send can include them.
 * `uploading` counts uploads in flight (their thumbnails are component state): a send waits for it to reach 0.
 */
export const composerSlice = createSlice({
  name: 'composer',
  initialState: { draft: '', images: [] as ImageEntry[], uploading: 0 },
  reducers: {
    setDraft: (s, a: PayloadAction<string>) => void (s.draft = a.payload),
    addImage: (s, a: PayloadAction<ImageEntry>) => void (s.images.some((i) => i.id === a.payload.id) || s.images.push(a.payload)),
    removeImage: (s, a: PayloadAction<string>) => void (s.images = s.images.filter((i) => i.id !== a.payload)),
    clearImages: (s) => void (s.images = []),
    uploadStarted: (s) => void (s.uploading += 1),
    uploadFinished: (s) => void (s.uploading = Math.max(0, s.uploading - 1)),
  },
});

export const { setDraft, addImage, removeImage, clearImages, uploadStarted, uploadFinished } = composerSlice.actions;
export const selectDraft = (s: RootState): string => s.composer.draft;
export const selectImages = (s: RootState): ImageEntry[] => s.composer.images;
export const selectUploading = (s: RootState): number => s.composer.uploading;
