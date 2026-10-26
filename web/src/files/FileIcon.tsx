import type { ReactNode } from 'react';
import { AUDIO, IMAGE, VIDEO } from './kinds.ts';

/**
 * File-type icons (M6-11), after IntelliJ's new UI: a coloured letter mark for source and config files, a coloured
 * glyph for media, folders and a few well-known names. Built in (inline SVG, no dependency); the colours are picked to
 * read on the dark theme.
 */
export type IconId =
  | 'ts' | 'js' | 'json' | 'md' | 'css' | 'html' | 'py' | 'sh' | 'yml' | 'toml'
  | 'image' | 'video' | 'audio' | 'npm' | 'readme' | 'git' | 'docker' | 'dir' | 'dirOpen' | 'file';

type Mark = { text: string; color: string } | { glyph: ReactNode; color: string };

const C = {
  blue: 'oklch(0.70 0.14 250)',
  yellow: 'oklch(0.82 0.15 90)',
  orange: 'oklch(0.72 0.16 50)',
  red: 'oklch(0.66 0.19 25)',
  purple: 'oklch(0.70 0.15 300)',
  green: 'oklch(0.72 0.14 150)',
  teal: 'oklch(0.74 0.11 200)',
  folder: 'oklch(0.72 0.05 250)',
  plain: 'currentColor',
};

const MARKS: Record<IconId, Mark> = {
  ts: { text: 'TS', color: C.blue },
  js: { text: 'JS', color: C.yellow },
  json: { text: '{}', color: C.orange },
  md: { text: 'M↓', color: C.teal },
  css: { text: '#', color: C.purple },
  html: { text: '<>', color: C.orange },
  py: { text: 'Py', color: C.blue },
  sh: { text: '>_', color: C.green },
  yml: { text: 'Y', color: C.red },
  toml: { text: 'T', color: C.purple },
  image: { glyph: <><rect x="3" y="4" width="18" height="16" rx="2" /><circle cx="9" cy="10" r="2" /><path d="m21 16-5-5-9 9" /></>, color: C.green },
  video: { glyph: <><rect x="3" y="5" width="18" height="14" rx="2" /><path d="m10 9 5 3-5 3z" /></>, color: C.purple },
  audio: { glyph: <><path d="M9 18V5l12-2v13" /><circle cx="6" cy="18" r="3" /><circle cx="18" cy="16" r="3" /></>, color: C.orange },
  npm: { glyph: <><path d="M12 2 3 7v10l9 5 9-5V7z" /><path d="m3 7 9 5 9-5M12 12v10" /></>, color: C.red },
  readme: { glyph: <><circle cx="12" cy="12" r="9" /><path d="M12 11v6M12 7.5v.5" /></>, color: C.blue },
  git: { glyph: <><circle cx="6" cy="6" r="2.5" /><circle cx="6" cy="18" r="2.5" /><circle cx="18" cy="9" r="2.5" /><path d="M6 8.5v7M18 11.5c0 4-6 3-11 5" /></>, color: C.orange },
  docker: { glyph: <><path d="M3 12h16c1 0 2-1 2.5-2M3 12c0 5 4 8 9 8 5 0 8-3 9-8" /><path d="M6 12V9h3v3M9 12V9h3v3M12 12V9h3v3M9 9V6h3v3" /></>, color: C.blue },
  dir: { glyph: <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />, color: C.folder },
  dirOpen: { glyph: <path d="M3 17V7a2 2 0 0 1 2-2h4l2 2h6a2 2 0 0 1 2 2v1M3 17l2.6-6.2A1.5 1.5 0 0 1 7 10h13a1 1 0 0 1 .9 1.4L18.5 18a1.5 1.5 0 0 1-1.4 1H5a2 2 0 0 1-2-2z" />, color: C.folder },
  file: { glyph: <><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" /><path d="M14 3v5h5" /></>, color: C.plain },
};

const BY_EXT: Record<string, IconId> = {
  ts: 'ts', tsx: 'ts', mts: 'ts', cts: 'ts',
  js: 'js', jsx: 'js', mjs: 'js', cjs: 'js',
  json: 'json', jsonc: 'json', jsonl: 'json',
  md: 'md', markdown: 'md',
  css: 'css', scss: 'css',
  html: 'html', htm: 'html',
  py: 'py',
  sh: 'sh', bash: 'sh', zsh: 'sh',
  yml: 'yml', yaml: 'yml',
  toml: 'toml',
};

/** The icon of a file, by its well-known name first, then its extension. */
export function iconOf(path: string): IconId {
  const name = (path.split('/').pop() ?? path).toLowerCase();
  if (name === 'package.json' || name === 'package-lock.json') return 'npm';
  if (/^readme(\.|$)/.test(name)) return 'readme';
  if (name === '.gitignore' || name === '.gitattributes' || name === '.gitmodules') return 'git';
  if (name === 'dockerfile' || name.startsWith('dockerfile.') || name.endsWith('.dockerfile') || name === '.dockerignore') return 'docker';
  if (IMAGE.test(name)) return 'image';
  if (VIDEO.test(name)) return 'video';
  if (AUDIO.test(name)) return 'audio';
  const dot = name.lastIndexOf('.');
  return (dot > 0 && BY_EXT[name.slice(dot + 1)]) || 'file';
}

/**
 * `dir`: a folder, `open` or closed. A letter mark is CSS generated content (`.nb-icon-label`), never DOM text: a row's
 * text, a selection and a copy stay the file name alone.
 */
export function FileIcon({ path, dir = false, open = false, size = 14 }: { path?: string; dir?: boolean; open?: boolean; size?: number }) {
  const id: IconId = dir ? (open ? 'dirOpen' : 'dir') : iconOf(path ?? '');
  const m = MARKS[id];
  if ('text' in m) {
    return (
      <span aria-hidden data-icon={id} data-label={m.text} className="nb-icon-label"
        style={{ width: size, height: size, color: m.color, fontSize: size * (m.text.length > 1 ? 0.6 : 0.8) }} />
    );
  }
  return (
    <svg aria-hidden data-icon={id} viewBox="0 0 24 24" width={size} height={size} className="flex-none" style={{ color: m.color }}
      fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      {m.glyph}
    </svg>
  );
}
