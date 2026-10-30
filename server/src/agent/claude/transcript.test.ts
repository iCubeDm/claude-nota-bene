import fs from 'node:fs';
import type { SessionMessage } from '@anthropic-ai/claude-agent-sdk';
import { afterAll, describe, expect, it } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { AttachmentStore } from '../../attachments.ts';
import { transcriptToEvents } from './transcript.ts';

const dirs: string[] = [];
const tmpDir = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'nb-tr-'));
  dirs.push(d);
  return d;
};
afterAll(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});
const store = (dir = tmpDir()) => new AttachmentStore({ dir });

const msgs = JSON.parse(
  fs.readFileSync(new URL('../../../test/fixtures/transcript.json', import.meta.url), 'utf8'),
) as SessionMessage[];

describe('transcriptToEvents', () => {
  it('maps assistant messages to message and tool-call events, ids as the live mapper makes them', () => {
    const agent = transcriptToEvents(msgs, store()).filter((e) => e.kind === 'agent' && (e.e.t === 'message' || e.e.t === 'tool-call'));
    expect(agent).toEqual([
      { kind: 'agent', ts: 0, e: { t: 'message', id: 'a1:0', text: 'Reading it.' } },
      { kind: 'agent', ts: 0, e: { t: 'tool-call', id: 'tool-1', name: 'Read', input: { file_path: 'notes.md' }, sub: false } },
      { kind: 'agent', ts: 0, e: { t: 'message', id: 'a2:0', text: 'The file says hello.' } },
    ]);
  });

  it('tool_result user turns are never bubbles', () => {
    const events = transcriptToEvents(msgs, store());
    expect(events.some((e) => e.kind === 'user' && e.id === 'u2')).toBe(false);
  });

  it('transcript replay attaches tool results', () => {
    const events = transcriptToEvents(msgs, store());
    expect(events.filter((e) => e.kind === 'agent' && e.e.t === 'tool-update')).toEqual([
      { kind: 'agent', ts: 0, e: { t: 'tool-update', id: 'tool-1', text: 'hello', isError: false } },
    ]);
  });

  it('replay strips base64 from tool_result images', () => {
    const big = { type: 'image', source: { type: 'base64', data: 'AAAA' } };
    const m = [{
      type: 'user', uuid: 'ux', parent_tool_use_id: null,
      message: { content: [{ type: 'tool_result', tool_use_id: 't', content: [{ type: 'text', text: 'k' }, big] }] },
    }] as unknown as SessionMessage[];
    const [ev] = transcriptToEvents(m, store());
    expect(ev).toEqual({ kind: 'agent', ts: 0, e: { t: 'tool-update', id: 't', text: 'k\n[image]', isError: false } });
    expect(JSON.stringify(ev)).not.toContain('AAAA');
  });

  it('user text becomes historic user events in order', () => {
    const events = transcriptToEvents(msgs, store());
    expect(events.map((e) => (e.kind === 'user' ? e.id : e.kind === 'agent' ? e.e.t : e.kind)))
      .toEqual(['u1', 'message', 'tool-call', 'tool-update', 'message', 'u3']);
    expect(events.filter((e) => e.kind === 'user')).toEqual([
      { kind: 'user', id: 'u1', text: 'Read notes.md', historic: true, ts: 0 },
      { kind: 'user', id: 'u3', text: 'Thanks', historic: true, ts: 0 },
    ]);
  });

  it('an inline image becomes an ImageRef, stored once, with its label removed from the text', () => {
    const dir = tmpDir();
    const png = Buffer.from('not really a png');
    const m = [{
      type: 'user', uuid: 'ui', parent_tool_use_id: null,
      message: { content: [
        { type: 'text', text: 'look at this' },
        { type: 'text', text: '[Comment 1]' },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: png.toString('base64') } },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: png.toString('base64') } },
      ] },
    }] as unknown as SessionMessage[];
    const [ev] = transcriptToEvents(m, store(dir));
    expect(ev).toMatchObject({
      kind: 'user', id: 'ui', text: 'look at this', historic: true,
      images: [{ mediaType: 'image/png', label: '[Comment 1]' }, { mediaType: 'image/png', label: '[image]' }],
    });
    const id = (ev as { images: { id: string }[] }).images[0]!.id;
    expect(fs.readdirSync(dir)).toEqual([`${id}.png`]);
    expect(JSON.stringify(ev)).not.toContain(png.toString('base64'));
  });

  it('a plain one-line prompt before an image is not a label', () => {
    const m = [{
      type: 'user', uuid: 'up', parent_tool_use_id: null,
      message: { content: [
        { type: 'text', text: 'what is this?' },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: Buffer.from('x').toString('base64') } },
      ] },
    }] as unknown as SessionMessage[];
    expect(transcriptToEvents(m, store())[0]).toMatchObject({ text: 'what is this?', images: [{ label: '[image]' }] });
  });

  it('a failing put keeps every bubble, drops the image and reports once', () => {
    const boom = { put: () => { throw new Error('disk full'); } } as unknown as AttachmentStore;
    const img = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } };
    const user = (uuid: string, text: string) => ({ type: 'user', uuid, parent_tool_use_id: null, message: { content: [{ type: 'text', text }, img, img] } });
    const errors: unknown[] = [];
    const evs = transcriptToEvents([user('a', 'one'), user('b', 'two')] as unknown as SessionMessage[], boom, (e) => errors.push(e));
    expect(evs.map((e) => (e.kind === 'user' ? e.text : ''))).toEqual(['one', 'two']);
    expect(evs.every((e) => e.kind === 'user' && e.images === undefined)).toBe(true);
    expect(errors).toHaveLength(1);
  });
});

describe('transcriptToEvents of a subagent', () => {
  // getSubagentMessages tags every message with the Agent call's id
  const P = 'toolu_parent';
  const sub = [
    { type: 'user', uuid: 's-u1', parent_tool_use_id: P, message: { role: 'user', content: 'Scoped re-review please' } },
    { type: 'user', uuid: 's-u2', parent_tool_use_id: P, message: { role: 'user', content: '<system-reminder>\nhand back via X\n</system-reminder>' } },
    { type: 'assistant', uuid: 's-a1', parent_tool_use_id: P, message: { role: 'assistant', content: [{ type: 'text', text: 'Looking.' }, { type: 'tool_use', id: 'toolu_in1', name: 'Read', input: { file_path: 'a.md' } }] } },
    { type: 'user', uuid: 's-u3', parent_tool_use_id: P, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_in1', content: 'hello' }] } },
    { type: 'assistant', uuid: 's-a2', parent_tool_use_id: P, message: { role: 'assistant', content: [{ type: 'text', text: 'Done.' }] } },
  ] as unknown as SessionMessage[];

  it('the subagent view gets its own text, tool calls and results', () => {
    const evs = transcriptToEvents(sub, store(), undefined, { subagent: true });
    expect(evs.map((e) => (e.kind === 'user' ? `user:${e.id}` : e.kind === 'agent' ? e.e.t : e.kind))).toEqual(['user:s-u1', 'message', 'tool-call', 'tool-update', 'message']);
    expect(evs.find((e) => e.kind === 'agent' && e.e.t === 'tool-call')).toMatchObject({ e: { id: 'toolu_in1', sub: false } });
    expect(evs.find((e) => e.kind === 'agent' && e.e.t === 'message')).toMatchObject({ e: { id: 's-a1:0', text: 'Looking.' } });
  });

  it('the main feed output for the same frames is unchanged: nested text and bubbles stay out', () => {
    const evs = transcriptToEvents(sub, store());
    expect(evs.map((e) => (e.kind === 'agent' ? `${e.e.t}${e.e.t === 'tool-call' ? `:sub=${e.e.sub}` : ''}` : e.kind))).toEqual(['tool-call:sub=true']);
  });
});

describe('transcriptToEvents: slash commands', () => {
  const user = (uuid: string, text: string) => ({ type: 'user', uuid, session_id: 's', parent_tool_use_id: null, parent_agent_id: null, message: { role: 'user', content: text } }) as unknown as SessionMessage;

  it('a command\'s record is the line the user typed, not the CLI\'s tags', () => {
    const events = transcriptToEvents([
      user('c1', '<command-message>hello</command-message>\n<command-name>/hello</command-name>\n<command-args>world</command-args>'),
      user('c2', '<command-name>/context</command-name>\n            <command-message>context</command-message>\n            <command-args></command-args>'),
    ], store());
    expect(events).toEqual([
      { kind: 'user', id: 'c1', text: '/hello world', historic: true, ts: 0 },
      { kind: 'user', id: 'c2', text: '/context', historic: true, ts: 0 },
    ]);
  });

  it('a local command\'s output is a reply; an empty one is nothing', () => {
    const events = transcriptToEvents([
      user('o1', '<local-command-stdout>## Context Usage\n\n4%</local-command-stdout>'),
      user('o2', '<local-command-stdout></local-command-stdout>'),
    ], store());
    expect(events).toEqual([{ kind: 'agent', ts: 0, e: { t: 'message', id: 'o1:out', text: '## Context Usage\n\n4%' } }]);
  });

  it('a message that merely contains the tags is the user\'s text, not a command', () => {
    const text = 'why does <command-name>/foo</command-name> show up in the log?\nand <command-args>x</command-args>';
    expect(transcriptToEvents([user('t1', text)], store())).toEqual([{ kind: 'user', id: 't1', text, historic: true, ts: 0 }]);
    const out = 'look: <local-command-stdout>hi</local-command-stdout>';
    expect(transcriptToEvents([user('t2', out)], store())).toEqual([{ kind: 'user', id: 't2', text: out, historic: true, ts: 0 }]);
  });

  it('the CLI\'s local-command caveat is never a bubble', () => {
    expect(transcriptToEvents([user('v1', '<local-command-caveat>The command below was run directly in Claude Code.</local-command-caveat>')], store())).toEqual([]);
  });
});

describe('transcriptToEvents: the `! cmd` runs in front of a message', () => {
  const user = (uuid: string, text: string) => ({ type: 'user', uuid, session_id: 's', parent_tool_use_id: null, parent_agent_id: null, message: { role: 'user', content: text } }) as unknown as SessionMessage;
  const block = (cmd: string, out: string, err = '') => `<bash-input>${cmd}</bash-input>\n<bash-stdout>${out}</bash-stdout><bash-stderr>${err}</bash-stderr>`;

  it('become shell blocks again, then the message without them', () => {
    const events = transcriptToEvents([user('m1', `${block('git status', 'clean')}\n\n${block('false', '', 'no')}\n\nand now?`)], store());
    expect(events).toEqual([
      { kind: 'shell-start', id: 'm1:sh0', cmd: 'git status', ts: 0 },
      { kind: 'shell-end', id: 'm1:sh0', cmd: 'git status', output: 'clean', truncated: false, code: null, ts: 0 },
      { kind: 'shell-start', id: 'm1:sh1', cmd: 'false', ts: 0 },
      { kind: 'shell-end', id: 'm1:sh1', cmd: 'false', output: 'no', truncated: false, code: null, ts: 0 },
      { kind: 'user', id: 'm1', text: 'and now?', historic: true, ts: 0 },
    ]);
  });

  it('a message that was only runs has no bubble', () => {
    const events = transcriptToEvents([user('m2', block('true', '(Bash completed with no output)'))], store());
    expect(events.map((e) => e.kind)).toEqual(['shell-start', 'shell-end']);
    expect(events[1]).toMatchObject({ output: '' });
  });

  it('also for a message that carries images', () => {
    const png = 'iVBORw0KGgo=';
    const m = { type: 'user', uuid: 'm3', session_id: 's', parent_tool_use_id: null, parent_agent_id: null, message: { role: 'user', content: [
      { type: 'text', text: `${block('ls', 'a')}\n\nlook at this` },
      { type: 'text', text: '[Image 1]' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: png } },
    ] } } as unknown as SessionMessage;
    const events = transcriptToEvents([m], store());
    expect(events.map((e) => e.kind)).toEqual(['shell-start', 'shell-end', 'user']);
    expect(events[2]).toMatchObject({ kind: 'user', text: 'look at this', images: [{ label: '[Image 1]' }] });
  });

  it('only the exact form at the very start counts', () => {
    const text = `see this:\n\n${block('ls', 'a')}`;
    expect(transcriptToEvents([user('m4', text)], store())).toEqual([{ kind: 'user', id: 'm4', text, historic: true, ts: 0 }]);
  });
});

