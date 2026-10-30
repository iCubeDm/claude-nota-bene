import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SHELL_OUTPUT_CAP, type ServerEvent } from '@nota-bene/shared';
import type { EmitInput } from '../hub.ts';
import { ShellRunner } from './shell.ts';

let dir: string;
let events: EmitInput[];
let reported: unknown[];
const runners: ShellRunner[] = [];
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nb-shell-')));
  events = [];
  reported = [];
});
afterEach(() => {
  for (const r of runners.splice(0)) r.stopAll();
  fs.rmSync(dir, { recursive: true, force: true });
});

function make(o: Partial<ConstructorParameters<typeof ShellRunner>[0]> = {}) {
  const r = new ShellRunner({ emit: (ev) => void events.push(ev), root: () => dir, report: (_w, e) => void reported.push(e), ...o });
  runners.push(r);
  return r;
}
const ended = (id = 'r1') => events.find((e): e is Extract<ServerEvent, { kind: 'shell-end' }> => e.kind === 'shell-end' && e.id === id);
async function until(cond: () => boolean, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 10));
  }
}
const runToEnd = async (r: ShellRunner, cmd: string, id = 'r1') => {
  expect(r.run(id, cmd)).toBe(true);
  await until(() => !!ended(id));
  return ended(id)!;
};

describe('ShellRunner', () => {
  it('runs a command in the root: start, output, end with the exit code', async () => {
    const r = make();
    const end = await runToEnd(r, 'pwd; echo out; echo err >&2');
    expect(events[0]).toMatchObject({ kind: 'shell-start', id: 'r1', cmd: 'pwd; echo out; echo err >&2' });
    expect(events.filter((e) => e.kind === 'shell-out').map((e) => (e as { text: string }).text).join('')).toBe(end.output);
    expect(end).toMatchObject({ code: 0, truncated: false, cmd: 'pwd; echo out; echo err >&2' });
    expect(end.output).toContain(`${dir}\n`);
    expect(end.output).toMatch(/out\n/);
    expect(end.output).toMatch(/err\n/); // stderr is in the same block
    expect(end.stop).toBeUndefined();
    expect(r.running).toBeNull();
  });

  it('reports a non-zero exit code and nothing else', async () => {
    const end = await runToEnd(make(), 'echo bad >&2; exit 3');
    expect(end).toMatchObject({ code: 3, output: 'bad\n' });
    expect('stop' in end).toBe(false);
    expect('error' in end).toBe(false);
  });

  it('gives the command no stdin: a reader gets EOF at once', async () => {
    const end = await runToEnd(make(), 'cat; echo after');
    expect(end).toMatchObject({ code: 0, output: 'after\n' });
  });

  it('leaves the launcher’s variables out of the environment', async () => {
    process.env.NOTA_BENE_SUPERVISED = '1';
    process.env.NOTA_BENE_LAUNCHER_PID = '4242';
    try {
      const end = await runToEnd(make(), 'echo "[$NOTA_BENE_SUPERVISED][$NOTA_BENE_LAUNCHER_PID][${HOME:+home}]"');
      expect(end.output).toBe('[][][home]\n');
    } finally {
      delete process.env.NOTA_BENE_SUPERVISED;
      delete process.env.NOTA_BENE_LAUNCHER_PID;
    }
  });

  it('strips ANSI escapes from the output', async () => {
    const end = await runToEnd(make(), String.raw`printf '\033[31mred\033[0m \033]0;t\007ok\n'`);
    expect(end.output).toBe('red ok\n');
  });

  it('keeps the last 64 K characters and marks the cut', async () => {
    const end = await runToEnd(make(), `head -c ${SHELL_OUTPUT_CAP * 3} /dev/zero | tr '\\0' x; echo END`);
    expect(end.output.length).toBe(SHELL_OUTPUT_CAP);
    expect(end.truncated).toBe(true);
    expect(end.output.endsWith('xEND\n')).toBe(true);
  });

  it('runs one command at a time', async () => {
    const r = make();
    expect(r.run('r1', 'sleep 30')).toBe(true);
    expect(r.running).toBe('r1');
    expect(r.run('r2', 'echo no')).toBe(false);
    expect(events.filter((e) => e.kind === 'shell-start')).toHaveLength(1);
    r.stop('r1');
    await until(() => !!ended());
    expect(r.run('r2', 'echo yes')).toBe(true); // free again
    await until(() => !!ended('r2'));
  });

  it('stop signals the process group: TERM first, and the command’s own children go too', async () => {
    const r = make();
    r.run('r1', 'sleep 60 & echo $!; wait');
    await until(() => events.some((e) => e.kind === 'shell-out'));
    const child = Number(events.filter((e) => e.kind === 'shell-out').map((e) => (e as { text: string }).text).join('').trim());
    expect(alive(child)).toBe(true);
    r.stop('r1');
    await until(() => !!ended());
    expect(ended()).toMatchObject({ stop: 'user', code: null });
    await until(() => !alive(child));
  });

  it('a command that ignores TERM is killed after the delay', async () => {
    const r = make({ killMs: 150 });
    r.run('r1', "trap '' TERM; echo ready; while :; do sleep 0.05; done");
    await until(() => events.some((e) => e.kind === 'shell-out'));
    const t0 = Date.now();
    r.stop('r1');
    await until(() => !!ended());
    expect(ended()!.stop).toBe('user');
    expect(Date.now() - t0).toBeGreaterThanOrEqual(120);
  });

  it('stopping an id that is not running is no news', async () => {
    const r = make();
    r.stop('nope');
    r.run('r1', 'sleep 30');
    r.stop('other');
    await new Promise((res) => setTimeout(res, 50));
    expect(ended()).toBeUndefined();
    r.stop('r1');
    await until(() => !!ended());
  });

  it('stops a run that exceeds the timeout, with the reason', async () => {
    const r = make({ timeoutMs: 100 });
    r.run('r1', 'echo start; sleep 30');
    await until(() => !!ended());
    expect(ended()).toMatchObject({ stop: 'timeout', code: null });
    expect(ended()!.output).toBe('start\n');
  });

  it('stopAll (a switch, a close) kills the group and says nothing more; the next run may start at once', async () => {
    const r = make();
    r.run('r1', 'echo hi; sleep 60 & echo $!; wait');
    await until(() => events.filter((e) => e.kind === 'shell-out').length > 0);
    await until(() => /\d+\n/.test(events.filter((e) => e.kind === 'shell-out').map((e) => (e as { text: string }).text).join('')));
    const pid = Number(/(\d+)\n/.exec(events.filter((e) => e.kind === 'shell-out').map((e) => (e as { text: string }).text).join(''))![1]);
    r.stopAll();
    expect(r.running).toBeNull();
    expect(r.run('r2', 'echo next')).toBe(true);
    await until(() => !!ended('r2'));
    await until(() => !alive(pid));
    expect(ended('r1')).toBeUndefined(); // the old run never reached the (new) feed
    expect(events.filter((e) => e.kind === 'shell-out' && e.id === 'r1').length).toBeGreaterThan(0);
    expect(r.take('x')).toContain('<bash-input>echo next</bash-input>');
    expect(r.take('x')).toBe('x');
  });

  it('a folder that is not there ends the block with the reason', async () => {
    const end = await runToEnd(make({ root: () => path.join(dir, 'missing') }), 'echo hi');
    expect(end.code).toBeNull();
    expect(end.error).toMatch(/ENOENT/);
    expect(end.output).toBe('');
  });

  it('a background child that keeps the pipes open does not hold the block open', async () => {
    const r = make();
    const t0 = Date.now();
    r.run('r1', 'sleep 20 & echo $!');
    await until(() => !!ended(), 3000);
    expect(Date.now() - t0).toBeLessThan(2500);
    expect(ended()!.code).toBe(0);
    process.kill(Number(ended()!.output.trim()), 'SIGKILL');
  });

  it('a new socket can catch up on the output so far', async () => {
    const r = make();
    expect(r.snapshot()).toBeNull();
    r.run('r1', 'echo one; sleep 30');
    await until(() => events.some((e) => e.kind === 'shell-out'));
    expect(r.snapshot()).toEqual({ id: 'r1', text: 'one\n' });
    r.stop('r1');
    await until(() => !!ended());
    expect(r.snapshot()).toBeNull();
  });
});

describe('what the agent is told', () => {
  it('a finished run is put in front of the next message, once, in Claude Code’s form', async () => {
    const r = make();
    await runToEnd(r, 'echo hi; echo oops >&2');
    expect(r.take('what now?')).toBe('<bash-input>echo hi; echo oops >&2</bash-input>\n<bash-stdout>hi</bash-stdout><bash-stderr>oops</bash-stderr>\n\nwhat now?');
    expect(r.take('again')).toBe('again');
  });

  it('several runs go in the order they ran; a message with no text still carries them', async () => {
    const r = make();
    await runToEnd(r, 'echo a', 'r1');
    await runToEnd(r, 'true', 'r2');
    const t = r.take('');
    expect(t.indexOf('echo a')).toBeLessThan(t.indexOf('<bash-input>true'));
    expect(t.endsWith('<bash-stderr></bash-stderr>')).toBe(true);
    expect(t).toContain('(Bash completed with no output)');
  });

  it('keeps the runs for a message that is not a slash command, so the command still works', async () => {
    const r = make();
    await runToEnd(r, 'echo a');
    expect(r.take('/compact')).toBe('/compact');
    expect(r.take('/clear now')).toBe('/clear now');
    expect(r.take('/usr/bin/env is where?')).toContain('<bash-input>echo a</bash-input>');
  });

  it('a stopped or timed-out run says so, and a switch leaves nothing', async () => {
    const r = make({ timeoutMs: 100 });
    await runToEnd(r, 'echo partial; sleep 30', 'r1');
    expect(r.take('x')).toContain('<bash-stdout>partial</bash-stdout><bash-stderr>[stopped: it ran longer than 10 minutes]</bash-stderr>');
    const r2 = make();
    r2.run('r2', 'sleep 30');
    r2.stop('r2');
    await until(() => !!ended('r2'));
    expect(r2.take('x')).toContain('[stopped by the user]');
  });

  it('dropQueue forgets what waits', async () => {
    const r = make();
    await runToEnd(r, 'echo a');
    r.dropQueue();
    expect(r.take('x')).toBe('x');
  });

  it('keeps at most ten runs, the newest', async () => {
    const r = make();
    for (let i = 0; i < 12; i++) await runToEnd(r, `echo n${i}`, `r${i}`);
    const t = r.take('x');
    expect(t).not.toContain('echo n1<');
    expect(t).toContain('echo n2</bash-input>');
    expect(t).toContain('echo n11</bash-input>');
  });

  it('a cut stream is marked for the agent too', async () => {
    const r = make();
    await runToEnd(r, `head -c ${SHELL_OUTPUT_CAP * 2} /dev/zero | tr '\\0' x`);
    expect(r.take('x')).toContain('[… earlier output cut');
  });
});
