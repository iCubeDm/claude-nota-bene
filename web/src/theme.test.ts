import { expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// jsdom computes no layout: the R-M6-2 widths are asserted on the CSS text (the real widths are checked in e2e/files.spec.ts)
const css = readFileSync(resolve(__dirname, 'theme.css'), 'utf8');
const rule = (sel: string) => new RegExp(`${sel.replace(/[.:()[\]]/g, '\\$&')}\\s*\\{([^}]*)\\}`).exec(css)?.[1] ?? '';

it('prose and code widths are viewport-relative', () => {
  expect(rule('.nb-prose')).toContain('width: min(100%, clamp(860px, 62vw, 1280px))');
  expect(rule('.nb-code')).toContain('width: min(100%, clamp(960px, 78vw, 1600px))');
});

it('media fits the pane and the natural size lifts the limits', () => {
  expect(rule('.nb-fit')).toMatch(/max-width: 100%;.*max-height: calc\(100% - 2rem\);.*object-fit: contain/s);
  expect(rule('.nb-media-pane.nb-natural .nb-fit')).toContain('max-width: none');
});

it('the grid background stays on .grid-pane', () => {
  expect(rule('.grid-pane')).toContain('linear-gradient');
});
