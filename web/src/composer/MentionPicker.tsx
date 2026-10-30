import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { useT } from '@/i18n/index.ts';
import { setValueAndCaret } from '@/comments/insertText.ts';
import { FileIcon } from '@/files/FileIcon.tsx';
import { placeListFor, revealSelected } from './placeList.ts';

// copied from the prototype: `@` at a word start, up to the caret
export const AT_RE = /(^|\s)@("[^"]*|[^\s"]*)$/;
// the `:` shortcode trigger (ShortcodePicker); when it is closer to the caret than the `@`, it owns the keys
const SHORTCODE = /(^|\s):[a-z0-9_+-]{2,}:?$/i;
const DEBOUNCE_MS = 80;

interface Open { items: string[]; sel: number; start: number; q: string }

/** Bolds the matched characters: the same subsequence walk as the server. */
export function highlight(text: string, q: string): ReactNode[] {
  let i = 0;
  return [...text].map((ch, k) => (i < q.length && ch.toLowerCase() === q[i] ? (i++, <mark key={k} className="bg-transparent font-semibold text-primary">{ch}</mark> ) : ch));
}

/**
 * `@path` mention autocomplete for any textarea (composer, comment popup). Same key contract as ShortcodePicker:
 * while open, keys are taken at WINDOW capture so Enter/Tab/Esc never reach the host's own handlers.
 */
export function MentionPicker({ target }: { target: RefObject<HTMLTextAreaElement | null> }) {
  const t = useT();
  const [state, setState] = useState<Open | null>(null);
  const live = useRef<Open | null>(null);
  const inserter = useRef<(p: string, start: number) => void>(() => {});
  const menu = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const set = (s: Open | null) => { live.current = s; setState(s); };

  useEffect(() => {
    const ta = target.current;
    if (!ta) return;
    let seq = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let ctl: AbortController | undefined;
    let asked = ''; // start + query of the latest request, so a caret move inside the same token does not refetch
    const cancel = () => {
      seq++;
      clearTimeout(timer);
      timer = undefined;
      ctl?.abort();
      ctl = undefined;
      asked = '';
    };
    const close = () => { cancel(); set(null); };
    const run = (start: number, q: string) => {
      const mine = ++seq;
      ctl?.abort();
      ctl = new AbortController();
      fetch(`/complete?q=${encodeURIComponent(q)}`, { signal: ctl.signal })
        .then((r) => (r.ok ? (r.json() as Promise<string[]>) : Promise.reject(new Error(String(r.status)))))
        .then((items) => {
          if (mine !== seq) return; // a newer keystroke won
          set({ items, sel: 0, start, q });
        })
        .catch(() => { if (mine === seq) close(); }); // network error: close silently
    };
    const update = () => {
      const before = ta.value.slice(0, ta.selectionStart);
      const m = AT_RE.exec(before);
      // the closer trigger wins: a live `:code` after the `@` belongs to ShortcodePicker
      if (!m || SHORTCODE.test(before)) return close();
      const q = m[2].replace(/^"/, '').toLowerCase();
      const start = before.length - m[2].length - 1;
      if (asked === `${start}:${q}`) return;
      cancel();
      asked = `${start}:${q}`;
      timer = setTimeout(() => run(start, q), DEBOUNCE_MS);
    };
    const onSel = () => { if (document.activeElement === ta && live.current) update(); };
    const insert = (p: string, start: number) => {
      const end = ta.selectionStart;
      const ref = /\s/.test(p) ? `@"${p}"` : `@${p}`;
      const tail = p.endsWith('/') ? '' : ' '; // a folder keeps the picker going for its files
      close();
      // an input event follows, which re-queries for a folder and closes for a file
      setValueAndCaret(ta, ta.value.slice(0, start) + ref + tail + ta.value.slice(end), start + ref.length + tail.length);
    };
    inserter.current = insert;
    const onKey = (e: KeyboardEvent) => {
      const s = live.current;
      if (!s || e.target !== ta || e.isComposing) return;
      const plainEnter = e.key === 'Enter' && !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey;
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) return close(); // send / add: let it through
      if ((plainEnter || e.key === 'Tab') && !s.items.length) return close(); // nothing to pick: do not swallow the key
      let handled = true;
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        if (!s.items.length) return;
        const d = e.key === 'ArrowDown' ? 1 : -1;
        set({ ...s, sel: (s.sel + d + s.items.length) % s.items.length });
      } else if (plainEnter || e.key === 'Tab') insert(s.items[s.sel], s.start);
      else if (e.key === 'Escape') close();
      else handled = false;
      if (handled) { e.preventDefault(); e.stopPropagation(); }
    };
    ta.addEventListener('input', update);
    ta.addEventListener('click', update);
    ta.addEventListener('blur', close);
    window.addEventListener('keydown', onKey, true);
    document.addEventListener('selectionchange', onSel);
    return () => {
      cancel();
      document.removeEventListener('selectionchange', onSel);
      ta.removeEventListener('input', update);
      ta.removeEventListener('click', update);
      ta.removeEventListener('blur', close);
      window.removeEventListener('keydown', onKey, true);
    };
  }, [target]);

  // above the field when it fits, else the roomier side, height capped to that side (placeList)
  useLayoutEffect(() => {
    const ta = target.current;
    if (!state || !ta || !menu.current) return;
    setPos(placeListFor(menu.current, ta));
  }, [state?.items, target]);
  // the selected option scrolls into view inside the list only: scrollIntoView would scroll the document too
  useLayoutEffect(() => {
    if (menu.current) revealSelected(menu.current);
  }, [state?.sel, state?.items, pos]);

  if (!state) return null;
  const pick = (k: number) => {
    target.current?.focus();
    inserter.current(state.items[k], state.start);
  };
  return (
    <div
      ref={menu}
      role="listbox"
      className="fixed z-20 max-h-[min(20rem,40vh)] overflow-y-auto w-80 max-w-[90vw] rounded-[10px] border border-border bg-popover p-1 shadow-[0_10px_32px_rgba(0,0,0,0.5)]"
      style={{ left: pos?.left ?? 0, top: pos?.top ?? 0, visibility: pos ? 'visible' : 'hidden' }}
    >
      {state.items.length === 0 && <div className="px-2 py-1 text-xs text-muted-foreground">{t('atNone')}</div>}
      {state.items.map((p, k) => {
        const dir = p.endsWith('/');
        const clean = p.replace(/\/$/, '');
        const cut = clean.lastIndexOf('/') + 1;
        return (
          <div
            key={p}
            role="option"
            aria-selected={k === state.sel}
            onMouseDown={(e) => e.preventDefault() /* keep focus in the textarea */}
            onClick={() => pick(k)}
              className={`flex cursor-pointer items-center gap-2 rounded-md px-2 py-1 text-[12.5px] text-foreground ${k === state.sel ? 'bg-primary/15' : 'hover:bg-accent'}`}
          >
            <FileIcon path={p} dir={dir} />
            <span className="flex-none">{highlight(clean.slice(cut) + (dir ? '/' : ''), state.q)}</span>
            <span className="truncate text-muted-foreground">{clean.slice(0, cut)}</span>
          </div>
        );
      })}
    </div>
  );
}
