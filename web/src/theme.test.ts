import { expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// jsdom computes no layout: the content widths are checked in e2e/files.spec.ts, on real layout
const css = readFileSync(resolve(__dirname, 'theme.css'), 'utf8');
const rule = (sel: string) => new RegExp(`${sel.replace(/[.:()[\]]/g, '\\$&')}\\s*\\{([^}]*)\\}`).exec(css)?.[1] ?? '';

it('media fits the pane and the natural size lifts the limits', () => {
  expect(rule('.nb-fit')).toMatch(/max-width: 100%;.*max-height: calc\(100% - 2rem\);.*object-fit: contain/s);
  expect(rule('.nb-media-pane.nb-natural .nb-fit')).toContain('max-width: none');
});
