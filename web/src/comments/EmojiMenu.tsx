import { useDeferredValue, useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { getLang, useT } from '@/i18n/index.ts';
import { setValueAndCaret } from './insertText.ts';
import { emojiGroups, loadEmoji, searchShortcodes } from './emoji.ts';

const RECENT_KEY = 'emoji:recent';
const RECENT_MAX = 16;
const SEARCH_MAX = 200;
const MENU_W = 288;
const MENU_H = 320;

function readRecent(): string[] {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]');
    return Array.isArray(v) ? [...new Set(v.filter((x): x is string => typeof x === 'string'))].slice(0, RECENT_MAX) : [];
  } catch {
    return [];
  }
}

function pushRecent(emoji: string): void {
  try {
    const next = [emoji, ...readRecent().filter((e) => e !== emoji)].slice(0, RECENT_MAX);
    localStorage.setItem(RECENT_KEY, JSON.stringify(next));
  } catch {
    /* storage blocked or full: recents are a nicety */
  }
}

/** Replace the selection (or insert at the caret). */
function insertAtCaret(ta: HTMLTextAreaElement, emoji: string): void {
  const { selectionStart: a, selectionEnd: b, value } = ta;
  setValueAndCaret(ta, value.slice(0, a) + emoji + value.slice(b), a + emoji.length);
}

/**
 * Emoji button + popover. The popover is rendered inside the host's DOM subtree (so the host's
 * "mousedown outside" check ignores it) and fixed-positioned next to the button. Esc is taken at WINDOW
 * capture so only the menu closes. ~1800 plain buttons render in one pass; each group uses
 * `content-visibility: auto`, so the browser skips layout/paint of the off-screen ones.
 */
export function EmojiMenu({ target }: { target: RefObject<HTMLTextAreaElement | null> }) {
  const t = useT();
  const lang = getLang();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [recent, setRecent] = useState<string[]>([]);
  const [, bump] = useState(0);
  const btn = useRef<HTMLButtonElement>(null);
  const pop = useRef<HTMLDivElement>(null);
  // fixed size => position depends only on the button, never on content (cold data, search results)
  const [place, setPlace] = useState<{ left: number; top?: number; bottom?: number; height: number } | null>(null);
  const [shown, setShown] = useState(1);
  const dq = useDeferredValue(q);

  const close = (refocus = true) => {
    setOpen(false);
    setQ('');
    if (refocus) target.current?.focus();
  };

  useEffect(() => {
    if (!open) return;
    setRecent(readRecent());
    let dead = false;
    loadEmoji().then(() => !dead && bump((n) => n + 1), (err) => console.warn('emoji data failed to load', err));
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      close();
    };
    const onDown = (e: MouseEvent) => {
      const n = e.target as Node;
      if (!pop.current?.contains(n) && !btn.current?.contains(n)) close(false);
    };
    window.addEventListener('keydown', onKey, true);
    document.addEventListener('mousedown', onDown);
    return () => {
      dead = true;
      window.removeEventListener('keydown', onKey, true);
      document.removeEventListener('mousedown', onDown);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- close only touches refs and setState
  }, [open]);

  const openMenu = () => {
    const r = btn.current!.getBoundingClientRect();
    const height = Math.min(MENU_H, window.innerHeight - 16);
    const above = r.top - 6 - height >= 8;
    setPlace({
      left: Math.max(8, Math.min(r.right - MENU_W, window.innerWidth - MENU_W - 8)),
      ...(above ? { bottom: window.innerHeight - r.top + 6 } : { top: Math.max(8, Math.min(r.bottom + 6, window.innerHeight - height - 8)) }),
      height,
    });
    setShown(1);
    setOpen(true);
  };

  // first frame: recents + first group; the other groups arrive one per frame so opening never blocks
  useEffect(() => {
    if (!open || shown >= emojiGroups().length) return;
    const id = requestAnimationFrame(() => setShown((n) => n + 1));
    return () => cancelAnimationFrame(id);
  });

  const all = emojiGroups();
  const labels = useMemo(() => new Map(all.flatMap((g) => g.items.map((i) => [i.emoji, i.label] as const))), [all]);
  const needle = dq.trim().toLowerCase().replace(/^:|:$/g, '');
  const sections = useMemo(() => {
    if (!needle) {
      const rec = recent.map((emoji) => ({ emoji, label: labels.get(emoji) ?? '', code: '' }));
      return [
        ...(rec.length ? [{ key: 'recent', title: t('emojiRecent'), items: rec }] : []),
        ...all.slice(0, shown).map((g) => ({ key: g.group, title: t(`emojiGroup_${g.group}` as 'emojiTip'), items: g.items })),
      ];
    }
    // groups carry only the first shortcode; the index knows every alias (thumbsup, +1)
    const byCode = new Set(searchShortcodes(needle, Infinity).map((e) => e.emoji));
    let left = SEARCH_MAX;
    return all
      .map((g) => {
        const items = g.items.filter((i) => byCode.has(i.emoji) || i.label.toLowerCase().includes(needle)).slice(0, left);
        left -= items.length;
        return { key: g.group, title: t(`emojiGroup_${g.group}` as 'emojiTip'), items };
      })
      .filter((s) => s.items.length);
    // t is stable across languages, so the language itself is a dependency
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [all, labels, needle, recent, lang, needle ? 0 : shown]);

  const pick = (emoji: string) => {
    const ta = target.current;
    if (!ta) return;
    pushRecent(emoji);
    close();
    insertAtCaret(ta, emoji);
  };

  return (
    <>
      <button
        ref={btn}
        type="button"
        title={t('emojiTip')}
        aria-label={t('emojiTip')}
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => (open ? close() : openMenu())}
        className="inline-flex size-6 items-center justify-center rounded-md text-[14px] leading-none hover:bg-accent"
      >
        😊
      </button>
      {open && (
        <div
          ref={pop}
          role="dialog"
          aria-label={t('emojiTip')}
          className="fixed z-30 flex w-[288px] flex-col rounded-[10px] border border-border bg-popover p-1.5 shadow-[0_10px_32px_rgba(0,0,0,0.5)]"
          style={{ left: place?.left, top: place?.top, bottom: place?.bottom, height: place?.height }}
        >
          <input
            autoFocus
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={t('emojiSearchPh')}
            aria-label={t('emojiSearchPh')}
            className="mb-1.5 w-full rounded-md border border-border-soft bg-background px-2 py-1 text-[12.5px] text-foreground focus:border-primary focus:outline-none"
          />
          <div className="min-h-0 flex-1 overflow-y-auto">
            {sections.length === 0 && all.length > 0 && <div className="px-1 py-2 text-[12px] text-muted-foreground">{t('emojiNone')}</div>}
            {sections.map((s) => (
              <section key={s.key} style={{ contentVisibility: 'auto', containIntrinsicSize: 'auto 120px' }}>
                <h4 className="px-1 pb-0.5 pt-1 text-[10.5px] font-medium text-muted-foreground">{s.title}</h4>
                <div className="flex flex-wrap">
                  {s.items.map((i) => (
                    <button
                      key={i.emoji}
                      type="button"
                      title={i.code ? `:${i.code}: ${i.label}` : i.label}
                      aria-label={i.label || i.emoji}
                      onMouseDown={(e) => e.preventDefault() /* keep the caret/selection where it was */}
                      onClick={() => pick(i.emoji)}
                      className="size-8 rounded-md text-[18px] leading-none hover:bg-accent"
                    >
                      {i.emoji}
                    </button>
                  ))}
                </div>
              </section>
            ))}
          </div>
        </div>
      )}
    </>
  );
}
