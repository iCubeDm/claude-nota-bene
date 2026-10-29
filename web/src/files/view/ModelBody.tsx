import { useCallback, useEffect, useRef, useState } from 'react';
import { useT } from '@/i18n/index.ts';
import type { CameraPose, ModelStats, ModelViewer, ViewerModule } from '@/model/api.ts';
import { publishViewPose, registerModelViewer, unregisterModelViewer } from '@/model/registry.ts';
import { RefusedResource, resolveModelUrl } from '@/model/resolve.ts';
import { BLEND, fileUrl, modelUrl } from '../kinds.ts';
import { ModelMarkup } from './ModelMarkup.tsx';

/** Above this a model is not fetched at all: the whole file lives in memory twice (bytes, then the parsed scene). */
export const MODEL_MAX_BYTES = 256 * 1024 * 1024;

type Status =
  | { s: 'loading'; pct: number | null }
  | { s: 'ready'; size: number; stats: ModelStats }
  | { s: 'tooBig'; size: number }
  | { s: 'gone' }
  | { s: 'lost' }
  | { s: 'noGl' }
  | { s: 'refused'; uri: string }
  | { s: 'noBlender' }
  | { s: 'error'; message: string };

type Tr = ReturnType<typeof useT>;
export function fmtSize(n: number, t: Tr): string {
  if (n < 1024) return `${n} ${t('sizeB')}`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} ${t('sizeKB')}`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} ${t('sizeMB')}`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(1)} ${t('sizeGB')}`;
}

/** A hidden model tab gives its WebGL context back after this long (browsers allow about 16 contexts per page). */
export const RELEASE_AFTER_MS = 20_000;

// the whole 3D module (three and its loaders) is one lazy chunk, fetched when the first model tab is shown
let viewerP: Promise<ViewerModule> | undefined;
function loadViewerModule(): Promise<ViewerModule> {
  viewerP ??= import('@/model/viewer.ts');
  // a failed chunk load must not stick for the page's lifetime: the next model tab tries again
  viewerP.catch(() => { viewerP = undefined; });
  return viewerP;
}

class Gone extends Error {}
/** The server has no Blender (501 from /model). */
class NoBlender extends Error {}
class TooBig extends Error {
  size: number;
  constructor(size: number) { super('too big'); this.size = size; }
}

/**
 * The file as bytes, with progress. The size and ETag are known from the headers before any body is read: with the
 * ETag the caller already has (`known`) the body is cancelled unread and `same` is true.
 */
export async function fetchModel(
  url: string, signal: AbortSignal, known: string | null, onProgress: (pct: number | null) => void, max = MODEL_MAX_BYTES,
): Promise<{ bytes: ArrayBuffer | null; etag: string | null; same: boolean }> {
  const res = await fetch(url, { signal });
  if (res.status === 404) throw new Gone();
  if (res.status === 501) throw new NoBlender();
  if (!res.ok) {
    // /model explains a failed conversion as {error, detail}; any other failure is just its status
    const j = (res.headers.get('content-type') ?? '').includes('json')
      ? await res.json().catch(() => null) as { error?: string; detail?: string } | null : null;
    throw new Error(j?.detail || j?.error || `${res.status} ${res.statusText}`.trim());
  }
  const etag = res.headers.get('etag');
  if (known && etag === known) {
    void res.body?.cancel();
    return { bytes: null, etag, same: true };
  }
  const total = Number(res.headers.get('content-length') ?? 0);
  if (total > max) {
    void res.body?.cancel();
    throw new TooBig(total);
  }
  if (!res.body) return { bytes: await res.arrayBuffer(), etag, same: false };
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let got = 0;
  let last = -1;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    got += value.length;
    if (got > max) {
      void reader.cancel();
      throw new TooBig(got);
    }
    const pct = total > 0 ? Math.min(100, Math.floor((got / total) * 100)) : null;
    if (pct !== last) onProgress((last = pct as number));
  }
  const out = new Uint8Array(got);
  let at = 0;
  for (const c of chunks) { out.set(c, at); at += c.length; }
  return { bytes: out.buffer, etag, same: false };
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
 * The pane of a .glb / .gltf / .blend (converted to GLB by the server's Blender): a view-only 3D viewer (orbit, zoom), with reset view, animation clips and an info line.
 * All the 3D code is in the lazy `@/model/viewer.ts`; this component fetches the bytes (size cap, progress), owns the
 * states and the viewer's lifetime. Nothing is created or fetched until the tab is first shown; after that a download
 * goes on while the tab is hidden. `reloadKey`: ↻ / a finished turn; a reload keeps the camera, and a file with the same
 * ETag is not even read. A lost WebGL context disposes the viewer; ↻ makes a new one and parses the kept bytes again.
 * A tab hidden for RELEASE_AFTER_MS gives its context back and gets a new viewer (same camera) when shown.
 */
export function ModelBody({ path, src, fileRef, tabId, active, reloadKey, releaseAfterMs = RELEASE_AFTER_MS }: {
  path: string; src: string; fileRef?: string; tabId: string; active: boolean; reloadKey: number; releaseAfterMs?: number;
}) {
  const t = useT();
  const pane = useRef<HTMLDivElement>(null);
  const host = useRef<HTMLDivElement>(null);
  const [started, setStarted] = useState(active);
  if (active && !started) setStarted(true);
  const [viewer, setViewer] = useState<ModelViewer | null>(null);
  const [status, setStatus] = useState<Status>({ s: 'loading', pct: null });
  const [clip, setClip] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [lost, setLost] = useState(false);
  const [released, setReleased] = useState(false);
  const [shown, setShown] = useState<ModelViewer | null>(null); // the viewer whose scene holds the model now
  const [marking, setMarking] = useState(false); // a drawing is being made over the view: the camera and the clip are held
  const bgRef = useRef<string>('');
  const file = `${path}\0${src}`;

  // what outlives a viewer (its recreation after a loss or a release, not a change of file)
  const loaded = useRef<string | null>(null); // the key (file + reloadKey) the viewer shows
  const hadModel = useRef(false);
  const lastEtag = useRef<string | null>(null);
  const bytes = useRef<ArrayBuffer | null>(null); // the file as fetched: re-parsed into a new viewer without a download
  const pose = useRef<{ file: string; pose: CameraPose } | null>(null);
  const inflight = useRef<{ key: string; ac: AbortController } | null>(null);
  const bound = useRef(file);
  const [idle, setIdle] = useState(0); // bumps when a download ends: re-arms the release timer

  // the viewer: made on first show, disposed on close, on a lost context, when released, or when the file is another one
  useEffect(() => {
    if (!started || released || lost || !host.current) return;
    if (bound.current !== file) {
      bound.current = file;
      lastEtag.current = null;
      bytes.current = null;
      pose.current = null;
    }
    loaded.current = null;
    hadModel.current = false;
    let dead = false;
    let v: ModelViewer | undefined;
    loadViewerModule().then((m) => {
      if (dead || !host.current) return;
      const background = getComputedStyle(host.current).backgroundColor;
      bgRef.current = background;
      try {
        v = m.createViewer(host.current, {
          background,
          onContextLost: () => { if (!dead) { setLost(true); setStatus({ s: 'lost' }); } },
          onView: (p: CameraPose) => {
            if (pane.current) pane.current.dataset.modelCamera = [...p.position, ...p.target].map((x) => x.toFixed(3)).join(' ');
            publishViewPose(tabId, p);
          },
        });
      } catch {
        setStatus({ s: 'noGl' }); // no WebGL, a blocklisted GPU, or the context cap
        return;
      }
      registerModelViewer(tabId, v);
      setViewer(v);
    }, (e: unknown) => !dead && setStatus({ s: 'error', message: e instanceof Error ? e.message : String(e) }));
    return () => {
      dead = true;
      inflight.current?.ac.abort();
      inflight.current = null;
      if (v) {
        try { if (hadModel.current) pose.current = { file, pose: v.getPose() }; } catch { /* keep the older one */ }
        unregisterModelViewer(tabId, v);
        v.dispose();
      }
      setViewer(null);
      setShown(null);
    };
  }, [started, released, lost, tabId, file]);

  // ↻ on a lost context: a new viewer (the load effect then parses the kept bytes, whatever the ETag says)
  useEffect(() => void setLost(false), [reloadKey]);
  // a hidden tab gives its context back after a while (not in the middle of a download); showing it again recreates it
  useEffect(() => {
    if (active) return void setReleased(false);
    if (!viewer) return;
    const id = setTimeout(() => { if (!inflight.current) setReleased(true); }, releaseAfterMs);
    return () => clearTimeout(id);
  }, [active, viewer, releaseAfterMs, idle]);

  useBackground(host, (css) => { if (css !== bgRef.current) { bgRef.current = css; viewer?.setBackground(css); } });
  useEffect(() => void viewer?.setVisible(active), [viewer, active]);

  // load: when the viewer exists, once per (file, reloadKey). It goes on while the tab is hidden; a new reload key that
  // arrives while hidden waits for the tab to be shown
  useEffect(() => {
    if (!viewer) return;
    const key = `${file}\0${reloadKey}`;
    if (loaded.current === key || inflight.current?.key === key) return;
    if (!active && loaded.current !== null) return;
    inflight.current?.ac.abort();
    const ac = new AbortController();
    inflight.current = { key, ac };
    const slash = path.lastIndexOf('/');
    const baseDir = slash > 0 ? path.slice(0, slash) : undefined;
    const settle = () => { if (inflight.current?.ac === ac) { inflight.current = null; setIdle((n) => n + 1); } };
    const fail = (e: unknown) => {
      if (ac.signal.aborted) return;
      settle();
      loaded.current = key;
      viewer.clear();
      setShown(null);
      hadModel.current = false;
      lastEtag.current = null;
      bytes.current = null;
      if (e instanceof Gone) setStatus({ s: 'gone' });
      else if (e instanceof TooBig) setStatus({ s: 'tooBig', size: e.size });
      else if (e instanceof NoBlender) setStatus({ s: 'noBlender' });
      else if (e instanceof RefusedResource) setStatus({ s: 'refused', uri: e.uri });
      else setStatus({ s: 'error', message: e instanceof Error ? e.message : String(e) });
    };
    // a reload of a model on screen keeps showing it (no flash of "loading") until the new bytes are in
    if (!hadModel.current) setStatus({ s: 'loading', pct: null });
    void (async () => {
      try {
        const known = bytes.current ? lastEtag.current : null;
        const r = await fetchModel(modelUrl(path, src), ac.signal, known, (pct) => !ac.signal.aborted && !hadModel.current && setStatus({ s: 'loading', pct }));
        if (ac.signal.aborted) return;
        // the same file (same ETag): nothing to parse when it is on screen, else the bytes we kept go to the new viewer
        if (r.same && hadModel.current) {
          settle();
          loaded.current = key;
          return;
        }
        const data = r.same ? bytes.current! : r.bytes!;
        viewer.clear();
        const keepView = hadModel.current;
        const stats = await viewer.load(data, { resolve: (uri) => resolveModelUrl(uri, baseDir, src), keepView });
        if (ac.signal.aborted) return;
        settle();
        bytes.current = data;
        lastEtag.current = r.etag; // only for a file that really is on screen
        loaded.current = key;
        hadModel.current = true;
        setShown(viewer);
        if (pose.current?.file === file) viewer.setPose(pose.current.pose); // back from a release or a loss: the camera it had
        pose.current = null;
        setClip(0);
        setPlaying(false);
        if (stats.clips.length) viewer.setClip(0);
        setStatus({ s: 'ready', size: data.byteLength, stats });
      } catch (e) {
        fail(e);
      }
    })();
  }, [viewer, active, file, path, src, reloadKey]);

  const ready = status.s === 'ready' ? status : null;
  const onPause = useCallback(() => setPlaying(false), []);
  const markUrl = reloadKey ? `${fileUrl(path, undefined, src)}&r=${reloadKey}` : fileUrl(path, undefined, src);
  const blend = BLEND.test(path);
  const note = (text: string, alert = false) => <p role={alert ? 'alert' : undefined} className="absolute inset-x-0 top-0 p-4 text-sm text-muted-foreground">{text}</p>;
  return (
    <div
      ref={pane}
      data-pane={tabId}
      data-model-ready={ready ? 'true' : undefined}
      hidden={!active}
      className="grid-pane relative min-h-0 flex-1 overflow-hidden"
    >
      <div ref={host} data-model-host className="absolute inset-0 bg-background" onDoubleClick={() => marking || viewer?.resetView()} />
      {status.s === 'loading' && note(blend && status.pct === null ? t('modelConverting') : t('modelLoading', status.pct))}
      {status.s === 'gone' && note(t('fileGone'))}
      {status.s === 'tooBig' && note(t('modelTooBig', fmtSize(status.size, t)))}
      {status.s === 'error' && note(t('modelFailed', status.message), true)}
      {status.s === 'lost' && note(t('modelLost'), true)}
      {status.s === 'noGl' && note(t('modelNoWebgl'), true)}
      {status.s === 'noBlender' && note(t('modelNoBlender'), true)}
      {status.s === 'refused' && note(t('modelRefused', status.uri), true)}
      <ModelMarkup
        tabId={tabId} path={path} src={src} fileRef={fileRef} url={markUrl} active={active} viewer={viewer} ready={!!ready && shown === viewer}
        playing={playing} onPause={onPause} onMarking={setMarking}
      />
      {ready && (
        <div data-anchor-skip className="absolute inset-x-0 bottom-0 flex flex-wrap items-center gap-2 border-t border-border-soft bg-chrome px-3 py-1 font-mono text-[11.5px] text-muted-foreground backdrop-blur">
          <span data-model-info className="min-w-0 flex-1 truncate">
            {t('modelInfo', fmtSize(ready.size, t), ready.stats.meshes, ready.stats.triangles, ready.stats.materials, ready.stats.clips.length)}
            {ready.stats.refused ? ` · ${t('modelRefusedN', ready.stats.refused)}` : ''}
          </span>
          {ready.stats.clips.length > 0 && (
            <>
              <select
                aria-label={t('modelClip')}
                value={clip}
                disabled={marking}
                onChange={(e) => { const i = Number(e.target.value); setClip(i); viewer?.setClip(i); }}
                className="max-w-40 rounded border border-border-soft bg-background px-1"
              >
                {ready.stats.clips.map((c, i) => <option key={i} value={i}>{c || `#${i + 1}`}</option>)}
              </select>
              <button
                type="button"
                disabled={marking}
                aria-label={playing ? t('modelPause') : t('modelPlay')}
                title={playing ? t('modelPause') : t('modelPlay')}
                onClick={() => { viewer?.setPlaying(!playing); setPlaying(!playing); }}
                className="rounded px-1.5 hover:bg-muted hover:text-foreground"
              >{playing ? '❚❚' : '▶'}</button>
            </>
          )}
          <button type="button" aria-label={t('modelReset')} title={t('modelResetTip')} disabled={marking} onClick={() => viewer?.resetView()} className="rounded px-1.5 hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-40">⟲</button>
          {blend && <span data-model-note className="basis-full">{t('modelBlendNote')}</span>}
        </div>
      )}
    </div>
  );
}
