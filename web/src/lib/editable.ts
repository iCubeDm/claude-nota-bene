/** A text field: input, textarea, select, or any contenteditable (including "plaintext-only"), where keys type text. */
export const editable = (t: EventTarget | null): boolean =>
  t instanceof HTMLElement && (t.isContentEditable || !!t.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"])'));
