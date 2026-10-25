import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Provider } from 'react-redux';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ClientMessage } from '@nota-bene/shared';
import { textOf } from '@/anchors/text.ts';
import { TooltipProvider } from '@/components/ui/tooltip.tsx';
import { Composer } from '@/composer/Composer.tsx';
import { Feed } from '@/feed/Feed.tsx';
import { setLang } from '@/i18n/index.ts';
import { makeStore, serverEvent } from '@/store/store.ts';
import { Attachments } from './Attachments.tsx';

const uploads = vi.hoisted(() => [] as Blob[]);
vi.mock('./image.ts', async (orig) => ({
  ...(await orig<typeof import('./image.ts')>()),
  prepareImage: async (f: File) => f,
  uploadImage: async (b: Blob) => (uploads.push(b), { id: (b as File).name.padEnd(64, '0'), mediaType: 'image/png' }),
}));

const A = 'a'.padEnd(64, '0'), B = 'b'.padEnd(64, '0');
beforeEach(() => {
  setLang('en');
  URL.createObjectURL = vi.fn(() => 'blob:x');
  URL.revokeObjectURL = vi.fn();
  uploads.length = 0;
});
afterEach(cleanup);

function setup() {
  const sent: ClientMessage[] = [];
  const store = makeStore({ url: 'ws://x', connect: ((_u: string, _e: unknown, onState: (s: 'open') => void) => (onState('open'), { send: (m: ClientMessage) => (sent.push(m), true), close() {} })) as never });
  render(<Provider store={store}><TooltipProvider><Feed /><Composer /></TooltipProvider></Provider>);
  return { sent, store, box: screen.getByRole('textbox') as HTMLTextAreaElement };
}
const png = (name: string) => new File(['x'], name, { type: 'image/png' });
const paste = (el: HTMLElement, files: File[]) => {
  const ev = new Event('paste', { bubbles: true, cancelable: true });
  Object.defineProperty(ev, 'clipboardData', { value: { files, items: files.map((f) => ({ kind: 'file', type: f.type, getAsFile: () => new File([f], f.name, { type: f.type }) })) } });
  act(() => void el.dispatchEvent(ev));
  return ev;
};

it('pasting a pdf shows onlyImages and attaches nothing', () => {
  const { box } = setup();
  paste(box, [new File(['x'], 'a.pdf', { type: 'application/pdf' })]);
  expect(screen.getByText('Only images can be attached')).toBeInTheDocument();
  expect(document.querySelectorAll('img')).toHaveLength(0);
});

it('a pasted image uploads, shows a thumbnail, and sends alone with a label', async () => {
  const { sent, box } = setup();
  const ev = paste(box, [png(A)]);
  expect(ev.defaultPrevented).toBe(true);
  await waitFor(() => expect(document.querySelector('img:not([data-pending])')).toBeTruthy());
  expect(uploads).toHaveLength(1); // Chrome lists the file in files and items: one upload
  expect(document.querySelector(`img[src="/attach/${A}"]`)).toBeTruthy();
  await userEvent.type(box, '{Enter}');
  expect(sent[0]).toMatchObject({ type: 'send', text: '', images: [{ id: A, mediaType: 'image/png', label: '[image 1]' }] });
  expect(document.querySelectorAll('[data-testid="composer-thumbs"] img')).toHaveLength(0); // cleared with the draft
});

it('a failed upload shows imgFail and drops the image', async () => {
  const { box } = setup();
  const mod = await import('./image.ts');
  vi.spyOn(mod, 'uploadImage').mockRejectedValueOnce(new Error('x'));
  paste(box, [png(A)]);
  expect(await screen.findByText('Could not read the image')).toBeInTheDocument();
  expect(document.querySelectorAll('img')).toHaveLength(0);
});

it('the bubble renders its thumbnails outside the anchor text; a click opens the lightbox, Esc closes it without interrupting', async () => {
  const { sent, store } = setup();
  act(() => void store.dispatch(serverEvent({ kind: 'user', id: 'u1', text: 'look', ts: 0, images: [
    { id: A, mediaType: 'image/png', label: '[image 1]' }, { id: B, mediaType: 'image/png', label: '[image 2]' }] })));
  act(() => void store.dispatch(serverEvent({ kind: 'user', id: 'u3', text: 'look', ts: 0 })));
  const bubble = document.querySelector('[data-item-id="u1"]') as HTMLElement;
  expect(bubble.querySelectorAll('img')).toHaveLength(2);
  expect(bubble.querySelector('img')!.closest('[data-anchor-skip]')).toBeTruthy();
  expect(textOf(bubble)).toBe(textOf(document.querySelector('[data-item-id="u3"]')!)); // thumbnails add nothing to the anchor text
  await userEvent.click(bubble.querySelector('img')!);
  const lb = screen.getByRole('dialog');
  expect(lb).toHaveAttribute('data-anchor-skip');
  await userEvent.keyboard('{Escape}');
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(sent.find((m) => m.type === 'interrupt')).toBeUndefined();
});

it('Attachments removes by id', async () => {
  const onRemove = vi.fn();
  render(<Attachments ids={[A]} onRemove={onRemove} />);
  await userEvent.click(screen.getByRole('button', { name: 'Remove' }));
  expect(onRemove).toHaveBeenCalledWith(A);
});

it('Send is disabled while an upload is pending and Enter sends nothing', async () => {
  const mod = await import('./image.ts');
  let done!: (v: { id: string; mediaType: 'image/png' }) => void;
  vi.spyOn(mod, 'uploadImage').mockReturnValueOnce(new Promise((r) => (done = r)));
  const { sent, box } = setup();
  paste(box, [png(A)]);
  const btn = screen.getByRole('button', { name: 'Send' });
  expect(btn).toBeDisabled();
  expect(btn.parentElement).toHaveAttribute('title', 'Wait for the image to finish uploading');
  await userEvent.type(box, 'x{Enter}');
  expect(sent).toHaveLength(0);
  await act(async () => done({ id: A, mediaType: 'image/png' }));
  expect(screen.getByRole('button', { name: 'Send' })).toBeEnabled();
});
