import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { seekStep } from './seekStep.ts';

beforeEach(() => { localStorage.clear(); seekStep.reload(); });
afterEach(() => { localStorage.clear(); seekStep.reload(); });

it('defaults to 5 s, persists a choice, and falls back to 5 on garbage', () => {
  expect(seekStep.get()).toBe(5);
  seekStep.set(0.5);
  expect(localStorage.getItem('nb.seekStep')).toBe('0.5');
  seekStep.reload();
  expect(seekStep.get()).toBe(0.5);
  for (const bad of ['abc', '7', '', '-1', 'NaN']) {
    localStorage.setItem('nb.seekStep', bad);
    seekStep.reload();
    expect(seekStep.get()).toBe(5);
  }
});

it('subscribers fire on a change only, and stop after unsubscribe', () => {
  const f = vi.fn();
  const off = seekStep.subscribe(f);
  seekStep.set(5);
  expect(f).not.toHaveBeenCalled();
  seekStep.set(1);
  expect(f).toHaveBeenCalledTimes(1);
  off();
  seekStep.set(0.1);
  expect(f).toHaveBeenCalledTimes(1);
});
