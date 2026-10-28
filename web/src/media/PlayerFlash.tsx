import { useEffect, useState } from 'react';
import type { Flash } from './playerKeys.ts';

const SHOW_MS = 600;

/** YouTube-style on-screen hint of the last player key (▶, −5 s, 🔊 45 %), fading out over the media. */
export function PlayerFlash({ flash }: { flash: Flash | null }) {
  const [shown, setShown] = useState<Flash | null>(null);
  useEffect(() => {
    if (!flash) return;
    setShown(flash);
    const id = setTimeout(() => setShown(null), SHOW_MS);
    return () => clearTimeout(id);
  }, [flash]);
  if (!shown) return null;
  return (
    <div
      key={shown.n}
      data-player-flash
      role="status"
      data-anchor-skip
      style={{ animation: `nb-player-flash ${SHOW_MS}ms ease-out forwards` }}
      className="pointer-events-none absolute top-1/2 left-1/2 z-20 -translate-x-1/2 -translate-y-1/2 rounded-full bg-popover/80 px-5 py-3 text-lg font-medium text-popover-foreground shadow-md select-none"
    >
      {shown.text}
    </div>
  );
}
