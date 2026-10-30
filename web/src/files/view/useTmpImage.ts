import { useEffect, useRef, useState } from 'react';
import { fetchTmpImage, type TmpLoad } from '../tmpImages.ts';

/**
 * The bytes of a temp image as a blob URL, fetched with the key (the cookie alone does not open `/tmpimage`). `url` null =
 * not a temp image, nothing happens. A new `url` (a reload) keeps the picture on screen until the new one arrives; the blob
 * URL it replaces, and the last one when the tab closes, are revoked.
 */
export function useTmpImage(url: string | null): TmpLoad {
  const [state, setState] = useState<TmpLoad>({ s: 'loading' });
  const current = useRef<string | null>(null);
  useEffect(() => {
    if (!url) return;
    const ac = new AbortController();
    fetchTmpImage(url, ac.signal).then(
      (r) => {
        if (ac.signal.aborted) return;
        if (r.s !== 'ok') {
          if (current.current) URL.revokeObjectURL(current.current); // a picture that is gone is no longer shown
          current.current = null;
          return setState(r);
        }
        const next = URL.createObjectURL(r.blob);
        if (current.current) URL.revokeObjectURL(current.current);
        current.current = next;
        setState({ s: 'ok', url: next });
      },
      () => ac.signal.aborted || setState({ s: 'error' }),
    );
    return () => ac.abort();
  }, [url]);
  useEffect(() => () => {
    if (current.current) URL.revokeObjectURL(current.current);
    current.current = null;
  }, []);
  return state;
}
