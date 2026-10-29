import { afterEach, expect, it } from 'vitest';
import type { Comment, MediaAnchor } from '@nota-bene/shared';
import { setLang } from '@/i18n/index.ts';
import { whereOf } from './send.ts';

const model = (over: Partial<MediaAnchor> = {}): Comment => ({
  id: 'c1', text: 'thin', status: 'pending', createdAt: 1,
  anchor: {
    kind: 'media', source: { kind: 'file', path: 'models/car.glb' }, width: 800, height: 600,
    camera: { position: [1.23456, 2, -3.5], target: [0, 0.12345, 0], fov: 50 },
    shapes: [{ kind: 'rect', color: '#ff3b30', x: 0.1, y: 0.1, w: 0.2, h: 0.2 }], ...over,
  },
});
afterEach(() => setLang('en'));

it('a model comment names the file, the frame size and the camera (3 significant digits), in en and ru', () => {
  setLang('en');
  expect(whereOf(model())).toBe('models/car.glb · 800×600 · camera (1.23, 2, -3.5) → (0, 0.123, 0), fov 50°');
  setLang('ru');
  expect(whereOf(model())).toBe('models/car.glb · 800×600 · камера (1.23, 2, -3.5) → (0, 0.123, 0), fov 50°');
});

it('a video / image comment (no camera) is unchanged; another source keeps its ref', () => {
  setLang('en');
  expect(whereOf(model({ camera: undefined, time: 4.24 }))).toBe('models/car.glb @ 0:04.240 · 800×600');
  expect(whereOf(model({ source: { kind: 'file', path: 'm.glb', ref: 'feat' } }))).toMatch(/^m\.glb @ feat · 800×600 · camera /);
});
