/** Set a textarea's value through the native setter and fire a bubbling `input`, so a controlled React textarea picks it up. */
export function setValueAndCaret(ta: HTMLTextAreaElement, value: string, caret: number): void {
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(ta, value);
  ta.setSelectionRange(caret, caret);
  ta.dispatchEvent(new Event('input', { bubbles: true }));
}
