/** What the lazily loaded 3D code (viewer.ts, three) offers the rest of the app. Types only: importing this costs nothing. */

export type ModelStats = { meshes: number; triangles: number; materials: number; clips: string[] };

/** The camera: where it is, what it looks at, its vertical field of view (degrees). */
export type CameraPose = { position: [number, number, number]; target: [number, number, number]; fov: number };

export type ViewerOptions = {
  /** Any CSS colour: the scene background (the app's `--background`). */
  background: string;
  /** The WebGL context was lost (the browser took it back); the canvas is blank until a new viewer is made. */
  onContextLost: () => void;
  /** The camera moved (controls, reset, setPose): for step B's comment anchor and the e2e checks. */
  onView?: (pose: CameraPose) => void;
};

export type LoadOptions = {
  /** Maps a resource uri named inside a .gltf to a url to fetch, or null to refuse it (see resolve.ts). */
  resolve: (uri: string) => string | null;
  /** Keep the camera as it is (a reload of the same model); otherwise frame the model's bounding box. */
  keepView: boolean;
};

export interface ModelViewer {
  /** Parses a .glb / .gltf. Replaces the model on screen (the caller `clear()`s first). Rejects with a readable error. */
  load(data: ArrayBuffer, o: LoadOptions): Promise<ModelStats>;
  /** Removes the model and disposes its geometries, materials and textures. */
  clear(): void;
  resetView(): void;
  getPose(): CameraPose;
  setPose(p: CameraPose): void;
  /** Animation clip `i` (index into ModelStats.clips), or null for none; `playing` starts / pauses it. Nothing plays by default. */
  setClip(i: number | null): void;
  setPlaying(playing: boolean): void;
  setBackground(css: string): void;
  /** A hidden tab renders nothing. */
  setVisible(visible: boolean): void;
  /** The current frame as a PNG (for step B's comments). */
  snapshot(): Promise<Blob | null>;
  /** Everything: model, renderer, WebGL context, observers. Safe to call twice. */
  dispose(): void;
}

export type ViewerModule = { createViewer: (host: HTMLElement, o: ViewerOptions) => ModelViewer };
