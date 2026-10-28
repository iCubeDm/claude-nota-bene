import { useEffect, useState, type MutableRefObject } from 'react';
import { useT } from '@/i18n/index.ts';
import { editable } from '@/lib/editable.ts';
import { applyPlayerKey, ONCE, THEIRS, type Flash } from './playerKeys.ts';

/**
 * The player keys for one video/audio in a chat reply. Unlike a media tab's, they are off until the user has put focus
 * on this player (clicked it or its bar; the wrapper `box` takes focus on pointerdown): with focus on the composer, on
 * text, or on another player the keys stay theirs. Same capture-phase swallowing as usePlayerKeys, so Space neither
 * scrolls nor presses a focused bar button twice.
 */
export function useChatPlayerKeys(media: HTMLMediaElement, box: MutableRefObject<HTMLElement | null>): Flash | null {
  const t = useT();
  const unit = t('unitSec');
  const [flash, setFlash] = useState<Flash | null>(null);
  useEffect(() => {
    let n = 0;
    let swallowKeyup = false;
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey || e.defaultPrevented || e.isComposing || editable(e.target)) return;
      const f = document.activeElement;
      if (!f || !box.current?.contains(f) || f.closest(THEIRS)) return;
      const code = e.code.replace(/^Numpad(\d)$/, 'Digit$1');
      const text = e.repeat && ONCE(code) ? '' : applyPlayerKey(media, code, unit, box.current);
      if (text === null) return;
      e.preventDefault();
      e.stopPropagation();
      if (code === 'Space') swallowKeyup = true;
      if (text) setFlash({ n: ++n, text });
    };
    const onUp = (e: KeyboardEvent) => {
      if (e.code === 'Space' && swallowKeyup) { swallowKeyup = false; e.preventDefault(); e.stopPropagation(); }
    };
    document.addEventListener('keydown', onKey, true);
    document.addEventListener('keyup', onUp, true);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      document.removeEventListener('keyup', onUp, true);
    };
  }, [media, box, unit]);
  return flash;
}
