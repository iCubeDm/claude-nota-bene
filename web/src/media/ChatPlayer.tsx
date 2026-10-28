import { useEffect, useRef } from 'react';
import { fileTabId } from '@/tabs/slice.ts';
import { setStartAt } from '@/files/startAt.ts';
import { refOf } from '@/files/sources.ts';
import { fileOfImage, openMediaFile } from '@/refs/refs.ts';
import { useAppDispatch } from '@/store/store.ts';
import { PlayerBar } from './PlayerBar.tsx';
import { PlayerFlash } from './PlayerFlash.tsx';
import { applyPlayerKey } from './playerKeys.ts';
import { useChatPlayerKeys } from './useChatPlayerKeys.ts';

/**
 * Our bar for a video/audio in a chat reply, rendered by Markdown as a portal into the element's `.md-media` wrapper
 * (`box`). Replaces the native controls, makes the wrapper focusable so the player keys work for the player last
 * clicked, and toggles play on a click on the picture. Ticks (a project file's media comments) open the file's tab at
 * that time: the chat copy is a small preview, not the place to look at a drawing.
 */
export function ChatPlayer({ media, box }: { media: HTMLMediaElement; box: HTMLElement }) {
  const dispatch = useAppDispatch();
  const ref = useRef<HTMLElement | null>(box);
  ref.current = box;
  const flash = useChatPlayerKeys(media, ref);
  const f = fileOfImage(media);
  const file = f && !f.path.startsWith('/attach/') ? f : null; // a pasted image's /file URL is not a project file
  useEffect(() => {
    media.removeAttribute('controls');
    box.tabIndex = -1;
    const focus = () => { if (!box.contains(document.activeElement)) box.focus({ preventScroll: true }); };
    const toggle = () => void applyPlayerKey(media, 'KeyK', '', box);
    box.addEventListener('pointerdown', focus);
    if (media instanceof HTMLVideoElement) media.addEventListener('click', toggle);
    return () => {
      box.removeEventListener('pointerdown', focus);
      media.removeEventListener('click', toggle);
    };
  }, [media, box]);
  const onTick = file && ((time: number) => {
    const open = openMediaFile(media);
    if (!open) return;
    setStartAt(fileTabId(file.path, file.src), time);
    dispatch(open);
  });
  return (
    <>
      <PlayerBar media={media} box={ref} flash={flash} path={file?.path} refName={file ? refOf(file.src) : undefined} onTick={onTick ?? undefined} />
      <PlayerFlash flash={flash} />
    </>
  );
}
