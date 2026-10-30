import { useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react';
import type { SlashCommand } from '@nota-bene/shared';
import { useT } from '@/i18n/index.ts';
import { setValueAndCaret } from '@/comments/insertText.ts';
import { selectCommands } from '@/controls/slice.ts';
import { useAppSelector } from '@/store/store.ts';
import { highlight } from './MentionPicker.tsx';
import { placeListFor, revealSelected } from './placeList.ts';
import { rankCommands, slashToken } from './slashRank.ts';

interface Open { q: string; sel: number }

/**
 * `/command` menu for the composer: the session's skills and commands, offered while the caret is in the first word of a
 * draft that starts with `/`. Same key contract as MentionPicker: while open, keys are taken at WINDOW capture so
 * Enter/Tab/Esc never reach the composer's own handlers; Cmd/Ctrl+Enter passes through (send). Picking writes `/name `
 * and leaves the caret after it. No list yet (the agent is not up) or nothing matching: closed, and typing goes on as it was
 * (a command typed by hand that is not offered still runs).
 */
export function SlashPicker({ target }: { target: RefObject<HTMLTextAreaElement | null> }) {
  const t = useT();
  const commands = useAppSelector(selectCommands);
  const [state, setState] = useState<Open | null>(null);
  const live = useRef<{ open: Open | null; items: SlashCommand[] }>({ open: null, items: [] });
  const menu = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const items = useMemo(() => (state ? rankCommands(commands, state.q) : []), [commands, state?.q]);
  const sel = state ? Math.min(state.sel, items.length - 1) : 0; // the list can shrink under the selection (a pushed list)
  live.current = { open: state && items.length ? { ...state, sel } : null, items };
  const pick = useRef<(c: SlashCommand) => void>(() => {});

  useEffect(() => {
    const ta = target.current;
    if (!ta) return;
    let dismissed: string | null = null; // Esc: shut for this word (while the first word is exactly it), until it changes or the caret leaves
    const close = () => setState(null);
    const refresh = () => {
      const q = slashToken(ta.value, ta.selectionStart);
      const word = q === null ? null : /^\/\S*/.exec(ta.value)![0]; // the whole first word, wherever the caret is in it
      if (word !== dismissed) dismissed = null; // another word, a cleared or sent draft: nothing to carry over
      if (dismissed !== null) return;
      setState((s) => (q === null ? null : s && s.q === q ? s : { q, sel: 0 })); // the same word keeps the selection
    };
    const onSel = () => { if (document.activeElement === ta) refresh(); }; // also when closed: an arrow key can move the caret into the word
    pick.current = (c) => {
      const word = /\s/.exec(ta.value);
      const rest = word ? ta.value.slice(word.index) : ''; // the whole first word is replaced, wherever the caret was in it
      close();
      // an input event follows, which finds the caret past the space and keeps the menu closed
      setValueAndCaret(ta, `/${c.name} ${rest.replace(/^ /, '')}`, c.name.length + 2);
    };
    const onKey = (e: KeyboardEvent) => {
      const { open, items: list } = live.current;
      if (!open || e.target !== ta || e.isComposing) return;
      const plainEnter = e.key === 'Enter' && !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey;
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) return close(); // send: let it through
      if (e.key === 'Tab' && e.shiftKey) return close(); // the composer's mode cycle: close, let it through
      let handled = true;
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        const d = e.key === 'ArrowDown' ? 1 : -1;
        setState({ ...open, sel: (open.sel + d + list.length) % list.length });
      } else if (plainEnter || e.key === 'Tab') pick.current(list[open.sel]);
      else if (e.key === 'Escape') { dismissed = /^\/\S*/.exec(ta.value)?.[0] ?? null; close(); }
      else handled = false;
      if (handled) { e.preventDefault(); e.stopPropagation(); }
    };
    ta.addEventListener('input', refresh);
    ta.addEventListener('click', refresh);
    ta.addEventListener('blur', close);
    window.addEventListener('keydown', onKey, true);
    document.addEventListener('selectionchange', onSel);
    return () => {
      document.removeEventListener('selectionchange', onSel);
      ta.removeEventListener('input', refresh);
      ta.removeEventListener('click', refresh);
      ta.removeEventListener('blur', close);
      window.removeEventListener('keydown', onKey, true);
    };
  }, [target]);

  const shown = !!state && items.length > 0;
  // above the field when it fits, else the roomier side, height capped to that side (placeList)
  useLayoutEffect(() => {
    const ta = target.current;
    if (!shown || !ta || !menu.current) return;
    // never wider than the field: the menu stays in the chat column (the Comments panel sits to its right)
    menu.current.style.width = `${Math.min(416, ta.getBoundingClientRect().width)}px`;
    setPos(placeListFor(menu.current, ta));
  }, [shown, items, target]);
  useLayoutEffect(() => {
    if (menu.current) revealSelected(menu.current);
  }, [sel, items, pos]);

  if (!shown) return null;
  return (
    <div
      ref={menu}
      role="listbox"
      aria-label={t('slashLabel')}
      className="fixed z-20 max-h-[min(20rem,40vh)] overflow-y-auto overflow-x-hidden w-[26rem] max-w-[90vw] rounded-[10px] border border-border bg-popover p-1 shadow-[0_10px_32px_rgba(0,0,0,0.5)]"
      style={{ left: pos?.left ?? 0, top: pos?.top ?? 0, visibility: pos ? 'visible' : 'hidden' }}
    >
      {items.map((c, k) => (
        <div
          key={c.name}
          role="option"
          aria-selected={k === sel}
          onMouseDown={(e) => e.preventDefault() /* keep focus in the textarea */}
          onClick={() => { target.current?.focus(); pick.current(c); }}
          className={`flex min-w-0 cursor-pointer flex-col gap-px rounded-md px-2 py-1 text-[12.5px] text-foreground ${k === sel ? 'bg-primary/15' : 'hover:bg-accent'}`}
        >
          <div className="flex min-w-0 items-baseline gap-2">
            <span className="min-w-0 shrink truncate font-mono">/{highlight(c.name, state.q.toLowerCase())}</span>
            {c.hint && <span className="min-w-0 shrink-[2] truncate font-mono text-[11.5px] text-muted-foreground">{c.hint}</span>}
            {c.builtin && <span className="ml-auto flex-none rounded bg-muted px-1 text-[10.5px] text-muted-foreground">{t('slashBuiltin')}</span>}
          </div>
          {c.description && <div className="truncate text-[11.5px] text-muted-foreground">{c.description}</div>}
        </div>
      ))}
    </div>
  );
}
