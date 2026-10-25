import { beforeAll, expect, it } from 'vitest';
import { QUICK_LABEL_IDS } from '@nota-bene/shared';
import { QUICK_LABELS, labelOf, labelText } from './labels.ts';
import { emojiGroups, loadEmoji, searchShortcodes } from './emoji.ts';
import { ru } from '../i18n/ru.ts';
import { en } from '../i18n/en.ts';

beforeAll(async () => { await loadEmoji(); });

it('ten labels with the exact instructions', () => {
  expect(QUICK_LABELS.map((l) => l.id)).toEqual([...QUICK_LABEL_IDS]);
  expect(QUICK_LABELS).toEqual([
    { id: 'looks-good', emoji: '👍' },
    { id: 'clarify', emoji: '❓' },
    { id: 'verify', emoji: '🔍', instruction: 'This seems like an assumption. Verify by reading the actual code before proceeding.' },
    { id: 'example', emoji: '🔬', instruction: 'This is too abstract. Show a before/after, a sample input/output, or a specific scenario so I can see how this actually works.' },
    { id: 'overview', emoji: '🗺️', instruction: 'Provide a narrative overview of what is being built, why it is being built, and how it will be built. Add this before the implementation details.' },
    { id: 'patterns', emoji: '🧬', instruction: 'Search the codebase for existing patterns, components, or utilities that already solve this. Reuse what exists rather than introducing a new approach.' },
    { id: 'alternatives', emoji: '🔄', instruction: 'Propose 2-3 alternative approaches with trade-offs based on the actual codebase.' },
    { id: 'no-regression', emoji: '📉', instruction: 'Verify that this change will not break existing behavior. Identify what could regress and how to protect against it.' },
    { id: 'out-of-scope', emoji: '🚫', instruction: 'This is not part of the current task. Remove it and stay focused on what was actually requested.' },
    { id: 'needs-tests', emoji: '🧪' },
  ]);
});

it('every label text exists in ru and en', () => {
  for (const id of QUICK_LABEL_IDS) {
    const key = `label_${id}` as keyof typeof ru;
    expect(typeof ru[key], id).toBe('string');
    expect(typeof en[key], id).toBe('string');
    expect(labelText(id)).not.toBe('');
  }
  expect(labelOf({ label: 'verify' } as never)).toMatch(/^🔍 /);
  expect(labelOf({} as never)).toBe('');
});

it('searchShortcodes finds +1 first as thumbs up', () => {
  expect(searchShortcodes('+1')[0].emoji).toBe('👍');
  expect(searchShortcodes('-1')[0].emoji).toBe('👎');
});

it('searchShortcodes: prefix first (shorter first), then substring, case-insensitive', () => {
  const r = searchShortcodes('thu');
  expect(r.map((x) => x.code)).toContain('thumbsup');
  expect(searchShortcodes('THUMBSUP')[0].code).toBe('thumbsup');
  const codes = searchShortcodes('up', 500).map((x) => x.code);
  const firstSub = codes.findIndex((c) => !c.startsWith('up'));
  expect(codes.slice(0, firstSub).every((c) => c.startsWith('up'))).toBe(true);
  expect(searchShortcodes('thu', 3)).toHaveLength(3);
  expect(searchShortcodes('')).toEqual([]);
});

it('emojiGroups has the standard groups', () => {
  const g = emojiGroups();
  expect(g.map((x) => x.group)).toEqual(['smileys-emotion', 'people-body', 'animals-nature', 'food-drink',
    'travel-places', 'activities', 'objects', 'symbols', 'flags']);
  expect(g[0].items[0]).toMatchObject({ emoji: expect.any(String), label: expect.any(String), code: expect.any(String) });
});
