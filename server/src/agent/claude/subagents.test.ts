import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { agentIdFromResult, findSubagentMeta, isRunning, noMetaAdd, noMetaHas, NO_META_TTL_MS, RECENT_MS, resetSubagentCache } from './subagents.ts';

const dirs: string[] = [];
afterAll(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });
beforeEach(resetSubagentCache);
const SID = 'a1b2c3d4-0000-4000-8000-000000000001';

function projects(metas: Record<string, unknown>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nb-sa-'));
  dirs.push(root);
  const sub = path.join(root, '-some-project', SID, 'subagents');
  fs.mkdirSync(sub, { recursive: true });
  for (const [agent, meta] of Object.entries(metas)) fs.writeFileSync(path.join(sub, `agent-${agent}.meta.json`), typeof meta === 'string' ? meta : JSON.stringify(meta));
  return root;
}

describe('findSubagentMeta', () => {
  it('finds the agent of a tool-use id, with type, description and running from finished', () => {
    const root = projects({
      a1: { agentType: 'general-purpose', description: 'Re-review', toolUseId: 'toolu_A', finished: true },
      b2: { agentType: 'Explore', description: 'Look around', toolUseId: 'toolu_B' },
    });
    expect(findSubagentMeta(root, SID, 'toolu_A')).toMatchObject({ agentId: 'a1', toolUseId: 'toolu_A', type: 'general-purpose', description: 'Re-review', unfinished: false });
    expect(findSubagentMeta(root, SID, 'toolu_B')).toMatchObject({ agentId: 'b2', unfinished: true }); // no `finished`: not proof of anything
  });

  it('a stopped agent is not running; finished:false is running', () => {
    const root = projects({ a1: { toolUseId: 'toolu_A', stoppedByUser: true }, b2: { toolUseId: 'toolu_B', finished: false } });
    expect(findSubagentMeta(root, SID, 'toolu_A')?.unfinished).toBe(false);
    expect(findSubagentMeta(root, SID, 'toolu_B')?.unfinished).toBe(true);
  });

  it('null for an unknown tool id, a torn meta, another session or a missing projects dir', () => {
    const root = projects({ a1: { toolUseId: 'toolu_A' }, torn: '{"toolUseId":"toolu_T"' });
    expect(findSubagentMeta(root, SID, 'toolu_nope')).toBeNull();
    expect(findSubagentMeta(root, SID, 'toolu_T')).toBeNull();
    expect(findSubagentMeta(root, '11111111-1111-4111-8111-111111111111', 'toolu_A')).toBeNull();
    expect(findSubagentMeta(path.join(root, 'absent'), SID, 'toolu_A')).toBeNull();
  });

  it('path pieces in either id never reach the filesystem', () => {
    const root = projects({ a1: { toolUseId: 'toolu_A' } });
    expect(findSubagentMeta(root, '../x', 'toolu_A')).toBeNull();
    expect(findSubagentMeta(root, `${SID}/../${SID}`, 'toolu_A')).toBeNull();
    expect(findSubagentMeta(root, SID, '../toolu_A')).toBeNull();
  });

  it('a meta file name that is not agent-<alnum> is ignored', () => {
    const root = projects({ 'a1': { toolUseId: 'toolu_A' } });
    fs.writeFileSync(path.join(root, '-some-project', SID, 'subagents', 'agent-..x.meta.json'), JSON.stringify({ toolUseId: 'toolu_X' }));
    expect(findSubagentMeta(root, SID, 'toolu_X')).toBeNull();
  });
});

describe('agentIdFromResult', () => {
  it('reads the agentId line of the Agent tool result', () => {
    expect(agentIdFromResult('Async agent launched successfully.\nagentId: a192f80c2c19747db (internal ID)')).toBe('a192f80c2c19747db');
    expect(agentIdFromResult('nothing here')).toBeNull();
  });
});

import { toolCallIn } from './subagents.ts';
describe('toolCallIn', () => {
  const msgs = [
    { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'toolu_A', name: 'Agent', input: { description: 'd', subagent_type: 'Explore' } }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_A', content: [{ type: 'text', text: 'agentId: abc123' }] }] } },
  ];
  it('gives the input and the result text; no result yet is undefined; unknown is null', () => {
    expect(toolCallIn(msgs, 'toolu_A')).toEqual({ input: { description: 'd', subagent_type: 'Explore' }, result: 'agentId: abc123' });
    expect(toolCallIn(msgs.slice(0, 1), 'toolu_A')).toEqual({ input: { description: 'd', subagent_type: 'Explore' } });
    expect(toolCallIn(msgs, 'toolu_Z')).toBeNull();
  });
});

describe('isRunning', () => {
  const now = 1_000_000_000;
  it('a meta without `finished`, no live task, an old transcript: not running (the review\'s stuck case)', () => {
    expect(isRunning({ unfinished: true, modified: now - RECENT_MS - 1 }, false, now)).toBe(false);
  });
  it('running with a live task, or with a transcript written a moment ago', () => {
    expect(isRunning({ unfinished: true, modified: 0 }, true, now)).toBe(true);
    expect(isRunning({ unfinished: true, modified: now - 5_000 }, false, now)).toBe(true);
  });
  it('finished or stopped is never running, whatever else says', () => {
    expect(isRunning({ unfinished: false, modified: now }, true, now)).toBe(false);
  });
});

describe('the lookup is cached', () => {
  it('after a hit only the matching meta is read; a miss is not rescanned within the poll interval, then is', () => {
    const root = projects({ a1: { toolUseId: 'toolu_A' } });
    expect(findSubagentMeta(root, SID, 'toolu_A')?.agentId).toBe('a1');
    fs.writeFileSync(path.join(root, '-some-project', SID, 'subagents', 'agent-b2.meta.json'), JSON.stringify({ toolUseId: 'toolu_N' }));
    expect(findSubagentMeta(root, SID, 'toolu_N', 1000)?.agentId).toBe('b2');
    expect(findSubagentMeta(root, SID, 'toolu_late', 1000)).toBeNull();
    fs.writeFileSync(path.join(root, '-some-project', SID, 'subagents', 'agent-c3.meta.json'), JSON.stringify({ toolUseId: 'toolu_late' }));
    expect(findSubagentMeta(root, SID, 'toolu_late', 1500)).toBeNull(); // 500 ms later: still the remembered miss
    expect(findSubagentMeta(root, SID, 'toolu_late', 3000)?.agentId).toBe('c3');
  });
});

describe('the no-meta miss', () => {
  it('is remembered for a few seconds, then tried again; a different key is not affected', () => {
    resetSubagentCache();
    noMetaAdd('s\0t\0', 1000);
    expect(noMetaHas('s\0t\0', 1000 + NO_META_TTL_MS - 1)).toBe(true);
    expect(noMetaHas('s\0u\0', 1000)).toBe(false);
    expect(noMetaHas('s\0t\0', 1000 + NO_META_TTL_MS)).toBe(false);
    expect(noMetaHas('s\0t\0', 1000)).toBe(false); // dropped once expired
  });
  it('expired entries are dropped when a new one is added, and reset clears all', () => {
    resetSubagentCache();
    noMetaAdd('a', 0);
    noMetaAdd('b', NO_META_TTL_MS + 1);
    expect(noMetaHas('a', 1)).toBe(false);
    expect(noMetaHas('b', NO_META_TTL_MS + 2)).toBe(true);
    resetSubagentCache();
    expect(noMetaHas('b', NO_META_TTL_MS + 2)).toBe(false);
  });
});
