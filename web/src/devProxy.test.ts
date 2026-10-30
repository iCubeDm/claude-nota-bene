import { expect, it } from 'vitest';

// every path the app fetches from the server must go through the dev proxy, or `npm run dev` 404s on it
// (read as text: importing vite.config.ts under jsdom fails on its file: URL)
const sources = import.meta.glob(['./**/*.{ts,tsx}', '!./**/*.test.{ts,tsx}'], { query: '?raw', import: 'default', eager: true }) as Record<string, string>;
const viteConfig = Object.values(import.meta.glob('../vite.config.ts', { query: '?raw', import: 'default', eager: true }) as Record<string, string>)[0]!;

it('the Vite dev proxy covers every server path the app fetches', () => {
  const fetched = new Set<string>();
  for (const src of Object.values(sources)) for (const m of src.matchAll(/[fF]etch\(\s*[`'"](\/[a-z-]+)/g)) fetched.add(m[1]!);
  expect(fetched.has('/marks')).toBe(true); // the scan itself works
  const list = /\[([^\]]*)\]\.map\(\(p\) => \[p, backend\]\)/.exec(viteConfig)?.[1] ?? '';
  const proxied = [...list.matchAll(/'(\/[a-z-]+)'/g)].map((m) => m[1]!);
  expect(proxied).toContain('/info'); // the parse itself works
  expect([...fetched].filter((p) => !proxied.includes(p)).sort()).toEqual([]);
});
