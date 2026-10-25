import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { loadEmoji, searchShortcodes } from './emoji.ts';
import { setValueAndCaret } from './insertText.ts';

// `:` at a word start + >=2 chars, up to the caret; optionally already closed by a second colon
const TOKEN = /(^|\s):([a-z0-9_+-]{2,})(:?)$/i;

interface Item { code: string; emoji: string }
interface Open { items: Item[]; sel: number; start: number }

/**
 * GitHub-style `:code` autocomplete for any textarea. Keys are intercepted at WINDOW capture so that,
 * while the list is open, Esc/Enter/Tab never reach the host's own document-level handlers (popup Esc,
 * composer send). Insertion goes through the native value setter + a bubbling `input` event so a
 * controlled React textarea picks the change up.
 */
export function ShortcodePicker({ target }: { target: RefObject<HTMLTextAreaElement | null> }) {
  const [state, setState] = useState<Open | null>(null);
  const live = useRef<Open | null>(null);
  const menu = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const set = (s: Open | null) => { live.current = s; setState(s); };

  const insert = (ta: HTMLTextAreaElement, start: number, emoji: string) => {
    const end = ta.selectionStart;
    // the caret may have moved since the list was built: never insert over a stale token
    if (!/^:[a-z0-9_+-]{2,}:?$/i.test(ta.value.slice(start, end)) || (start > 0 && !/\s/.test(ta.value[start - 1]))) return;
    const next = ta.value.slice(0, start) + emoji + ta.value.slice(end);
    setValueAndCaret(ta, next, start + emoji.length);
  };

  useEffect(() => {
    const ta = target.current;
    if (!ta) return;
    let dead = false;
    const update = (typed = false) => {
      if (dead) return;
      const before = ta.value.slice(0, ta.selectionStart);
      const m = TOKEN.exec(before);
      if (!m) return set(null);
      const code = m[2].toLowerCase();
      const start = before.length - m[0].length + m[1].length;
      if (m[3]) { // closing colon: replace at once if the code exists, otherwise leave the text alone
        set(null);
        if (!typed) return; // only typing the closing colon replaces, never a caret jump
        const hit = searchShortcodes(code).find((e) => e.code.toLowerCase() === code);
        if (hit) insert(ta, start, hit.emoji);
        return;
      }
      const items = searchShortcodes(code, 8);
      if (!items.length) return set(null);
      const cur = live.current;
      if (cur && cur.start === start && cur.items.map((i) => i.code).join() === items.map((i) => i.code).join()) return; // keep the selection
      set({ items, sel: 0, start });
    };
    // caret moved by keys or mouse: re-evaluate (closes the list once the caret leaves the token)
    const onSel = () => { if (document.activeElement === ta && live.current) update(); };
    const onInput = () => {
      // the first colon warms the (lazy, ~600 KB) emoji data; re-run once it has arrived
      const caret = ta.selectionStart;
      // a caret that moved while loading must not trigger the typed-only closing-colon replacement
      if (/:[a-z0-9_+-]*$/i.test(ta.value.slice(0, caret))) void loadEmoji().then(() => update(ta.selectionStart === caret), (err) => console.warn('emoji data failed to load', err));
      update(true);
    };
    const close = () => set(null);
    const onKey = (e: KeyboardEvent) => {
      const s = live.current;
      if (!s || e.target !== ta || e.isComposing) return;
      let handled = true;
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        const d = e.key === 'ArrowDown' ? 1 : -1;
        set({ ...s, sel: (s.sel + d + s.items.length) % s.items.length });
      } else if ((e.key === 'Enter' && !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey) || e.key === 'Tab') {
        set(null);
        insert(ta, s.start, s.items[s.sel].emoji);
      } else if (e.key === 'Escape') set(null);
      else handled = false;
      if (handled) { e.preventDefault(); e.stopPropagation(); }
    };
    ta.addEventListener('input', onInput);
    const onClick = () => update();
    ta.addEventListener('click', onClick);
    ta.addEventListener('blur', close);
    window.addEventListener('keydown', onKey, true);
    document.addEventListener('selectionchange', onSel);
    return () => {
      dead = true;
      document.removeEventListener('selectionchange', onSel);
      ta.removeEventListener('input', onInput);
      ta.removeEventListener('click', onClick);
      ta.removeEventListener('blur', close);
      window.removeEventListener('keydown', onKey, true);
    };
  }, [target]);

  // above the field when there is room, else below
  useLayoutEffect(() => {
    const ta = target.current;
    if (!state || !ta || !menu.current) return;
    const r = ta.getBoundingClientRect();
    const { offsetWidth: w, offsetHeight: h } = menu.current;
    setPos({
      left: Math.max(8, Math.min(r.left, window.innerWidth - w - 8)),
      top: r.top - h - 6 >= 8 ? r.top - h - 6 : r.bottom + 6,
    });
  }, [state?.items, target]);

  if (!state) return null;
  const pick = (k: number) => {
    const ta = target.current;
    if (!ta) return;
    set(null);
    ta.focus();
    insert(ta, state.start, state.items[k].emoji);
  };
  return (
    <div
      ref={menu}
      role="listbox"
      className="fixed z-20 w-60 rounded-[10px] border border-border bg-popover p-1 shadow-[0_10px_32px_rgba(0,0,0,0.5)]"
      style={{ left: pos?.left ?? 0, top: pos?.top ?? 0, visibility: pos ? 'visible' : 'hidden' }}
    >
      {state.items.map((it, k) => (
        <div
          key={it.code}
          role="option"
          aria-selected={k === state.sel}
          onMouseDown={(e) => e.preventDefault() /* keep focus in the textarea */}
          onClick={() => pick(k)}
          ref={k === state.sel ? (el) => el?.scrollIntoView?.({ block: 'nearest' }) : undefined}
          className={`flex cursor-pointer items-center gap-2 rounded-md px-2 py-1 font-mono text-[12.5px] text-foreground ${k === state.sel ? 'bg-primary/15' : 'hover:bg-accent'}`}
        >
          <span className="w-5 text-center text-[15px] leading-none">{it.emoji}</span>
          <span className="truncate">:{it.code}:</span>
        </div>
      ))}
    </div>
  );
}
