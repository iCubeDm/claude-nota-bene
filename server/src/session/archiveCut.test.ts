import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CLAUDE_CAPABILITIES, type AgentEvent, type ServerEvent } from '@nota-bene/shared';
import type { AgentBackend } from '../agent/types.ts';
import { HistoryArchive } from '../archive.ts';
import { EventHub } from '../hub.ts';
import { createSessionManager } from '../session.ts';

// R-M7-1…3: the server cuts its history at each compaction and archives the part before it, per session id

let home: string;
const prevHome = process.env.NOTA_BENE_HOME;
beforeEach(() => { home = fs.mkdtempSync(path.join(os.tmpdir(), 'nb-archive-cut-')); process.env.NOTA_BENE_HOME = home; });
afterEach(() => {
  if (prevHome === undefined) delete process.env.NOTA_BENE_HOME; else process.env.NOTA_BENE_HOME = prevHome;
  fs.rmSync(home, { recursive: true, force: true });
});

async function until(cond: () => boolean, ms = 2000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** An agent whose events the test pushes; `history` is what a resume replays (the transcript, post-compaction). */
function pushed(history: ServerEvent[] = []) {
  const sends: string[] = [];
  const starts: { resume?: string; fork?: boolean }[] = [];
  let push: (e: AgentEvent) => void = () => {};
  const backend: AgentBackend = {
    capabilities: CLAUDE_CAPABILITIES, listSessions: async () => [], sessionInfo: async () => null,
    history: async () => history,
    start: (o) => {
      starts.push({ ...(o.resume ? { resume: o.resume } : {}), ...(o.fork ? { fork: true } : {}) });
      const q: AgentEvent[] = [];
      let wake: (() => void) | null = null;
      push = (e) => { q.push(e); wake?.(); };
      return {
        messages: (async function* () {
          while (true) {
            while (q.length) yield q.shift()!;
            await new Promise<void>((r) => { wake = r; });
          }
        })(),
        send: (m) => void sends.push(m.uuid),
        interrupt: async () => {}, setPermissionMode: async () => {}, fileSuggestions: async () => [],
        contextUsage: async () => ({ used: 0, max: 1, pct: 0 }), usage: async () => ({ cost: null, limits: null }), close() {},
      };
    },
  };
  return { backend, sends, starts, push: (...es: AgentEvent[]) => { for (const e of es) push(e); } };
}

function hubWithLog() {
  const hub = new EventHub();
  const live: ServerEvent[] = [];
  hub.attach({ send: (d) => void live.push(JSON.parse(d) as ServerEvent) });
  /** what a page that connects now gets */
  const replay = () => {
    let frame: Extract<ServerEvent, { kind: 'replay' }> | undefined;
    hub.attach({ send: (d) => { frame ??= JSON.parse(d) as Extract<ServerEvent, { kind: 'replay' }>; } })();
    return frame!;
  };
  return { hub, live, replay };
}

const archiveAt = () => new HistoryArchive({ dir: path.join(home, 'history') });
const msg = (id: string): AgentEvent => ({ t: 'message', id, text: id });
const compacted: AgentEvent = { t: 'compacted', preTokens: 1000 };
const ofAgent = (evs: ServerEvent[], t: AgentEvent['t']) => evs.filter((e) => e.kind === 'agent' && e.e.t === t);
const has = (evs: ServerEvent[], t: AgentEvent['t'], id?: string) =>
  evs.some((e) => e.kind === 'agent' && e.e.t === t && (id === undefined || (e.e as { id?: string }).id === id));

describe('archive cut at a compaction', () => {
  it('a compaction mid-turn keeps waiting and busy', async () => {
    const { backend, sends, push } = pushed();
    const { hub, live, replay } = hubWithLog();
    const s = await createSessionManager({ hub, backend, cwd: '/proj' });
    push({ t: 'init', sessionId: 'S1' });
    s.send({ id: 'u1', text: 'work' });
    await until(() => sends.length === 1);
    // auto-compact while the agent works: repeated `compacting`, then the boundary, then the turn goes on
    push(msg('m1'), { t: 'compacting' }, { t: 'compacting' }, compacted, msg('m2'));
    await until(() => has(live, 'message', 'm2'));
    expect(s.busy()).toBe(true);
    const r = replay();
    expect(r.earlier).toBe(1);
    // the send still running stays (a reloaded page shows the turn running), then the boundary and what came after
    expect(r.events.filter((e) => e.kind !== 'session')).toMatchObject([
      { kind: 'user', id: 'u1' }, { kind: 'agent', e: compacted }, { kind: 'agent', e: msg('m2') },
    ]);
    expect(r.events.some((e) => e.kind === 'session' && e.id === 'S1')).toBe(true); // the header survives a reload
    const seg = archiveAt().segment('S1', 1)!;
    expect(has(seg, 'message', 'm1')).toBe(true);
    expect(ofAgent(seg, 'compacting')).toHaveLength(2);
    // the running send is in the segment too, the same event (same id) as the hub's copy
    expect(seg.filter((e) => e.kind === 'user')).toEqual(r.events.filter((e) => e.kind === 'user'));
    push({ t: 'turn-end', stop: 'done', secs: 1, answers: ['u1'], queued: 0 });
    await until(() => !s.busy());
    s.close();
  });

  it('a send in flight at a compaction survives a restart: it is in segment 1, the transcript replay has it not', async () => {
    const first = pushed();
    const a = hubWithLog();
    const s1 = await createSessionManager({ hub: a.hub, backend: first.backend, cwd: '/proj' });
    first.push({ t: 'init', sessionId: 'S1' });
    s1.send({ id: 'u1', text: 'work' });
    await until(() => first.sends.length === 1);
    first.push(msg('m1'), compacted, msg('m2'), { t: 'turn-end', stop: 'done', secs: 1, answers: ['u1'], queued: 0 });
    await until(() => !s1.busy());
    s1.close();
    const next = pushed([{ kind: 'user', id: 't1', text: 'summary', historic: true, ts: 0 }]); // from the compaction on
    const b = hubWithLog();
    const s2 = await createSessionManager({ hub: b.hub, backend: next.backend, cwd: '/proj', resume: 'S1' });
    expect(b.replay().events.some((e) => e.kind === 'user' && e.id === 'u1')).toBe(false);
    expect(b.replay().earlier).toBe(1);
    expect(archiveAt().segment('S1', 1)!.filter((e) => e.kind === 'user')).toMatchObject([{ id: 'u1', text: 'work' }]);
    s2.close();
  });

  it('two compactions in one turn give segments 1 and 2 with no event in both', async () => {
    const { backend, sends, push } = pushed();
    const { hub, live } = hubWithLog();
    const s = await createSessionManager({ hub, backend, cwd: '/proj' });
    push({ t: 'init', sessionId: 'S1' });
    s.send({ id: 'u1', text: 'work' });
    await until(() => sends.length === 1);
    push(msg('m1'), compacted, msg('m2'), { t: 'compacted', preTokens: 2000 }, msg('m3'));
    await until(() => has(live, 'message', 'm3'));
    const one = archiveAt().segment('S1', 1)!;
    const two = archiveAt().segment('S1', 2)!;
    const key = (e: ServerEvent) => JSON.stringify(e);
    expect(one.map(key).filter((k) => two.map(key).includes(k))).toEqual([]);
    expect(one.some((e) => e.kind === 'user' && e.id === 'u1')).toBe(true);
    expect(two.some((e) => e.kind === 'user')).toBe(false);
    expect(has(two, 'message', 'm2')).toBe(true);
    // the turn ends, a third compaction: u1 is dropped from the hub and written nowhere again
    push({ t: 'turn-end', stop: 'done', secs: 1, answers: ['u1'], queued: 0 }, msg('m4'), compacted);
    await until(() => archiveAt().count('S1') === 3);
    expect(archiveAt().segment('S1', 3)!.some((e) => e.kind === 'user')).toBe(false);
    s.close();
  });

  it('a task running at a compaction still shows after a reload', async () => {
    const { backend, sends, push } = pushed();
    const { hub, live, replay } = hubWithLog();
    const s = await createSessionManager({ hub, backend, cwd: '/proj' });
    push({ t: 'init', sessionId: 'S1' });
    s.send({ id: 'u1', text: 'work' });
    await until(() => sends.length === 1);
    push({ t: 'task', id: 'bg', phase: 'started', desc: 'build' }, { t: 'task', id: 'quick', phase: 'started' },
      { t: 'task', id: 'quick', phase: 'done' }, compacted, msg('m2'));
    await until(() => has(live, 'message', 'm2'));
    const tasks = replay().events.filter((e) => e.kind === 'agent' && e.e.t === 'task').map((e) => (e as { e: { id: string } }).e.id);
    expect(tasks).toEqual(['bg']);
    expect(ofAgent(archiveAt().segment('S1', 1)!, 'task')).toHaveLength(3);
    s.close();
  });

  it('a /compact: its own user event goes to the archive, the boundary is first after the header', async () => {
    const { backend, sends, push } = pushed();
    const { hub, replay } = hubWithLog();
    const s = await createSessionManager({ hub, backend, cwd: '/proj' });
    push({ t: 'init', sessionId: 'S1' });
    s.send({ id: 'u1', text: 'hi' });
    await until(() => sends.length === 1);
    push(msg('m1'), { t: 'turn-end', stop: 'done', secs: 1, answers: ['u1'], queued: 0 });
    await until(() => !s.busy());
    s.command('compact');
    await until(() => sends.length === 2);
    push({ t: 'compacting' }, compacted);
    await until(() => replay().earlier === 1);
    // the /compact itself is still running (its result has not come): kept like a running send, so a reload shows busy
    expect(replay().events.filter((e) => e.kind !== 'session')).toMatchObject([{ kind: 'user', text: '/compact' }, { kind: 'agent', e: compacted }]);
    expect(archiveAt().segment('S1', 1)!.filter((e) => e.kind === 'user').map((e) => (e as { text: string }).text)).toEqual(['hi', '/compact']);
    s.close();
  });

  it('restart after a compaction replays the transcript with earlier = count', async () => {
    const transcript: ServerEvent[] = [{ kind: 'user', id: 't1', text: 'after', historic: true, ts: 0 }];
    const first = pushed(transcript);
    const a = hubWithLog();
    const s1 = await createSessionManager({ hub: a.hub, backend: first.backend, cwd: '/proj' });
    first.push({ t: 'init', sessionId: 'S1' }, msg('m1'), compacted, msg('m2'), compacted, msg('m3'));
    await until(() => has(a.live, 'message', 'm3'));
    expect(archiveAt().count('S1')).toBe(2);
    s1.close();
    // the server restarts: a new manager resumes S1 (--continue); its replay is the transcript, from the compaction on
    const next = pushed(transcript);
    const b = hubWithLog();
    const s2 = await createSessionManager({ hub: b.hub, backend: next.backend, cwd: '/proj', resume: 'S1' });
    const r = b.replay();
    expect(r.earlier).toBe(2);
    expect(r.events).toMatchObject([{ kind: 'user', id: 't1' }, { kind: 'resumed', id: 'S1' }, { kind: 'session', id: 'S1' }]);
    s2.close();
  });

  it('/clear replays with no earlier', async () => {
    const S1 = '11111111-1111-4111-8111-111111111111';
    const S2 = '22222222-2222-4222-8222-222222222222';
    const { backend, push } = pushed();
    const { hub, live, replay } = hubWithLog();
    const s = await createSessionManager({ hub, backend, cwd: '/proj' });
    push({ t: 'init', sessionId: S1 }, msg('m1'), compacted);
    await until(() => replay().earlier === 1);
    push({ t: 'reset', newId: S2 });
    await until(() => live.some((e) => e.kind === 'session' && e.id === S2));
    expect(replay().earlier).toBeUndefined();
    // a compaction of the new conversation goes under the new id; the old id's archive stays (R-M7-3)
    push(msg('m2'), compacted);
    await until(() => replay().earlier === 1);
    expect(has(archiveAt().segment(S2, 1)!, 'message', 'm2')).toBe(true);
    expect(archiveAt().count(S1)).toBe(1);
    s.close();
  });

  it('a /clear that names no new id archives nothing until an init names it (never under the cleared id)', async () => {
    const { backend, push } = pushed();
    const { hub, live: log, replay } = hubWithLog();
    const s = await createSessionManager({ hub, backend, cwd: '/proj' });
    push({ t: 'init', sessionId: 'S1' }, msg('m1'), compacted);
    await until(() => replay().earlier === 1);
    push({ t: 'reset' }, msg('m2'), compacted, msg('m3'));
    await until(() => has(log, 'message', 'm3'));
    expect(archiveAt().count('S1')).toBe(1);
    expect(s.archiveId()).toBeNull(); // /history answers 409 for the cleared id meanwhile
    push({ t: 'init', sessionId: 'S3' }, compacted);
    await until(() => replay().earlier === 1);
    expect(s.archiveId()).toBe('S3');
    expect(has(archiveAt().segment('S3', 1)!, 'message', 'm2')).toBe(true);
    s.close();
  });

  it('a fork archives nothing until its own id is known (the id until then is the source\'s)', async () => {
    const { backend, push } = pushed();
    const { hub, live, replay } = hubWithLog();
    const s = await createSessionManager({ hub, backend, cwd: '/proj', resume: 'S0', fork: true });
    push(msg('m0'), compacted, msg('m1'));
    await until(() => has(live, 'message', 'm1'));
    expect(archiveAt().count('S0')).toBe(0);
    expect(replay().earlier).toBeUndefined();
    expect(s.archiveId()).toBeNull();
    push({ t: 'init', sessionId: 'F1' }, msg('m2'), compacted);
    await until(() => replay().earlier === 1);
    expect(archiveAt().count('F1')).toBe(1);
    s.close();
  });

  it('an archive that cannot be written is reported, the history stays whole, and the pump goes on', async () => {
    fs.writeFileSync(path.join(home, 'history'), 'not a dir'); // every write fails with ENOTDIR / EEXIST
    const { backend, push } = pushed();
    const { hub, live, replay } = hubWithLog();
    const s = await createSessionManager({ hub, backend, cwd: '/proj' });
    push({ t: 'init', sessionId: 'S1' }, msg('m1'), compacted, msg('m2'));
    await until(() => has(live, 'message', 'm2'));
    expect(live.some((e) => e.kind === 'server-error' && e.where === 'archive')).toBe(true);
    const r = replay();
    expect(r.earlier).toBeUndefined();
    expect(has(r.events, 'message', 'm1')).toBe(true);
    s.close();
  });
});
