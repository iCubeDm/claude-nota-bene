import { cleanup, render } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { FileIcon, iconOf } from './FileIcon.tsx';

afterEach(cleanup);

it('maps the plan\'s extensions, media and well-known names (M6-11)', () => {
  const cases: [string, string][] = [
    ['src/a.ts', 'ts'], ['b.tsx', 'ts'], ['c.js', 'js'], ['bin/x.mjs', 'js'], ['tsconfig.json', 'json'],
    ['docs/A.MD', 'md'], ['theme.css', 'css'], ['index.html', 'html'], ['tool.py', 'py'], ['run.sh', 'sh'],
    ['ci.yml', 'yml'], ['ci.yaml', 'yml'], ['Cargo.toml', 'toml'],
    ['scene_v6.png', 'image'], ['a.JPG', 'image'], ['icon.svg', 'image'], ['clip_вход.mp4', 'video'], ['x.mov', 'video'], ['v.mp3', 'audio'], ['m/robot.glb', 'model'], ['scene.GLTF', 'model'],
    ['web/package.json', 'npm'], ['README.md', 'readme'], ['readme', 'readme'], ['.gitignore', 'git'], ['Dockerfile', 'docker'], ['dockerfile.dev', 'docker'],
    ['LICENSE', 'file'], ['.env', 'file'], ['notes.txt', 'file'], ['archive.tar.gz', 'file'],
  ];
  for (const [p, id] of cases) expect([p, iconOf(p)]).toEqual([p, id]);
});

it('a folder is closed or open; a letter mark is text, a glyph is strokes', () => {
  const { container } = render(<><FileIcon dir /><FileIcon dir open /><FileIcon path="a.ts" /><FileIcon path="a.png" /></>);
  const icons = [...container.querySelectorAll<HTMLElement | SVGElement>('[data-icon]')];
  expect(icons.map((s) => s.dataset.icon)).toEqual(['dir', 'dirOpen', 'ts', 'image']);
  // the letters are generated content: no DOM text, so a row's text and a copy are the name alone
  expect(icons[2]!.dataset.label).toBe('TS');
  expect(container.textContent).toBe('');
  expect(icons[3]!.tagName.toLowerCase()).toBe('svg');
  expect(icons.every((s) => s.getAttribute('aria-hidden') !== null)).toBe(true);
});
