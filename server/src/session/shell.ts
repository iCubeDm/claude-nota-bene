import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { ShellStop } from '@nota-bene/shared';
import type { EmitInput } from '../hub.ts';
import { AGENT_STREAM_CAP, AnsiStripper, Tail, bashBlock, isSlashCommand, leadOf, shellEnv } from './shellText.ts';

/** a command that runs longer is stopped, with the reason shown */
export const SHELL_TIMEOUT_MS = 10 * 60_000;
/** after TERM, the process group gets this long before KILL */
export const SHELL_KILL_MS = 3000;
/** after the shell exits, a background child that still holds the pipes does not hold the block open longer than this */
const PIPE_GRACE_MS = 300;
/** the output goes to the sockets at most this often: one frame of the tail per tick, however much the command prints */
export const SHELL_FLUSH_MS = 100;
/** how many finished runs wait for the agent's next message; the oldest go first */
const QUEUE_MAX = 10;
/** shells that take `-lc -- cmd` like sh does (fish is left out: that form is untested there); any other $SHELL (csh, tcsh, fish, nologin, false) is not used, /bin/sh runs the command */
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh']);
/** how often a group that was sent TERM is looked at: once it is empty the KILL is cancelled, its id may be reused */
const POLL_MS = 150;

type Run = {
  id: string; cmd: string; child?: ChildProcess;
  out: Tail; err: Tail; all: Tail; ansiOut: AnsiStripper; ansiErr: AnsiStripper;
  stop?: ShellStop | 'switch';
  /** a switch, a /clear or a close stopped it: it says nothing more to the feed and leaves nothing for the agent */
  quiet: boolean;
  exit?: { code: number | null; signal: NodeJS.Signals | null };
  error?: string;
  timers: ReturnType<typeof setTimeout>[];
  /** the KILL that follows a TERM: it outlives the run's end, a child that ignored TERM must not be left behind */
  killTimer?: ReturnType<typeof setTimeout>;
  /** polls whether the group is gone, to cancel the KILL (a pgid may be recycled) */
  poll?: ReturnType<typeof setInterval>;
  /** a flush of the output is scheduled */
  flush?: ReturnType<typeof setTimeout>;
  done: boolean;
};

type Options = {
  emit: (ev: EmitInput, o?: { store?: boolean; lossy?: boolean }) => void;
  /** the project folder now (it moves with a switch) */
  root: () => string;
  report: (where: string, e: unknown) => void;
  /** tests shorten the timeout and the kill delay, and stub the environment */
  timeoutMs?: number;
  killMs?: number;
  env?: () => NodeJS.ProcessEnv;
};

// every live process group is killed when this process exits, however it exits (exitWith, a signal handler, a crash handler
// that calls process.exit): a command must not outlive the server. Only a SIGKILL of the server itself is beyond this.
const live = new Set<Run>();
let exitHooked = false;
function killAllOnExit(): void {
  if (exitHooked) return;
  exitHooked = true;
  process.on('exit', () => {
    for (const r of live) signalGroup(r, 'SIGKILL');
  });
}

function signalGroup(r: Run, sig: NodeJS.Signals | 0): boolean {
  const pid = r.child?.pid;
  if (pid === undefined) return false;
  try {
    process.kill(-pid, sig); // the group the child leads (spawn detached): its own children go with it
    return true;
  } catch {
    return false; // gone already
  }
}

const shellPath = (): string => {
  const s = process.env.SHELL;
  if (s && s.startsWith('/') && SHELLS.has(path.basename(s))) {
    try {
      fs.accessSync(s, fs.constants.X_OK);
      return s;
    } catch { /* fall through */ }
  }
  return '/bin/sh';
};

/**
 * The window's `! cmd` runs (protocol 11): one at a time, outside the agent. `$SHELL -lc cmd` in the project folder, stdin
 * /dev/null, its own process group, the launcher's variables left out. The run is a block in the feed: `shell-start` (stored),
 * the output so far (`shell-out`, live, the whole tail at most ten times a second), `shell-end` (stored, with the last 64 K
 * characters). A finished run is also queued for the agent: `take` puts the queued runs, as Claude Code writes them, in front
 * of the next message. A stop (the user's, the timeout) signals the group: TERM, then KILL; when the shell ends the rest of its
 * group is stopped the same way, so background jobs end with the command. A switch, a /clear or a close does the same quietly,
 * and the queue is the session manager's to drop.
 */
export class ShellRunner {
  private current: Run | null = null;
  private queue: string[] = [];
  private readonly o: Required<Pick<Options, 'timeoutMs' | 'killMs'>> & Options;

  constructor(o: Options) {
    this.o = { timeoutMs: SHELL_TIMEOUT_MS, killMs: SHELL_KILL_MS, ...o };
  }

  /** The id of the run in progress, if any. */
  get running(): string | null {
    return this.current?.id ?? null;
  }

  /** false: one is running already, nothing started. */
  run(id: string, cmd: string): boolean {
    if (this.current) return false;
    const ansiOut = new AnsiStripper();
    const ansiErr = new AnsiStripper();
    const run: Run = {
      id, cmd, out: new Tail(AGENT_STREAM_CAP), err: new Tail(AGENT_STREAM_CAP), all: new Tail(), ansiOut, ansiErr, quiet: false, timers: [], done: false,
    };
    this.current = run;
    this.o.emit({ kind: 'shell-start', id, cmd });
    let child: ChildProcess;
    try {
      // `--` ends the shell's own options: a command such as `--version` is a command, not a flag
      child = spawn(shellPath(), ['-lc', '--', cmd], {
        cwd: this.o.root(), env: (this.o.env ?? (() => shellEnv(process.env)))(), stdio: ['ignore', 'pipe', 'pipe'], detached: true,
      });
    } catch (e) {
      // a spawn that throws at once (a bad env value): the block ends with the reason
      run.error = e instanceof Error ? e.message : String(e);
      this.finish(run);
      return true;
    }
    run.child = child;
    live.add(run);
    killAllOnExit();
    child.stdout!.setEncoding('utf8');
    child.stderr!.setEncoding('utf8');
    // always drained, whatever the sockets do: the tails stay current and the command is never held up by us
    child.stdout!.on('data', (c: string) => this.collect(run, ansiOut.push(c), run.out));
    child.stderr!.on('data', (c: string) => this.collect(run, ansiErr.push(c), run.err));
    child.stdout!.on('error', () => {});
    child.stderr!.on('error', () => {});
    // 'error': it could not start (no such folder, no shell) or a kill failed; without a pid nothing ran and no 'exit' follows
    child.on('error', (e) => {
      if (child.pid === undefined) {
        run.error = e.message;
        this.finish(run);
      } else this.o.report('shell', e);
    });
    child.on('exit', (code, signal) => {
      run.exit = { code, signal };
      this.signalRest(run); // the shell is gone: what it left in the group (background jobs) goes with it
      run.timers.push(setTimeout(() => this.finish(run), PIPE_GRACE_MS));
    });
    child.on('close', () => this.finish(run));
    run.timers.push(setTimeout(() => this.terminate(run, 'timeout'), this.o.timeoutMs));
    return true;
  }

  /** The user's stop; an id that is not the running one is no news. */
  stop(id: string): void {
    if (this.current?.id === id) this.terminate(this.current, 'user');
  }

  /** A switch, a /clear or a close: stop the run, and let it say nothing more. The next run may start at once. */
  stopAll(): void {
    const r = this.current;
    if (!r) return;
    r.quiet = true;
    this.current = null;
    clearTimeout(r.flush);
    this.terminate(r, 'switch');
  }

  /** What the agent is told of the runs finished since its last message, in front of `text`; `text` itself when there are none, or when a slash command (a block before it would stop it being one). */
  take(text: string): string {
    return this.takeFor(text).text;
  }

  /** `take`, with a way back: `restore` puts the runs it took where they were (the hand-over to the agent failed). */
  takeFor(text: string): { text: string; restore(): void } {
    if (!this.queue.length || isSlashCommand(text)) return { text, restore() {} };
    const taken = this.queue;
    this.queue = [];
    const lead = leadOf(taken);
    return { text: text ? `${lead}\n\n${text}` : lead, restore: () => { this.queue = [...taken, ...this.queue].slice(-QUEUE_MAX); } };
  }

  /** Forget the runs waiting for the agent (a new session: they belong to the old conversation). */
  dropQueue(): void {
    this.queue = [];
  }

  /** The output so far of the run in progress, for a socket that attached meanwhile. */
  snapshot(): { id: string; text: string; truncated: boolean } | null {
    const r = this.current;
    return r && r.all.text ? { id: r.id, text: r.all.text, truncated: r.all.cut } : null;
  }

  private collect(r: Run, text: string, into: Tail): void {
    if (!text || r.done) return;
    into.push(text);
    r.all.push(text);
    // one frame per tick, whatever came in: the tail so far, replacing what the page shows
    if (r.quiet || r.flush) return;
    r.flush = setTimeout(() => {
      r.flush = undefined;
      if (r.quiet || r.done) return;
      this.o.emit({ kind: 'shell-out', id: r.id, text: r.all.text, truncated: r.all.cut }, { store: false, lossy: true });
    }, SHELL_FLUSH_MS);
  }

  private terminate(r: Run, why: ShellStop | 'switch'): void {
    if (r.done || r.stop) return;
    r.stop = why;
    if (signalGroup(r, 'SIGTERM')) this.armKill(r);
  }

  /** TERM to what is left of the group after the shell ended, and KILL a little later if any of it stayed. */
  private signalRest(r: Run): void {
    if (signalGroup(r, 'SIGTERM')) this.armKill(r);
  }

  /**
   * The KILL that follows a TERM that landed. The run stays in `live` (the exit hook kills it) until the KILL has gone or the group
   * is empty, which a poll notices: then there is nothing to kill, and the group id must not be signalled again.
   */
  private armKill(r: Run): void {
    if (r.killTimer) return;
    const end = () => {
      clearTimeout(r.killTimer);
      clearInterval(r.poll);
      live.delete(r);
    };
    r.killTimer = setTimeout(() => { signalGroup(r, 'SIGKILL'); end(); }, this.o.killMs);
    r.poll = setInterval(() => { if (!signalGroup(r, 0)) end(); }, POLL_MS);
    r.killTimer.unref(); // after the run ended it only guards stragglers; it must not hold the process open
    r.poll.unref();
  }

  private finish(r: Run): void {
    if (r.done) return;
    for (const t of r.timers) clearTimeout(t); // not killTimer: a child that ignored TERM is still to be killed
    // a background child may hold the pipes: let go of them, the output so far is what the run printed
    r.child?.stdout?.destroy();
    r.child?.stderr?.destroy();
    this.collect(r, r.ansiOut.end(), r.out);
    this.collect(r, r.ansiErr.end(), r.err);
    clearTimeout(r.flush);
    r.done = true;
    if (this.current === r) this.current = null;
    if (!r.killTimer) this.signalRest(r); // the pipes closed before the shell's exit was seen: the group still goes
    if (!r.killTimer) live.delete(r); // nothing left to kill; otherwise it stays until the KILL or an empty group
    if (r.quiet) return;
    const code = r.exit?.code ?? null;
    this.o.emit({
      kind: 'shell-end', id: r.id, cmd: r.cmd, output: r.all.text, truncated: r.all.cut, code,
      ...(r.stop && r.stop !== 'switch' ? { stop: r.stop } : {}), ...(r.error ? { error: r.error } : {}),
    });
    const note = r.stop === 'user' ? '[stopped by the user]' : r.stop === 'timeout' ? '[stopped: it ran longer than 10 minutes]'
      : r.error ? `[could not run: ${r.error}]` : code ? `[exit code ${code}]` : undefined;
    this.queue.push(bashBlock({ cmd: r.cmd, stdout: r.out.text, stdoutCut: r.out.cut, stderr: r.err.text, stderrCut: r.err.cut, ...(note ? { note } : {}) }));
    if (this.queue.length > QUEUE_MAX) this.queue.shift();
  }
}
