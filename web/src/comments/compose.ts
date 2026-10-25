import type { Comment } from '@nota-bene/shared';
import { tIn, type Lang } from '../i18n/index.ts';

/**
 * The text sent to the agent: the general message, then the numbered comment list (prototype format).
 * Pure: everything that depends on app state arrives as an argument.
 * @param labelOf quick-label emoji + text for a comment, '' when it has none
 * @param whereOf where the quoted fragment lives ("reply #2", "my message")
 * @param instructionOf the quick label's instruction line, if any
 */
export function composeBatch(
  general: string,
  items: Comment[],
  lang: Lang,
  labelOf: (c: Comment) => string,
  whereOf: (c: Comment) => string,
  instructionOf: (c: Comment) => string | undefined,
): string {
  if (!items.length) return general;
  const blocks = items.map((c, i) => {
    const quote = c.anchor.quote.split('\n').map((l) => '> ' + l).join('\n');
    const body = [labelOf(c), c.text.trim()].filter(Boolean).join(' ');
    const instr = instructionOf(c);
    return `${i + 1}. [${whereOf(c)}]\n${quote}\n→ ${body}${instr ? `\n   ${instr}` : ''}`;
  });
  return `${general ? general + '\n\n' : ''}${tIn(lang, 'batchHead')}\n\n${blocks.join('\n\n')}`;
}
