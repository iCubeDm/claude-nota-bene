import { useRef, type KeyboardEvent } from 'react';
import { Button } from '@/components/ui/button.tsx';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog.tsx';
import { useT } from '@/i18n/index.ts';

/**
 * A modal yes/no (R-M4-3; replaces native confirm). Mount it to open it, unmount it on either answer.
 * Enter confirms (unless focus is on a button, which then takes its own Enter), Esc cancels and preventDefaults so
 * the Composer does not also read it as Stop. Focus enters the dialog (on Confirm) and it returns to the element that had it
 * before (the trigger) when the dialog closes.
 */
export function ConfirmDialog(p: {
  title: string; body: string; confirm: string; cancel?: string; onConfirm: () => void; onCancel: () => void;
  /** Where focus goes when it closes, instead of the opener (null: the opener), e.g. when the answer disables it. */
  focusAfter?: () => HTMLElement | null;
}) {
  const t = useT();
  const confirmRef = useRef<HTMLButtonElement>(null);
  // Radix returns focus only to a Dialog.Trigger, and this dialog is mounted by its owner instead: remember the opener
  const opener = useRef<Element | null>(document.activeElement);
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key !== 'Enter' || e.nativeEvent.isComposing || (e.target as HTMLElement).closest('button')) return;
    e.preventDefault();
    p.onConfirm();
  };
  return (
    <Dialog open onOpenChange={(o) => { if (!o) p.onCancel(); }}>
      <DialogContent
        onKeyDown={onKeyDown}
        onOpenAutoFocus={(e) => { e.preventDefault(); confirmRef.current?.focus(); }}
        onCloseAutoFocus={(e) => {
          e.preventDefault();
          const to = p.focusAfter?.() ?? opener.current;
          if (to instanceof HTMLElement && to.isConnected) to.focus();
        }}
        onEscapeKeyDown={(e) => { e.preventDefault(); p.onCancel(); }}
      >
        <DialogHeader>
          <DialogTitle>{p.title}</DialogTitle>
          <DialogDescription className="whitespace-pre-line">{p.body}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={p.onCancel}>{p.cancel ?? t('cancel')}</Button>
          <Button ref={confirmRef} type="button" onClick={p.onConfirm}>{p.confirm}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
