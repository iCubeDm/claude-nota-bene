import { fileUrl } from '@/files/kinds.ts';

/**
 * Where a resource named inside a .gltf (a .bin, a texture) is fetched from: our /file route, relative to the model's
 * directory and with the model's `src`. `data:` and `blob:` (three makes blob: urls for textures embedded in a .glb)
 * stay as they are. Anything that would reach another host (`http(s):`, `//host`) is refused (null): a model must not
 * make the browser call out. A path that climbs above the root is sent as-is, the server answers 403.
 */
export function resolveModelUrl(uri: string, baseDir: string | undefined, src?: string): string | null {
  if (/^(data|blob):/i.test(uri)) return uri;
  if (/^(https?:)?\/\//i.test(uri)) return null;
  return fileUrl(uri, baseDir, src);
}
