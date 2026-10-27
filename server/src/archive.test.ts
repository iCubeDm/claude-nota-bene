import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServerEvent } from '@nota-bene/shared';
import { HistoryArchive } from './archive.ts';

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nb-archive-')); });
afterEach(() => { vi.restoreAllMocks(); fs.rmSync(dir, { recursive: true, force: true }); });

const user = (id: string): ServerEvent => ({ kind: 'user', id, text: id, ts: 1 });
const msg = (id: string): ServerEvent => ({ kind: 'agent', e: { t: 'message', id, text: id }, ts: 2 });

describe('HistoryArchive', () => {
  it('append numbers segments from 1, one JSON line each; count and segment read them back', () => {
    const a = new HistoryArchive({ dir: path.join(dir, 'history') }); // the dir is made on the first append
    expect(a.count('s1')).toBe(0);
    expect(a.segment('s1', 1)).toBeNull();
    expect(a.append('s1', [user('u1'), msg('m1')])).toBe(1);
    expect(a.append('s1', [user('u2')])).toBe(2);
    expect(a.count('s1')).toBe(2);
    expect(a.count('s2')).toBe(0);
    expect(a.segment('s1', 1)).toEqual([user('u1'), msg('m1')]);
    expect(a.segment('s1', 2)).toEqual([user('u2')]);
    expect(a.segment('s1', 3)).toBeNull();
    const lines = fs.readFileSync(path.join(dir, 'history', 's1.jsonl'), 'utf8').split('\n');
    expect(lines).toHaveLength(3); // two lines, each ended by \n
    expect(JSON.parse(lines[0]!)).toEqual({ segment: 1, events: [user('u1'), msg('m1')] });
  });

  it('stream_event frames are not archived', () => {
    const a = new HistoryArchive({ dir });
    a.append('s1', [
      { kind: 'agent', e: { t: 'message-start' }, ts: 1 },
      { kind: 'agent', e: { t: 'message-chunk', text: 'he' }, ts: 1 },
      msg('m1'),
    ]);
    expect(a.segment('s1', 1)).toEqual([msg('m1')]);
  });

  it('corrupt archive line is skipped', () => {
    const reports: unknown[] = [];
    const a = new HistoryArchive({ dir, report: (e) => void reports.push(e) });
    a.append('s1', [user('u1')]);
    fs.appendFileSync(path.join(dir, 's1.jsonl'), '{"segment":2,"events":[tor\n');
    a.append('s1', [user('u3')]);
    expect(a.segment('s1', 1)).toEqual([user('u1')]);
    expect(a.segment('s1', 2)).toBeNull();
    expect(a.segment('s1', 3)).toEqual([user('u3')]); // numbered after the corrupt line's number
    expect(a.count('s1')).toBe(3); // the highest valid number: `before: count + 1` reaches the newest
    expect(a.before('s1', 3)).toEqual({ events: [user('u1')], segment: 1, more: false }); // the hole is skipped
    expect(reports).toHaveLength(1); // reported once per session, however often it is read
    expect(String(reports[0])).toContain('s1');
  });

  it('a torn last line does not stop the next append from starting on a line of its own', () => {
    const a = new HistoryArchive({ dir, report: () => {} });
    a.append('s1', [user('u1')]);
    fs.appendFileSync(path.join(dir, 's1.jsonl'), '{"segment":2,"ev'); // a crash mid-write: no newline
    expect(a.append('s1', [user('u2')])).toBe(3); // a corrupt line keeps its number: no two lines share one
    expect(a.segment('s1', 3)).toEqual([user('u2')]);
    expect(a.segment('s1', 1)).toEqual([user('u1')]);
  });

  it('before(n) gives the newest segment below n and whether an older one exists', () => {
    const a = new HistoryArchive({ dir });
    a.append('s1', [user('a')]);
    a.append('s1', [user('b')]);
    expect(a.before('s1', 3)).toEqual({ events: [user('b')], segment: 2, more: true });
    expect(a.before('s1', 2)).toEqual({ events: [user('a')], segment: 1, more: false });
    expect(a.before('s1', 1)).toBeNull();
    expect(a.before('nope', 5)).toBeNull();
  });

  it('a session id outside the pattern is refused, never turned into a path', () => {
    const a = new HistoryArchive({ dir });
    for (const bad of ['../x', 'a/b', '', 'x'.repeat(101), 'a.b']) {
      expect(() => a.append(bad, [user('u')])).toThrow(/invalid session id/);
      expect(() => a.count(bad)).toThrow(/invalid session id/);
    }
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it('an empty segment (only stream frames) writes nothing', () => {
    const a = new HistoryArchive({ dir });
    expect(a.append('s1', [{ kind: 'agent', e: { t: 'message-start' }, ts: 1 }])).toBe(0);
    expect(a.count('s1')).toBe(0);
    expect(fs.existsSync(path.join(dir, 's1.jsonl'))).toBe(false);
  });

  it('a short write is continued until the whole line is out', () => {
    const real = fs.writeSync.bind(fs) as (fd: number, b: Buffer, off: number, len: number) => number;
    vi.spyOn(fs, 'writeSync').mockImplementation(((fd: number, b: Buffer, off = 0, len = b.length - off) => real(fd, b, off, Math.min(len, 7))) as never);
    const a = new HistoryArchive({ dir });
    a.append('s1', [user('u1'), msg('m1')]);
    vi.restoreAllMocks();
    expect(a.segment('s1', 1)).toEqual([user('u1'), msg('m1')]);
  });

  it('an fsync that fails after the full write is reported, and the segment counts as written', () => {
    const reports: unknown[] = [];
    const a = new HistoryArchive({ dir, report: (e) => void reports.push(e) });
    vi.spyOn(fs, 'fsyncSync').mockImplementation(() => { throw Object.assign(new Error('EIO'), { code: 'EIO' }); });
    expect(a.append('s1', [user('u1')])).toBe(1); // no throw: the caller cuts, so the events are never archived twice
    vi.restoreAllMocks();
    expect(String(reports[0])).toContain('EIO');
    expect(a.segment('s1', 1)).toEqual([user('u1')]);
  });

  it('the directory is fsync\'d when the file is created, not on later appends', () => {
    const real = fs.fsyncSync.bind(fs);
    const synced: boolean[] = [];
    vi.spyOn(fs, 'fsyncSync').mockImplementation((fd) => { synced.push(fs.fstatSync(fd).isDirectory()); real(fd); });
    const a = new HistoryArchive({ dir: path.join(dir, 'history') });
    a.append('s1', [user('u1')]);
    expect(synced).toEqual([false, true]);
    a.append('s1', [user('u2')]);
    expect(synced).toEqual([false, true, false]);
  });

  it('a read error other than ENOENT throws: an unreadable archive is never taken for an empty one (no renumbering)', () => {
    const a = new HistoryArchive({ dir });
    a.append('s1', [user('u1')]);
    const f = path.join(dir, 's1.jsonl');
    fs.chmodSync(f, 0o000);
    try {
      expect(() => a.append('s1', [user('u2')])).toThrow(/EACCES/);
      expect(() => a.count('s1')).toThrow(/EACCES/);
    } finally {
      fs.chmodSync(f, 0o600);
    }
    expect(fs.readFileSync(f, 'utf8').split('\n').filter(Boolean)).toHaveLength(1);
  });
});
