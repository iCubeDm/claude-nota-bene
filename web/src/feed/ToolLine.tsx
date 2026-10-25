import { useId, useMemo, useState } from 'react';
import { useT } from '@/i18n/index.ts';
import { selectBusy, useAppSelector } from '@/store/store.ts';
import { ARG_KEYS, type FeedItem } from '@/store/feed.ts';

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

function Clipped({ text, className }: { text: string; className: string }) {
  const t = useT();
  const [all, setAll] = useState(false);
  const cut = !all && text.length > LAZY_CHARS;
  return (
    <>
      <pre className={className}>{cut ? text.slice(0, LAZY_CHARS) : text}</pre>
      {cut && (
        <button type="button" className="mt-1 text-[11px] underline" onClick={() => setAll(true)}>
          {t('showAll')}
        </button>
      )}
    </>
  );
}

const BOX = 'max-h-[50vh] overflow-auto whitespace-pre-wrap break-words rounded bg-muted/40 p-2 font-mono text-[11.5px] leading-snug';

function Panel({ item, id }: { item: Tool; id: string }) {
  const t = useT();
  const busy = useAppSelector(selectBusy);
  // computed only while the panel is open (it is mounted only then), and once per input
  const input = useMemo(() => inputText(item.name, item.input), [item.name, item.input]);
  const failed = item.result?.isError;
  const none = <div className="text-[11.5px] italic text-muted-foreground">{t('toolNoOutput')}</div>;
  return (
    // tool output is not commentable in M1 and must not shift the message anchors
    <div id={id} data-anchor-skip data-testid="tool-panel" className={'mb-2.5 text-foreground' + (item.sub ? ' pl-5' : '')}>
      {input && (
        <>
          <div className="mb-0.5 text-[10.5px] text-muted-foreground">{t('toolInput')}</div>
          <Clipped text={input} className={BOX} />
        </>
      )}
      <div className="mb-0.5 mt-1.5 text-[10.5px] text-muted-foreground">{t('toolOutput')}</div>
      {item.result ? (
        item.result.text ? <Clipped text={item.result.text} className={BOX + (failed ? ' text-destructive' : '')} /> : none
      ) : busy ? (
        <div className="text-[11.5px] italic text-muted-foreground">{t('toolRunning')}</div>
      ) : (
        none
      )}
    </div>
  );
}

export function ToolLine({ item }: { item: Tool }) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  return (
    <div data-kind="tool">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        onClick={() => setOpen((o) => !o)}
        className={
          'my-2.5 block w-full cursor-pointer truncate rounded-sm text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring font-mono text-[11.5px] leading-normal ' +
          (item.result?.isError ? 'text-destructive' : 'text-muted-foreground') +
          (item.sub ? ' pl-5 opacity-65' : '')
        }
      >
        <span aria-hidden="true">{open ? '▾' : '▸'}</span> {item.name}
        {item.arg ? ` · ${item.arg}` : ''}
      </button>
      {open && <Panel item={item} id={panelId} />}
    </div>
  );
}
