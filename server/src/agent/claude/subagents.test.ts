import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { agentIdFromResult, findSubagentMeta } from './subagents.ts';

const dirs: string[] = [];
afterAll(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });
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
    expect(findSubagentMeta(root, SID, 'toolu_A')).toEqual({ agentId: 'a1', toolUseId: 'toolu_A', type: 'general-purpose', description: 'Re-review', running: false });
    expect(findSubagentMeta(root, SID, 'toolu_B')).toMatchObject({ agentId: 'b2', running: true }); // no `finished`: running
  });

  it('a stopped agent is not running; finished:false is running', () => {
    const root = projects({ a1: { toolUseId: 'toolu_A', stoppedByUser: true }, b2: { toolUseId: 'toolu_B', finished: false } });
    expect(findSubagentMeta(root, SID, 'toolu_A')?.running).toBe(false);
    expect(findSubagentMeta(root, SID, 'toolu_B')?.running).toBe(true);
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
