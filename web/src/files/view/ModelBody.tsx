import { useEffect, useRef, useState } from 'react';
import { useT } from '@/i18n/index.ts';
import type { CameraPose, ModelStats, ModelViewer, ViewerModule } from '@/model/api.ts';
import { registerModelViewer, unregisterModelViewer } from '@/model/registry.ts';
import { resolveModelUrl } from '@/model/resolve.ts';
import { fileUrl } from '../kinds.ts';

/** Above this a model is not fetched at all: the whole file lives in memory twice (bytes, then the parsed scene). */
export const MODEL_MAX_BYTES = 256 * 1024 * 1024;

type Status =
  | { s: 'loading'; pct: number | null }
  | { s: 'ready'; size: number; stats: ModelStats }
  | { s: 'tooBig'; size: number }
  | { s: 'gone' }
  | { s: 'lost' }
  | { s: 'error'; message: string };

export function fmtSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

// the whole 3D module (three and its loaders) is one lazy chunk, fetched when the first model tab is shown
let viewerP: Promise<ViewerModule> | undefined;
function loadViewerModule(): Promise<ViewerModule> {
  viewerP ??= import('@/model/viewer.ts');
  // a failed chunk load must not stick for the page's lifetime: the next model tab tries again
  viewerP.catch(() => { viewerP = undefined; });
  return viewerP;
}

class Gone extends Error {}
class TooBig extends Error {
  size: number;
  constructor(size: number) { super('too big'); this.size = size; }
}

/** The file as bytes, with progress. The size is known from the headers before any body is read. */
async function fetchModel(url: string, signal: AbortSignal, onProgress: (pct: number | null) => void): Promise<{ bytes: ArrayBuffer; etag: string | null }> {
  const res = await fetch(url, { signal });
  if (res.status === 404) throw new Gone();
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`.trim());
  const total = Number(res.headers.get('content-length') ?? 0);
  if (total > MODEL_MAX_BYTES) {
    void res.body?.cancel();
    throw new TooBig(total);
  }
  const etag = res.headers.get('etag');
  if (!res.body) return { bytes: await res.arrayBuffer(), etag };
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let got = 0;
  let last = -1;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    got += value.length;
    if (got > MODEL_MAX_BYTES) {
      void reader.cancel();
      throw new TooBig(got);
    }
    const pct = total > 0 ? Math.min(100, Math.floor((got / total) * 100)) : null;
    if (pct !== last) onProgress((last = pct as number));
  }
  const out = new Uint8Array(got);
  let at = 0;
  for (const c of chunks) { out.set(c, at); at += c.length; }
  return { bytes: out.buffer, etag };
}

/** The css colour behind the pane, read again when the app's theme changes (class / style on <html>, or the OS scheme). */
function useBackground(el: React.RefObject<HTMLElement | null>, onChange: (css: string) => void) {
  const cb = useRef(onChange);
  cb.current = onChange;
  useEffect(() => {
    const read = () => { if (el.current) cb.current(getComputedStyle(el.current).backgroundColor); };
    const mo = new MutationObserver(read);
    mo.observe(document.documentElement, { attributes: true });
    const mq = window.matchMedia?.('(prefers-color-scheme: dark)');
    mq?.addEventListener('change', read);
    return () => { mo.disconnect(); mq?.removeEventListener('change', read); };
  }, [el]);
}

/**
 * The pane of a .glb / .gltf: a view-only 3D viewer (orbit, zoom), with reset view, animation clips and an info line.
 * All the 3D code is in the lazy `@/model/viewer.ts`; this component fetches the bytes (size cap, progress), owns the
 * states and the viewer's lifetime. Nothing is created or fetched until the tab is first shown. `reloadKey`: ↻ / a
 * finished turn; a reload keeps the camera.
 */
export function ModelBody({ path, src, tabId, active, reloadKey }: { path: string; src: string; tabId: string; active: boolean; reloadKey: number }) {
  const t = useT();
  const pane = useRef<HTMLDivElement>(null);
  const host = useRef<HTMLDivElement>(null);
  const [started, setStarted] = useState(active);
  if (active && !started) setStarted(true);
  const [viewer, setViewer] = useState<ModelViewer | null>(null);
  const [status, setStatus] = useState<Status>({ s: 'loading', pct: null });
  const [clip, setClip] = useState(0);
  const [playing, setPlaying] = useState(false);
  const bgRef = useRef<string>('');

  // the viewer: made on first show, disposed on close (or when the file is another one)
  useEffect(() => {
    if (!started || !host.current) return;
    let dead = false;
    let v: ModelViewer | undefined;
    loadViewerModule().then((m) => {
      if (dead || !host.current) return;
      const background = getComputedStyle(host.current).backgroundColor;
      bgRef.current = background;
      v = m.createViewer(host.current, {
        background,
        onContextLost: () => !dead && setStatus({ s: 'lost' }),
        onView: (p: CameraPose) => { if (pane.current) pane.current.dataset.modelCamera = [...p.position, ...p.target].map((x) => x.toFixed(3)).join(' '); },
      });
      registerModelViewer(tabId, v);
      setViewer(v);
    }, (e: unknown) => !dead && setStatus({ s: 'error', message: e instanceof Error ? e.message : String(e) }));
    return () => {
      dead = true;
      if (v) {
        unregisterModelViewer(tabId, v);
        v.dispose();
      }
      setViewer(null);
    };
  }, [started, tabId, path, src]);

  useBackground(host, (css) => { if (css !== bgRef.current) { bgRef.current = css; viewer?.setBackground(css); } });
  useEffect(() => void viewer?.setVisible(active), [viewer, active]);

  // load: when the viewer exists and the tab is shown, once per (file, reloadKey); an interrupted load runs again
  const loaded = useRef<string | null>(null);
  const hadModel = useRef(false);
  const lastEtag = useRef<string | null>(null);
  useEffect(() => {
    if (!viewer || !active) return;
    const key = `${path}\0${src}\0${reloadKey}`;
    if (loaded.current === key) return;
    const ac = new AbortController();
    const slash = path.lastIndexOf('/');
    const baseDir = slash > 0 ? path.slice(0, slash) : undefined;
    const fail = (e: unknown) => {
      if (ac.signal.aborted) return;
      loaded.current = key;
      viewer.clear();
      hadModel.current = false;
      lastEtag.current = null;
      if (e instanceof Gone) setStatus({ s: 'gone' });
      else if (e instanceof TooBig) setStatus({ s: 'tooBig', size: e.size });
      else setStatus({ s: 'error', message: e instanceof Error ? e.message : String(e) });
    };
    // a reload of a model on screen keeps showing it (no flash of "loading") until the new bytes are in
    if (!hadModel.current) setStatus({ s: 'loading', pct: null });
    void (async () => {
      try {
        const { bytes, etag } = await fetchModel(fileUrl(path, undefined, src), ac.signal, (pct) => !ac.signal.aborted && !hadModel.current && setStatus({ s: 'loading', pct }));
        if (ac.signal.aborted) return;
        // a finished turn reloads every open file: the same file (same ETag) is not parsed again
        if (hadModel.current && etag && etag === lastEtag.current) {
          loaded.current = key;
          return;
        }
        lastEtag.current = etag;
        viewer.clear();
        const keepView = hadModel.current;
        const stats = await viewer.load(bytes, { resolve: (uri) => resolveModelUrl(uri, baseDir, src), keepView });
        if (ac.signal.aborted) return;
        loaded.current = key;
        hadModel.current = true;
        setClip(0);
        setPlaying(false);
        if (stats.clips.length) viewer.setClip(0);
        setStatus({ s: 'ready', size: bytes.byteLength, stats });
      } catch (e) {
        fail(e);
      }
    })();
    return () => ac.abort();
  }, [viewer, active, path, src, reloadKey]);

  const ready = status.s === 'ready' ? status : null;
  const note = (text: string, alert = false) => <p role={alert ? 'alert' : undefined} className="absolute inset-x-0 top-0 p-4 text-sm text-muted-foreground">{text}</p>;
  return (
    <div
      ref={pane}
      data-pane={tabId}
      data-model-ready={ready ? 'true' : undefined}
      hidden={!active}
      className="grid-pane relative min-h-0 flex-1 overflow-hidden"
    >
      <div ref={host} data-model-host className="absolute inset-0 bg-background" onDoubleClick={() => viewer?.resetView()} />
      {status.s === 'loading' && note(t('modelLoading', status.pct))}
      {status.s === 'gone' && note(t('fileGone'))}
      {status.s === 'tooBig' && note(t('modelTooBig', fmtSize(status.size)))}
      {status.s === 'error' && note(t('modelFailed', status.message), true)}
      {status.s === 'lost' && note(t('modelLost'), true)}
      {ready && (
        <div data-anchor-skip className="absolute inset-x-0 bottom-0 flex flex-wrap items-center gap-2 border-t border-border-soft bg-chrome px-3 py-1 font-mono text-[11.5px] text-muted-foreground backdrop-blur">
          <span data-model-info className="min-w-0 flex-1 truncate">
            {t('modelInfo', fmtSize(ready.size), ready.stats.meshes, ready.stats.triangles, ready.stats.materials, ready.stats.clips.length)}
          </span>
          {ready.stats.clips.length > 0 && (
            <>
              <select
                aria-label={t('modelClip')}
                value={clip}
                onChange={(e) => { const i = Number(e.target.value); setClip(i); viewer?.setClip(i); }}
                className="max-w-40 rounded border border-border-soft bg-background px-1"
              >
                {ready.stats.clips.map((c, i) => <option key={i} value={i}>{c || `#${i + 1}`}</option>)}
              </select>
              <button
                type="button"
                aria-label={playing ? t('modelPause') : t('modelPlay')}
                title={playing ? t('modelPause') : t('modelPlay')}
                onClick={() => { viewer?.setPlaying(!playing); setPlaying(!playing); }}
                className="rounded px-1.5 hover:bg-muted hover:text-foreground"
              >{playing ? '❚❚' : '▶'}</button>
            </>
          )}
          <button type="button" aria-label={t('modelReset')} title={t('modelResetTip')} onClick={() => viewer?.resetView()} className="rounded px-1.5 hover:bg-muted hover:text-foreground">⟲</button>
        </div>
      )}
    </div>
  );
}
