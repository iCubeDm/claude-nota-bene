import { useSyncExternalStore } from 'react';

// copied from the prototype
export const VIDEO = /\.(mp4|mov|webm|m4v)$/i;
export const AUDIO = /\.(mp3|wav|m4a|ogg)$/i;
export const IMAGE = /\.(png|jpe?g|gif|webp|svg)$/i;
export const MODEL = /\.(glb|gltf|blend)$/i;
export const BLEND = /\.blend$/i;
export const MD = /\.(md|markdown)$/i;

export type FileKind = 'md' | 'image' | 'video' | 'audio' | 'model' | 'text';

/**
 * Experimental 3D (server env NOTA_BENE_EXPERIMENTAL_3D=1, announced in `hello.capabilities.model3d`). Off, a model
 * file is any other unsupported binary: kind `text`, the generic icon, and the three chunks are never fetched. Off until
 * the hello says otherwise, so nothing 3D loads on a guess. Module state (not redux) because kindOf/iconOf are pure
 * helpers called from many places; a component that calls them re-renders on a change through `useModel3d`.
 */
let model3d = false;
const model3dListeners = new Set<() => void>();
export function setModel3d(on: boolean): void {
  if (on === model3d) return;
  model3d = on;
  for (const fn of model3dListeners) fn();
}
export const isModel3d = (): boolean => model3d;
export function useModel3d(): boolean {
  return useSyncExternalStore((fn) => { model3dListeners.add(fn); return () => model3dListeners.delete(fn); }, isModel3d);
}
/** A model file (.glb .gltf .blend) AND the viewer is on. */
export const isModelFile = (path: string): boolean => model3d && MODEL.test(path);

export function kindOf(path: string): FileKind {
  if (MD.test(path)) return 'md';
  if (IMAGE.test(path)) return 'image';
  if (VIDEO.test(path)) return 'video';
  if (AUDIO.test(path)) return 'audio';
  if (isModelFile(path)) return 'model';
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

/** Where a model's bytes come from: a .blend is converted to GLB by the server's Blender (`/model`), the rest are files. */
export function modelUrl(p: string, src?: string): string {
  if (!BLEND.test(p)) return fileUrl(p, undefined, src);
  return `/model?path=${encodeURIComponent(p)}${src && src !== 'here' ? `&src=${encodeURIComponent(src)}` : ''}`;
}
