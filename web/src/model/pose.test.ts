import { expect, it } from 'vitest';
import { cameraLine, nearPose, sig3 } from './pose.ts';

const cam = { position: [3, 2, 1] as [number, number, number], target: [0, 0, 0] as [number, number, number], fov: 50 };

it('sig3 rounds to 3 significant digits without exponents or -0', () => {
  expect(sig3(1.23456)).toBe('1.23');
  expect(sig3(1234.5)).toBe('1230');
  expect(sig3(0)).toBe('0');
  expect(sig3(-0)).toBe('0');
  expect(sig3(-0.000123456)).toBe('-0.000123');
  expect(sig3(50)).toBe('50');
  expect(sig3(0.5)).toBe('0.5');
});

it('cameraLine in en and ru', () => {
  const c = { position: [1.23456, -2, 0] as [number, number, number], target: [0, 0.5, 100.4] as [number, number, number], fov: 45 };
  expect(cameraLine(c, 'en')).toBe('camera (1.23, -2, 0) → (0, 0.5, 100), fov 45°');
  expect(cameraLine(c, 'ru')).toBe('камера (1.23, -2, 0) → (0, 0.5, 100), fov 45°');
});

it('nearPose: the same pose, a hair away (relative to the distance), but not a visible move or another fov', () => {
  expect(nearPose(cam, { ...cam })).toBe(true);
  expect(nearPose(cam, { ...cam, position: [3.0000001, 2, 1] })).toBe(true);
  expect(nearPose(cam, { ...cam, position: [3.01, 2, 1] })).toBe(false);
  expect(nearPose(cam, { ...cam, target: [0, 0.2, 0] })).toBe(false);
  expect(nearPose(cam, { ...cam, fov: 50.5 })).toBe(false);
  // scale: a tiny model is judged by its own distance
  const small = { position: [0.003, 0.002, 0.001] as [number, number, number], target: [0, 0, 0] as [number, number, number], fov: 50 };
  expect(nearPose(small, { ...small, position: [0.0031, 0.002, 0.001] })).toBe(false);
});
