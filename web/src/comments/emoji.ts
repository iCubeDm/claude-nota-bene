// emojibase-data is ~600 KB of JSON: load it with a dynamic import so it lands in its own chunk.
// Everything returns [] until loadEmoji() has resolved.

interface Raw { hexcode: string; label: string; unicode: string; group?: number }
type Item = { emoji: string; label: string; code: string };

// emojibase group number -> name (en/messages.json "groups"). 2 = "component" (skin-tone swatches, hair
// styles): excluded. Regional indicators have no group at all, so they are skipped too; country flags
// (group 9) are kept.
const GROUPS: Record<number, string> = {
  0: 'smileys-emotion', 1: 'people-body', 3: 'animals-nature', 4: 'food-drink', 5: 'travel-places',
  6: 'activities', 7: 'objects', 8: 'symbols', 9: 'flags',
};

let index: { code: string; emoji: string }[] = [];
let groups: { group: string; items: Item[] }[] = [];
let loading: Promise<void> | undefined;

export function loadEmoji(): Promise<void> {
  loading ??= Promise.all([
    import('emojibase-data/en/compact.json'),
    import('emojibase-data/en/shortcodes/github.json'),
  ]).then(([c, s]) => {
    const compact = c.default as unknown as Raw[];
    const codes = s.default as unknown as Record<string, string | string[]>;
    const by = new Map<number, Item[]>();
    const idx: { code: string; emoji: string }[] = [];
    // Skin-tone variants are nested in `skins` and never visited, so they appear neither in search nor in groups.
    for (const e of compact) {
      if (e.group === undefined || !(e.group in GROUPS)) continue;
      const raw = codes[e.hexcode];
      const list = raw === undefined ? [] : Array.isArray(raw) ? raw : [raw];
      for (const code of list) idx.push({ code, emoji: e.unicode });
      let arr = by.get(e.group);
      if (!arr) by.set(e.group, (arr = []));
      arr.push({ emoji: e.unicode, label: e.label, code: list[0] ?? '' });
    }
    index = idx;
    groups = Object.keys(GROUPS).map(Number).map((g) => ({ group: GROUPS[g], items: by.get(g) ?? [] }));
  }).catch((err) => { loading = undefined; throw err; });
  return loading;
}

/** GitHub shortcodes: prefix matches first (shorter code first), then substring. Case-insensitive. */
export function searchShortcodes(q: string, limit = 8): { code: string; emoji: string }[] {
  const needle = q.toLowerCase();
  if (!needle) return [];
  const prefix: typeof index = [];
  const inner: typeof index = [];
  for (const e of index) {
    const c = e.code.toLowerCase();
    if (c.startsWith(needle)) prefix.push(e);
    else if (c.includes(needle)) inner.push(e);
  }
  prefix.sort((a, b) => a.code.length - b.code.length);
  return [...prefix, ...inner].slice(0, limit);
}

export function emojiGroups(): { group: string; items: Item[] }[] {
  return groups;
}
