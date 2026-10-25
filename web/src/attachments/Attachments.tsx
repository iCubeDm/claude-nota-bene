import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { useT } from '@/i18n/index.ts';

/** Full-size view. Esc / click closes; this Esc is consumed here (preventDefault + stop), so it never interrupts the agent. */
export function Lightbox({ id, onClose }: { id: string; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopImmediatePropagation(); // window capture: before any popup / composer / card handler
      onClose();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);
  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      data-anchor-skip
      data-lightbox
      onClick={onClose}
      className="fixed inset-0 z-50 grid cursor-zoom-out place-items-center bg-black/80"
    >
      <img src={`/attach/${id}`} alt="" className="max-h-[92vh] max-w-[92vw] rounded-lg object-contain" />
    </div>,
    document.body,
  );
}

export type PendingThumb = { key: string; url: string };

/**
 * A strip of thumbnails. `ids` are the uploaded images (lazy `/attach/<id>`), `pending` are uploads in flight (object URLs,
 * dimmed). With `onRemove` each uploaded thumbnail has a ×. The strip is not anchor text.
 */
export function Attachments({ ids, pending = [], onRemove, ...rest }: {
  ids: string[];
  pending?: PendingThumb[];
  onRemove?: (id: string) => void;
} & React.HTMLAttributes<HTMLDivElement>) {
  const t = useT();
  const [open, setOpen] = useState<string | null>(null);
  if (!ids.length && !pending.length) return null;
  return (
    <div data-anchor-skip className="flex flex-wrap gap-1.5 pt-1.5" {...rest}>
      {ids.map((id) => (
        <div key={id} className="relative">
          <img
            src={`/attach/${id}`}
            loading="lazy"
            alt=""
            onClick={() => setOpen(id)}
            className="size-14 cursor-zoom-in rounded-md border border-border-soft object-cover"
          />
          {onRemove && (
            <button
              type="button"
              title={t('remove')}
              aria-label={t('remove')}
              onMouseDown={(e) => e.preventDefault()}
              onClick={(e) => {
                e.stopPropagation();
                onRemove(id);
              }}
              className="absolute -top-1.5 -right-1.5 grid size-4 place-items-center rounded-full bg-background text-[10px] leading-none text-muted-foreground ring-1 ring-border hover:text-destructive"
            >
              ×
            </button>
          )}
        </div>
      ))}
      {pending.map((p) => (
        <img key={p.key} src={p.url} alt="" data-pending className="size-14 animate-pulse rounded-md border border-border-soft object-cover opacity-50" />
      ))}
      {open && <Lightbox id={open} onClose={() => setOpen(null)} />}
    </div>
  );
}
