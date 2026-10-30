import { createSlice, type PayloadAction } from '@reduxjs/toolkit';
import type { ImageType } from '@nota-bene/shared';
import { connState, serverEvent, type RootState } from '../store/store.ts';

/** What the last `! cmd` took out of the composer; kept until the server's `shell-start`, so a `shell-refused` can put the draft back. */
export type ShellDraft = { id: string; draft: string };

export type ImageEntry = { id: string; mediaType: ImageType };

/**
 * The composer's draft and its uploaded images live in the store so the comments panel's send can include them.
 * `uploading` counts uploads in flight (their thumbnails are component state): a send waits for it to reach 0.
 */
/** What the last send took out of the composer; kept until the server's `user` echo, so a `send-refused` can put it back. */
export type SentDraft = { id: string; text: string; images: ImageEntry[]; commentIds: string[] };

export const composerSlice = createSlice({
  name: 'composer',
  initialState: { draft: '', images: [] as ImageEntry[], uploading: 0, building: false, unconfirmed: null as SentDraft | null, shellUnconfirmed: null as ShellDraft | null },
  reducers: {
    setDraft: (s, a: PayloadAction<string>) => void (s.draft = a.payload),
    addImage: (s, a: PayloadAction<ImageEntry>) => void (s.images.some((i) => i.id === a.payload.id) || s.images.push(a.payload)),
    removeImage: (s, a: PayloadAction<string>) => void (s.images = s.images.filter((i) => i.id !== a.payload)),
    clearImages: (s) => void (s.images = []),
    uploadStarted: (s) => void (s.uploading += 1),
    uploadFinished: (s) => void (s.uploading = Math.max(0, s.uploading - 1)),
    setBuilding: (s, a: PayloadAction<boolean>) => void (s.building = a.payload),
    draftSent: (s, a: PayloadAction<SentDraft>) => void (s.unconfirmed = a.payload),
    shellDraftSent: (s, a: PayloadAction<ShellDraft>) => void (s.shellUnconfirmed = a.payload),
  },
  extraReducers: (b) =>
    b.addCase(serverEvent, (s, a) => {
      const ev = a.payload;
      // the echo (or the refusal, handled by refusedMiddleware before this runs), or a new history: nothing left to restore
      if ((ev.kind === 'user' && ev.id === s.unconfirmed?.id) || ev.kind === 'send-refused' || ev.kind === 'replay') s.unconfirmed = null;
      if ((ev.kind === 'shell-start' && ev.id === s.shellUnconfirmed?.id) || ev.kind === 'shell-refused' || ev.kind === 'replay') s.shellUnconfirmed = null;
    }).addCase(connState, (s, a) => {
      if (a.payload !== 'open') s.unconfirmed = s.shellUnconfirmed = null; // the refusal can no longer arrive on this socket
    }),
});

export const { setDraft, addImage, removeImage, clearImages, uploadStarted, uploadFinished, setBuilding, draftSent, shellDraftSent } = composerSlice.actions;
export const selectDraft = (s: RootState): string => s.composer.draft;
export const selectImages = (s: RootState): ImageEntry[] => s.composer.images;
export const selectUploading = (s: RootState): number => s.composer.uploading;
/** A send is building its combined images: the send buttons are off (a snapshot of the draft and comments is already taken). */
export const selectBuilding = (s: RootState): boolean => s.composer.building;
