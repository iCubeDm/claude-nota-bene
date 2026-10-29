import { useContext, useId, useMemo, useState } from 'react';
import { useT } from '@/i18n/index.ts';
import { selectBusy, useAppDispatch, useAppSelector } from '@/store/store.ts';
import { ARG_KEYS, type FeedItem } from '@/store/feed.ts';
import { collapsedLength, rawIndexOf } from '@/anchors/text.ts';
import { openAgent } from '@/tabs/slice.ts';
import { isAgentTool, selectSubagent } from '@/subagent/slice.ts';
import { selectLiveCalls } from '@/tasks/slice.ts';
import { FeedScope } from './scope.ts';
import { selectToolAnchorEnds, selectToolCommentCounts, selectToolOpen, toggleTool, toolSrcId } from './uiSlice.ts';

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

/** Rendered text past a commented output's furthest anchor, so the quote's suffix context is there too. */
const MARGIN = 2_000;
/**
 * A `pre` showing the first `cap` characters until the reader asks for the rest. What is rendered is always a prefix
 * of the full text, so an anchor inside it keeps its offsets whatever the cap.
 */
function Clipped({ text, className, cap = LAZY_CHARS }: { text: string; className: string; cap?: number }) {
  const t = useT();
  const [all, setAll] = useState(false);
  const cut = !all && text.length > cap;
  return (
    <>
      <pre className={className}>{cut ? text.slice(0, cap) : text}</pre>
      {cut && (
        <button type="button" data-anchor-skip className="mt-1 text-[11px] underline" onClick={() => setAll(true)}>
          {t('showAll')}
        </button>
      )}
    </>
  );
}

const BOX = 'max-h-[50vh] overflow-auto whitespace-pre-wrap break-words rounded bg-muted/40 p-2 font-mono text-[11.5px] leading-snug';

/** `end`: the furthest comment's anchor end in this panel's text (0 = none), so the output renders at least up to it. */
function Panel({ item, id, end }: { item: Tool; id: string; end: number }) {
  const t = useT();
  const mainBusy = useAppSelector(selectBusy);
  const scope = useContext(FeedScope);
  const busy = scope.agent ? !!scope.busy : mainBusy; // a subagent's tab: its own running flag
  // computed only while the panel is open (it is mounted only then), and once per input
  const input = useMemo(() => inputText(item.name, item.input), [item.name, item.input]);
  const failed = item.result?.isError;
  // the command renders in full (it is what is commented most, and the output's offsets start after it); the output is
  // cut past its furthest comment plus a margin, never below the lazy cap
  const out = item.result?.text ?? '';
  const outStart = useMemo(() => { const n = collapsedLength(input); return n ? n + 1 : 0; }, [input]);
  const cap = end > outStart ? Math.max(LAZY_CHARS, rawIndexOf(out, end - outStart) + MARGIN) : LAZY_CHARS;
  const none = <div data-anchor-skip className="text-[11.5px] italic text-muted-foreground">{t('toolNoOutput')}</div>;
  return (
    // a commentable root (R-M7-18): its anchor text is the command, then the output; labels and hints stay out of it
    <div id={id} data-item-id={toolSrcId(item.id)} data-kind="tool-panel" data-testid="tool-panel" className={'mb-2.5 text-foreground' + (item.sub ? ' pl-5' : '')}>
      {input && (
        <>
          <div data-anchor-skip className="mb-0.5 text-[10.5px] text-muted-foreground">{t('toolInput')}</div>
          <Clipped text={input} className={BOX} cap={Infinity} />
        </>
      )}
      <div data-anchor-skip className="mb-0.5 mt-1.5 text-[10.5px] text-muted-foreground">{t('toolOutput')}</div>
      {item.result ? (
        item.result.text ? <Clipped text={out} className={BOX + (failed ? ' text-destructive' : '')} cap={cap} /> : none
      ) : busy ? (
        <div data-anchor-skip className="text-[11.5px] italic text-muted-foreground">{t('toolRunning')}</div>
      ) : (
        none
      )}
    </div>
  );
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

/**
 * The head of a subagent's call (Agent, or Task in older Claude Code): a card with its type, what it was asked, its
 * status and an «open» button for its conversation tab. The chevron still folds the call's own input and output, so
 * both stay commentable like any action's.
 */
function AgentCard({ item, open, panelId, comments, onToggle }: { item: Tool; open: boolean; panelId: string; comments: number; onToggle: () => void }) {
  const t = useT();
  const dispatch = useAppDispatch();
  const scope = useContext(FeedScope);
  const mainBusy = useAppSelector(selectBusy);
  const busy = scope.agent ? !!scope.busy : mainBusy;
  const sub = useAppSelector((s) => selectSubagent(s, item.id));
  // a task of this call is still live: a background agent answers at once ("launched") and goes on
  const live = useAppSelector((s) => selectLiveCalls(s).has(item.id));
  const type = str(item.input.subagent_type) || sub?.type || 'general-purpose';
  const description = str(item.input.description) || sub?.description || '';
  const status = item.result?.isError ? 'error' : live ? 'running' : item.result ? 'done' : busy ? 'running' : 'stopped';
  const color = status === 'error' ? 'text-destructive' : status === 'running' ? 'text-nb-accent' : 'text-muted-foreground';
  return (
    <div
      data-kind="agent-card"
      data-status={status}
      className="my-2.5 flex items-center gap-2 rounded-md border border-border-soft bg-muted/30 py-1 pr-1.5 pl-2 font-mono text-[11.5px] leading-normal"
    >
      <button
        type="button"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        onClick={onToggle}
        data-anchor-skip
        className="min-w-0 flex-1 cursor-pointer truncate rounded-sm text-left text-muted-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring"
      >
        <span aria-hidden="true">{open ? '▾' : '▸'}</span> <span data-agent-type className="text-foreground/80">{type}</span>
        {description ? <span data-agent-desc> · {description}</span> : ''}
        {!open && comments > 0 && <span className="text-nb-accent"> · {t('nComments', comments)}</span>}
      </button>
      <span data-anchor-skip data-agent-status className={color}>{t(status === 'running' ? 'agentRunning' : status === 'error' ? 'agentError' : status === 'stopped' ? 'agentStopped' : 'agentDone')}</span>
      <button
        type="button"
        data-anchor-skip
        data-agent-open
        title={t('agentOpenTip')}
        onClick={() => dispatch(openAgent({ tool: item.id, title: description || type }))}
        className="flex-none cursor-pointer rounded border border-border-soft px-2 py-0.5 text-foreground hover:border-border hover:bg-muted"
      >
        {t('agentOpen')}
      </button>
    </div>
  );
}

/** One action: its line, and below it, while open (state in `feedUi`), the panel. A closed line names its comments. */
export function ToolLine({ item }: { item: Tool }) {
  const t = useT();
  const dispatch = useAppDispatch();
  const open = useAppSelector((s) => selectToolOpen(s, item.id));
  const comments = useAppSelector((s) => selectToolCommentCounts(s)[item.id] ?? 0);
  const end = useAppSelector((s) => selectToolAnchorEnds(s)[item.id] ?? 0);
  const panelId = useId();
  if (isAgentTool(item.name)) {
    return (
      <div data-kind="tool">
        <AgentCard item={item} open={open} panelId={panelId} comments={comments} onToggle={() => dispatch(toggleTool(item.id))} />
        {open && <Panel item={item} id={panelId} end={end} />}
      </div>
    );
  }
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
      {open && <Panel item={item} id={panelId} end={end} />}
    </div>
  );
}
