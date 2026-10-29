import {
  AnimationAction, AnimationMixer, Box3, Color, DirectionalLight, LoadingManager, Material, Mesh, Object3D,
  PerspectiveCamera, PMREMGenerator, Scene, SRGBColorSpace, Texture, ACESFilmicToneMapping, Vector3, WebGLRenderer,
} from 'three';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { GLTFLoader, type GLTF } from 'three/addons/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { createLatest } from './latest.ts';
import { RefusedResource } from './resolve.ts';
import type { CameraPose, LoadOptions, ModelStats, ModelViewer, ViewerOptions } from './api.ts';

/**
 * The 3D side of a model tab (the only module that imports three; loaded lazily, see ModelBody). Renders on demand:
 * a frame is drawn when the controls move, the size changes, an animation plays or the scene changes, and never while
 * the tab is hidden.
 */

const FOV = 50;

/** Any CSS colour (including oklch(), which three cannot parse) as a three Color, via a 1×1 canvas. */
function cssToColor(css: string): Color {
  const g = document.createElement('canvas').getContext('2d', { willReadFrequently: true });
  if (!g) return new Color(0x202020);
  g.canvas.width = g.canvas.height = 1;
  g.fillStyle = '#202020';
  g.fillStyle = css;
  g.fillRect(0, 0, 1, 1);
  const [r = 32, gr = 32, b = 32] = g.getImageData(0, 0, 1, 1).data;
  return new Color().setRGB(r / 255, gr / 255, b / 255, SRGBColorSpace);
}

function disposeObject(root: Object3D) {
  const mats = new Set<Material>();
  root.traverse((o) => {
    const m = o as Mesh;
    m.geometry?.dispose();
    for (const mat of Array.isArray(m.material) ? m.material : m.material ? [m.material] : []) mats.add(mat);
    (o as { skeleton?: { dispose(): void } }).skeleton?.dispose();
  });
  for (const mat of mats) {
    for (const v of Object.values(mat)) {
      if (v && (v as Texture).isTexture) {
        const tex = v as Texture;
        tex.dispose();
        (tex.source?.data as { close?: () => void } | undefined)?.close?.(); // an ImageBitmap holds its pixels until closed
      }
    }
    mat.dispose();
  }
}

function statsOf(gltf: GLTF): ModelStats {
  let meshes = 0;
  let triangles = 0;
  const materials = new Set<Material>();
  gltf.scene.traverse((o) => {
    const m = o as Mesh;
    if (!m.isMesh) return;
    meshes++;
    const g = m.geometry;
    const inst = (m as { isInstancedMesh?: boolean; count?: number }).isInstancedMesh ? ((m as { count?: number }).count ?? 1) : 1;
    triangles += ((g.index ? g.index.count : (g.attributes.position?.count ?? 0)) / 3) * inst;
    for (const mat of Array.isArray(m.material) ? m.material : [m.material]) materials.add(mat);
  });
  return { meshes, triangles: Math.floor(triangles), materials: materials.size, clips: gltf.animations.map((a) => a.name) };
}

export function createViewer(host: HTMLElement, o: ViewerOptions): ModelViewer {
  const renderer = new WebGLRenderer({ antialias: true, preserveDrawingBuffer: true }); // the canvas stays readable (snapshot)
  renderer.toneMapping = ACESFilmicToneMapping;
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  const canvas = renderer.domElement;
  canvas.style.display = 'block';
  canvas.style.touchAction = 'none';
  host.appendChild(canvas);

  const scene = new Scene();
  scene.background = cssToColor(o.background);
  const pmrem = new PMREMGenerator(renderer);
  const envScene = new RoomEnvironment();
  const envTarget = pmrem.fromScene(envScene, 0.04);
  scene.environment = envTarget.texture;
  envScene.traverse((x) => { const m = x as Mesh; m.geometry?.dispose(); (m.material as Material | undefined)?.dispose(); });
  pmrem.dispose();
  const key = new DirectionalLight(0xffffff, 1.2);
  key.position.set(3, 5, 4);
  scene.add(key);

  const camera = new PerspectiveCamera(FOV, 1, 0.01, 1000);
  camera.position.set(0, 0, 3);
  const controls = new OrbitControls(camera, canvas);
  controls.enableDamping = false; // on-demand rendering: no inertia frames

  let model: Object3D | null = null;
  let mixer: AnimationMixer | null = null;
  let clips: GLTF['animations'] = [];
  let action: AnimationAction | null = null;
  let playing = false;
  let visible = true;
  let disposed = false;
  let raf = 0;
  // seconds since the previous animation frame (THREE.Clock is deprecated); reset when playing (re)starts
  let last = performance.now();
  const tick = () => { const now = performance.now(); const dt = Math.min((now - last) / 1000, 0.1); // a tab in the background pauses rAF: no jump by the time away
     last = now; return dt; };
  const home = { position: new Vector3(0, 0, 3), target: new Vector3() };
  const latest = createLatest(); // a parse that was superseded (or outlived the viewer) is dropped, never shown
  const draco = new DRACOLoader(); // its decoder (wasm + js) is a hashed asset of our own build, fetched on the first compressed file

  const pose = (): CameraPose => ({
    position: camera.position.toArray() as CameraPose['position'],
    target: controls.target.toArray() as CameraPose['target'],
    fov: camera.fov,
  });
  const notify = () => o.onView?.(pose());

  const draw = () => {
    raf = 0;
    if (disposed || !visible) return;
    if (playing && mixer) mixer.update(tick());
    renderer.render(scene, camera);
    if (playing) raf = requestAnimationFrame(draw);
  };
  const requestRender = () => {
    if (disposed || !visible || raf) return;
    raf = requestAnimationFrame(draw);
  };

  controls.addEventListener('change', () => { requestRender(); notify(); });

  const resize = () => {
    const w = host.clientWidth;
    const h = host.clientHeight;
    if (!w || !h) return; // hidden
    renderer.setSize(w, h);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    requestRender();
  };
  const ro = new ResizeObserver(resize);
  ro.observe(host);
  resize();

  const onLost = (e: Event) => {
    e.preventDefault();
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
    if (!disposed) o.onContextLost();
  };
  canvas.addEventListener('webglcontextlost', onLost);

  function fit(m: Object3D, keepView: boolean) {
    const box = new Box3().setFromObject(m);
    const empty = box.isEmpty();
    const center = empty ? new Vector3() : box.getCenter(new Vector3());
    const radius = empty ? 1 : Math.max(box.getSize(new Vector3()).length() / 2, 1e-6);
    const dist = (radius / Math.sin((camera.fov * Math.PI) / 360)) * 1.1;
    camera.near = dist / 100;
    camera.far = dist * 100;
    camera.updateProjectionMatrix();
    controls.maxDistance = dist * 20;
    home.target.copy(center);
    home.position.copy(center).addScaledVector(new Vector3(0.8, 0.5, 1).normalize(), dist);
    if (!keepView) applyHome();
  }
  function applyHome() {
    camera.position.copy(home.position);
    controls.target.copy(home.target);
    controls.update();
    requestRender();
    notify();
  }

  function setActionPlaying() {
    if (!action) return;
    action.paused = !playing;
    if (playing) tick(); // do not jump by the time spent paused
    mixer?.update(0);
    requestRender();
  }

  const api: ModelViewer = {
    canvas,
    async load(data, lo: LoadOptions) {
      const my = latest.next();
      const refused: string[] = [];
      const manager = new LoadingManager();
      manager.setURLModifier((url) => {
        const r = lo.resolve(url);
        if (r === null) { refused.push(url); return 'about:blank'; }
        return r;
      });
      const loader = new GLTFLoader(manager).setDRACOLoader(draco).setMeshoptDecoder(MeshoptDecoder);
      let gltf: GLTF;
      try {
        gltf = await new Promise<GLTF>((ok, bad) => loader.parse(data, '', ok, (e) => bad(e instanceof Error ? e : new Error(String((e as { message?: string }).message ?? e)))));
      } catch (e) {
        if (refused.length) throw new RefusedResource(refused[0]!);
        throw e;
      }
      if (disposed || !latest.current(my)) {
        disposeObject(gltf.scene);
        throw new Error('superseded'); // the caller has moved on and ignores this
      }
      api.clear();
      model = gltf.scene;
      scene.add(model);
      clips = gltf.animations;
      mixer = clips.length ? new AnimationMixer(model) : null;
      fit(model, lo.keepView);
      requestRender();
      return { ...statsOf(gltf), refused: refused.length };
    },
    clear() {
      latest.invalidate(); // a parse still running will find it is no longer wanted
      action = null;
      playing = false;
      if (mixer && model) { mixer.stopAllAction(); mixer.uncacheRoot(model); }
      mixer = null;
      clips = [];
      if (model) {
        scene.remove(model);
        disposeObject(model);
        model = null;
      }
      requestRender();
    },
    resetView: applyHome,
    getPose: pose,
    setPose(p) {
      camera.position.fromArray(p.position);
      controls.target.fromArray(p.target);
      camera.fov = p.fov;
      camera.updateProjectionMatrix();
      controls.update();
      requestRender();
      notify();
    },
    setClip(i) {
      action?.stop();
      action = null;
      const clip = i === null ? undefined : clips[i];
      if (mixer && clip) {
        action = mixer.clipAction(clip);
        action.play();
        setActionPlaying();
      } else requestRender();
    },
    setPlaying(p) {
      playing = p;
      setActionPlaying();
    },
    setBackground(css) {
      scene.background = cssToColor(css);
      requestRender();
    },
    setVisible(v) {
      visible = v;
      if (v) { tick(); resize(); requestRender(); } else if (raf) { cancelAnimationFrame(raf); raf = 0; }
    },
    setFrozen(frozen) {
      controls.enabled = !frozen;
    },
    renderNow() {
      if (!disposed) renderer.render(scene, camera);
      return pose();
    },
    snapshot() {
      if (disposed) return Promise.resolve(null);
      renderer.render(scene, camera);
      return new Promise((ok) => canvas.toBlob(ok, 'image/png'));
    },
    dispose() {
      if (disposed) return;
      api.clear();
      disposed = true;
      if (raf) cancelAnimationFrame(raf);
      ro.disconnect();
      canvas.removeEventListener('webglcontextlost', onLost);
      controls.dispose();
      draco.dispose();
      envTarget.dispose();
      renderer.dispose();
      renderer.forceContextLoss();
      canvas.remove();
    },
  };
  return api;
}
