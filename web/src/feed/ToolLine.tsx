import { useId, useMemo, useState } from 'react';
import { useT } from '@/i18n/index.ts';
import { selectBusy, useAppDispatch, useAppSelector } from '@/store/store.ts';
import { ARG_KEYS, type FeedItem } from '@/store/feed.ts';
import { selectToolCommentCounts, selectToolOpen, toggleTool, toolSrcId } from './uiSlice.ts';

type Tool = Extract<FeedItem, { kind: 'tool' }>;

/** Rendering cap: the model keeps the full text, the DOM gets this much until the reader asks for the rest. */
const LAZY_CHARS = 20_000;

/**
 * The full input as text: Bash shows the command; otherwise the main argument first, then every field as
 * `key:` + raw text for strings (real newlines) or pretty JSON for other values.
 */
export function inputText(name: string, input: Record<string, unknown>): string {
  if (name === 'Bash' && typeof input.command === 'string') return input.command;
  const main = ARG_KEYS.find((k) => input[k]);
  const keys = Object.keys(input);
  const ordered = main ? [main, ...keys.filter((k) => k !== main)] : keys;
  return ordered
    .map((k) => {
      const v = input[k];
      return typeof v === 'string' ? `${k}:\n${v}` : `${k}:\n${JSON.stringify(v, null, 2)}`;
    })
    .join('\n\n');
}

/** `full`: render it all at once (a commented panel, so an anchor past the cap still resolves, on a jump and for the mark). */
function Clipped({ text, className, full }: { text: string; className: string; full: boolean }) {
  const t = useT();
  const [all, setAll] = useState(false);
  const cut = !all && !full && text.length > LAZY_CHARS;
  return (
    <>
      <pre className={className}>{cut ? text.slice(0, LAZY_CHARS) : text}</pre>
      {cut && (
        <button type="button" data-anchor-skip className="mt-1 text-[11px] underline" onClick={() => setAll(true)}>
          {t('showAll')}
        </button>
      )}
    </>
  );
}

const BOX = 'max-h-[50vh] overflow-auto whitespace-pre-wrap break-words rounded bg-muted/40 p-2 font-mono text-[11.5px] leading-snug';

function Panel({ item, id, full }: { item: Tool; id: string; full: boolean }) {
  const t = useT();
  const busy = useAppSelector(selectBusy);
  // computed only while the panel is open (it is mounted only then), and once per input
  const input = useMemo(() => inputText(item.name, item.input), [item.name, item.input]);
  const failed = item.result?.isError;
  const none = <div data-anchor-skip className="text-[11.5px] italic text-muted-foreground">{t('toolNoOutput')}</div>;
  return (
    // a commentable root (R-M7-18): its anchor text is the command, then the output; labels and hints stay out of it
    <div id={id} data-item-id={toolSrcId(item.id)} data-kind="tool-panel" data-testid="tool-panel" className={'mb-2.5 text-foreground' + (item.sub ? ' pl-5' : '')}>
      {input && (
        <>
          <div data-anchor-skip className="mb-0.5 text-[10.5px] text-muted-foreground">{t('toolInput')}</div>
          <Clipped text={input} className={BOX} full={full} />
        </>
      )}
      <div data-anchor-skip className="mb-0.5 mt-1.5 text-[10.5px] text-muted-foreground">{t('toolOutput')}</div>
      {item.result ? (
        item.result.text ? <Clipped text={item.result.text} className={BOX + (failed ? ' text-destructive' : '')} full={full} /> : none
      ) : busy ? (
        <div data-anchor-skip className="text-[11.5px] italic text-muted-foreground">{t('toolRunning')}</div>
      ) : (
        none
      )}
    </div>
  );
}

/** One action: its line, and below it, while open (state in `feedUi`), the panel. A closed line names its comments. */
export function ToolLine({ item }: { item: Tool }) {
  const t = useT();
  const dispatch = useAppDispatch();
  const open = useAppSelector((s) => selectToolOpen(s, item.id));
  const comments = useAppSelector((s) => selectToolCommentCounts(s)[item.id] ?? 0);
  const panelId = useId();
  return (
    <div data-kind="tool">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        onClick={() => dispatch(toggleTool(item.id))}
        data-anchor-skip
        className={
          'my-2.5 block w-full cursor-pointer truncate rounded-sm text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring font-mono text-[11.5px] leading-normal ' +
          (item.result?.isError ? 'text-destructive' : 'text-muted-foreground') +
          (item.sub ? ' pl-5 opacity-65' : '')
        }
      >
        <span aria-hidden="true">{open ? '▾' : '▸'}</span> {item.name}
        {item.arg ? ` · ${item.arg}` : ''}
        {!open && comments > 0 && <span className="text-nb-accent"> · {t('nComments', comments)}</span>}
      </button>
      {open && <Panel item={item} id={panelId} full={comments > 0} />}
    </div>
  );
}
