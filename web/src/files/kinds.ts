// copied from the prototype
export const VIDEO = /\.(mp4|mov|webm|m4v)$/i;
export const AUDIO = /\.(mp3|wav|m4a|ogg)$/i;
export const IMAGE = /\.(png|jpe?g|gif|webp|svg)$/i;
export const MD = /\.(md|markdown)$/i;

export type FileKind = 'md' | 'image' | 'video' | 'audio' | 'text';

export function kindOf(path: string): FileKind {
  if (MD.test(path)) return 'md';
  if (IMAGE.test(path)) return 'image';
  if (VIDEO.test(path)) return 'video';
  if (AUDIO.test(path)) return 'audio';
  return 'text';
}

/** Joins `p` onto `baseDir` ('/'-separated) and folds `.`/`..`. Returns null when it would climb above the root. */
function resolveIn(baseDir: string, p: string): string | null {
  const out: string[] = [];
  for (const seg of `${baseDir}/${p}`.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (!out.length) return null;
      out.pop();
    } else out.push(seg);
  }
  return out.join('/');
}

/**
 * URL of a project file. Relative paths resolve against `baseDir` (project-relative; none = project root).
 * A path that would climb above the root is sent as-is, so the server answers 403. `src`: another source (M3-16).
 */
export function fileUrl(p: string, baseDir?: string, src?: string): string {
  if (/^(https?:|data:|blob:)/.test(p)) return p;
  let path = p;
  try {
    path = decodeURI(p);
  } catch {
    // keep raw
  }
  if (baseDir && !path.startsWith('/')) path = resolveIn(baseDir, path) ?? `${baseDir}/${path}`;
  return `/file?path=${encodeURIComponent(path)}${src && src !== 'here' ? `&src=${encodeURIComponent(src)}` : ''}`;
}

export const isPath = (p: string): boolean =>
  !/^(https?:|~|\/)/.test(p) && !/[\n`<>|*]/.test(p) && (/\//.test(p) || /\.[a-z0-9]{1,5}$/i.test(p));
