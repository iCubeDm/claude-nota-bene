import { isMediaAnchor, type Comment } from '@nota-bene/shared';
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
  /** refs[i] = the global numbers of comment i's images; adds the `imgRef` line under that comment */
  refs: number[][] = [],
): string {
  if (!items.length) return general;
  const blocks = items.map((c, i) => {
    // placeholder: a media comment carries no quote yet (its batch text arrives with media handling)
    const quote = isMediaAnchor(c.anchor) ? '' : c.anchor.quote.split('\n').map((l) => '> ' + l).join('\n');
    const body = [labelOf(c), c.text.trim()].filter(Boolean).join(' ');
    const instr = instructionOf(c);
    return `${i + 1}. [${whereOf(c)}]\n${quote}\n→ ${body}${instr ? `\n   ${instr}` : ''}${refs[i]?.length ? '\n' + tIn(lang, 'imgRef', refs[i]) : ''}`;
  });
  return `${general ? general + '\n\n' : ''}${tIn(lang, 'batchHead')}\n\n${blocks.join('\n\n')}`;
}
