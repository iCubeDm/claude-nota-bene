import type { Comment, QuickLabelId } from '@nota-bene/shared';
import { t, tIn, type Lang } from '../i18n/index.ts';
import type { ru } from '../i18n/ru.ts';

export interface QuickLabel { id: QuickLabelId; emoji: string; /** sent to the agent, always English */ instruction?: string }

/** In display order. Source: Plannotator's built-in quick labels. */
export const QUICK_LABELS: QuickLabel[] = [
  { id: 'looks-good', emoji: '👍' },
  // the user's own: not just good, a pleasant surprise they had not thought of
  { id: 'fire', emoji: '🔥', instruction: 'I really like this and had not thought of it myself. Ideas like this are welcome.' },
  { id: 'clarify', emoji: '❓' },
  { id: 'verify', emoji: '🔍', instruction: 'This seems like an assumption. Verify by reading the actual code before proceeding.' },
  { id: 'example', emoji: '🔬', instruction: 'This is too abstract. Show a before/after, a sample input/output, or a specific scenario so I can see how this actually works.' },
  { id: 'overview', emoji: '🗺️', instruction: 'Provide a narrative overview of what is being built, why it is being built, and how it will be built. Add this before the implementation details.' },
  { id: 'patterns', emoji: '🧬', instruction: 'Search the codebase for existing patterns, components, or utilities that already solve this. Reuse what exists rather than introducing a new approach.' },
  { id: 'alternatives', emoji: '🔄', instruction: 'Propose 2-3 alternative approaches with trade-offs based on the actual codebase.' },
  { id: 'no-regression', emoji: '📉', instruction: 'Verify that this change will not break existing behavior. Identify what could regress and how to protect against it.' },
  { id: 'out-of-scope', emoji: '🚫', instruction: 'This is not part of the current task. Remove it and stay focused on what was actually requested.' },
  { id: 'needs-tests', emoji: '🧪' },
];

/** a label an older server does not know (it would refuse the comment): offered from this protocol on */
const SINCE: Partial<Record<QuickLabelId, number>> = { fire: 3 };
/** The labels the connected server accepts. */
export const labelsFor = (protocol: number): QuickLabel[] => QUICK_LABELS.filter((l) => protocol >= (SINCE[l.id] ?? 0));

const byId = new Map(QUICK_LABELS.map((l) => [l.id, l]));
const keyOf = (id: QuickLabelId) => `label_${id}` as keyof typeof ru;

/** The label text in the UI language, or in `lang` when given (a sent batch must not follow the UI language). */
export function labelText(id: QuickLabelId, lang?: Lang): string {
  return lang ? tIn(lang, keyOf(id)) : t(keyOf(id));
}

/** `👍 Looks good`, or '' when the comment has no quick label. Matches composeBatch's `labelOf`. */
export function labelOf(c: Pick<Comment, 'label'>, lang?: Lang): string {
  const l = c.label && byId.get(c.label);
  return l ? `${l.emoji} ${labelText(l.id, lang)}` : '';
}

export function instructionOf(c: Pick<Comment, 'label'>): string | undefined {
  return c.label ? byId.get(c.label)?.instruction : undefined;
}
