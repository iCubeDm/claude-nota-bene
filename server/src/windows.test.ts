import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { stateDir } from './state.ts';
import { liveWindows, pidAlive, readWindows, registerWindow, unregisterWindow } from './windows.ts';

let home: string;
const prevHome = process.env.NOTA_BENE_HOME;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'nb-windows-'));
  process.env.NOTA_BENE_HOME = home;
});
afterEach(() => {
  if (prevHome === undefined) delete process.env.NOTA_BENE_HOME; else process.env.NOTA_BENE_HOME = prevHome;
  fs.rmSync(home, { recursive: true, force: true });
});

const file = (port: number) => path.join(stateDir(), 'windows', `${port}.json`);
// a pid that surely is not running: spawnSync waits for the child and reaps it
const deadPid = () => spawnSync('true').pid!;

describe('windows registry', () => {
  it('registers an entry with the root, both pids and the start time', () => {
    registerWindow(4791, '/p', 111, 222);
    const w = readWindows()['4791']!;
    expect(w).toMatchObject({ root: '/p', pid: 111, launcherPid: 222 });
    expect(typeof w.startedAt).toBe('number');
  });

  it('keeps one file per port: other ports are untouched and no tmp file is left behind', () => {
    registerWindow(4792, '/q', 5);
    registerWindow(4791, '/p', 111);
    registerWindow(4791, '/p2', 112);
    expect(readWindows()).toMatchObject({ 4791: { root: '/p2', pid: 112 }, 4792: { root: '/q', pid: 5 } });
    expect(fs.readdirSync(path.join(home, 'windows')).sort()).toEqual(['4791.json', '4792.json']);
  });

  it('unregisters only when the pid matches', () => {
    registerWindow(4791, '/p', 111);
    unregisterWindow(4791, 999);
    expect(readWindows()['4791']).toBeDefined();
    unregisterWindow(4791, 111);
    expect(readWindows()['4791']).toBeUndefined();
  });

  it('a corrupt entry reads as absent, is replaced on the next write, and other files are ignored', () => {
    fs.mkdirSync(path.dirname(file(4791)), { recursive: true });
    fs.writeFileSync(file(4791), '{');
    fs.writeFileSync(path.join(home, 'windows', 'notes.txt'), 'x');
    expect(readWindows()).toEqual({});
    registerWindow(4791, '/p', 111);
    expect(readWindows()['4791']?.root).toBe('/p');
  });

  it('pidAlive: own pid yes, a reaped pid no', () => {
    expect(pidAlive(process.pid)).toBe(true);
    expect(pidAlive(deadPid())).toBe(false);
  });
});

describe('liveWindows', () => {
  it('lists an entry whose pid is alive and whose /info.root matches', async () => {
    registerWindow(4791, '/p', process.pid);
    const probed: number[] = [];
    const live = await liveWindows(async (port) => (probed.push(port), { root: '/p' }));
    expect(live).toEqual([{ port: 4791, root: '/p' }]);
    expect(probed).toEqual([4791]);
  });

  it('prunes a stale entry (dead pid) without probing it', async () => {
    registerWindow(4791, '/p', deadPid());
    registerWindow(4792, '/q', process.pid);
    const probed: number[] = [];
    const live = await liveWindows(async (port) => (probed.push(port), { root: '/q' }));
    expect(live).toEqual([{ port: 4792, root: '/q' }]);
    expect(probed).toEqual([4792]);
    expect(Object.keys(readWindows())).toEqual(['4792']);
  });

  it('ignores and prunes an entry whose /info.root differs (the port now serves another folder or app)', async () => {
    registerWindow(4791, '/p', process.pid);
    expect(await liveWindows(async () => ({ root: '/other' }))).toEqual([]);
    expect(readWindows()['4791']).toBeUndefined();
  });

  it('skips but keeps an entry whose pid is alive and whose /info does not answer (busy, not proven stale)', async () => {
    registerWindow(4791, '/p', process.pid);
    expect(await liveWindows(async () => null)).toEqual([]);
    expect(readWindows()['4791']).toBeDefined();
  });
});
