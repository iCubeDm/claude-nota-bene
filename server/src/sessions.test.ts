import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cwdOf, listSessionsView, titleOf } from './sessions.ts';

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nb-sessions-')); });
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const jsonl = (project: string, id: string, body: string) => {
  fs.mkdirSync(path.join(dir, project), { recursive: true });
  fs.writeFileSync(path.join(dir, project, `${id}.jsonl`), body);
};

describe('listSessionsView cwd', () => {
  it('normalises every cwd with the native realpath, keeping the raw value when it does not exist', async () => {
    const real = fs.realpathSync(dir);
    const link = path.join(real, 'link');
    fs.symlinkSync(real, link);
    const backend = {
      listSessions: async () => [
        { sessionId: 'a', cwd: link, lastModified: 1, fileSize: 1 },
        { sessionId: 'b', cwd: '/nb-no-such-dir/x', lastModified: 2, fileSize: 1 },
      ],
    } as never;
    const view = await listSessionsView({ backend, current: null, root: real, projectsDir: dir });
    expect(view.sessions.map((s) => s.cwd)).toEqual([real, '/nb-no-such-dir/x']);
  });
});

describe('titleOf', () => {
  it('skips a slash command and returns the summary', () => {
    expect(titleOf({ customTitle: '/clear', summary: 'Fix the parser', firstPrompt: 'hi' })).toBe('Fix the parser');
    expect(titleOf({ summary: '/clear', firstPrompt: 'first' })).toBe('first');
  });

  it('prefers the custom title, and gives null when nothing is usable', () => {
    expect(titleOf({ customTitle: 'Mine', summary: 's' })).toBe('Mine');
    expect(titleOf({ customTitle: '', summary: '', firstPrompt: '/compact' })).toBeNull();
    expect(titleOf(null)).toBeNull();
  });
});

describe('cwdOf', () => {
  it('finds the cwd deep in a large head', () => {
    const pad = `${JSON.stringify({ type: 'x', pad: 'p'.repeat(200 * 1024) })}\n`;
    jsonl('-a-b', 'id-big', `${pad}{"type":"user","cwd":"/work/\\"q\\" dir"}\n`);
    expect(cwdOf('id-big', dir)).toBe('/work/"q" dir');
  });

  it('gives null past the first 256 KB', () => {
    const pad = `${JSON.stringify({ pad: 'p'.repeat(300 * 1024) })}\n`;
    jsonl('-a', 'id-far', `${pad}{"cwd":"/late"}\n`);
    expect(cwdOf('id-far', dir)).toBeNull();
  });

  it('caches a miss', () => {
    expect(cwdOf('id-later', dir)).toBeNull();
    jsonl('-x', 'id-later', '{"cwd":"/now"}\n');
    expect(cwdOf('id-later', dir)).toBeNull();
  });

  it('forgets a miss after 60 s, keeps a hit', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      expect(cwdOf('id-ttl', dir)).toBeNull();
      jsonl('-t', 'id-ttl', '{"cwd":"/first"}\n');
      vi.setSystemTime(Date.now() + 59_000);
      expect(cwdOf('id-ttl', dir)).toBeNull();
      vi.setSystemTime(Date.now() + 2_000);
      expect(cwdOf('id-ttl', dir)).toBe('/first');
      fs.writeFileSync(path.join(dir, '-t', 'id-ttl.jsonl'), '{"cwd":"/second"}\n');
      vi.setSystemTime(Date.now() + 120_000);
      expect(cwdOf('id-ttl', dir)).toBe('/first');
    } finally {
      vi.useRealTimers();
    }
  });

  it('refuses an id that is not a plain file name', () => {
    expect(cwdOf('../etc', dir)).toBeNull();
  });
});

describe('listSessionsView', () => {
  it('drops entries without a cwd, falling back to the transcript', async () => {
    jsonl('-p', 'from-file', '{"cwd":"/from/file"}\n');
    const backend = {
      listSessions: async () => [
        { sessionId: 'with-cwd', summary: 'A', lastModified: 10, fileSize: 100, cwd: '/a' },
        { sessionId: 'from-file', firstPrompt: 'B', lastModified: 20, fileSize: 200 },
        { sessionId: 'no-cwd', summary: 'C', lastModified: 30, fileSize: 300 },
        { sessionId: 'slash', summary: '/clear', lastModified: 40, fileSize: 400, cwd: '/d' },
      ],
    };
    const view = await listSessionsView({ backend, current: 'with-cwd', root: '/a', projectsDir: dir });
    expect(view).toEqual({
      current: 'with-cwd',
      root: '/a',
      sessions: [
        { id: 'with-cwd', title: 'A', at: 10, size: 100, cwd: '/a' },
        { id: 'from-file', title: 'B', at: 20, size: 200, cwd: '/from/file' },
        { id: 'slash', title: '', at: 40, size: 400, cwd: '/d' },
      ],
    });
  });
});
