import { useCallback, useEffect, useRef, useState } from 'react';
import type { t as tNow } from '@/i18n/index.ts';

/** Why a control refused (the picker's switch, the Clear button), as the i18n key of its reason. */
export const REFUSED: Record<'busy' | 'switching' | 'offline', Parameters<typeof tNow>[0]> = { busy: 'working', switching: 'switching', offline: 'offline' };

/** A short note that clears itself after 4 s: the inline feedback of a refused control. */
export function useNote(): [string, (text: string) => void] {
  const [note, setNote] = useState('');
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const show = useCallback((text: string) => {
    setNote(text);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setNote(''), 4000);
  }, []);
  return [note, show];
}
