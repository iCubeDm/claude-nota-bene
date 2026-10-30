import path from 'node:path';
import { SHELL_OUTPUT_CAP, cutTail } from '@nota-bene/shared';

// ESC sequences, each matched whole: CSI (colors, cursor), OSC (window title, hyperlinks) up to BEL or ST, DCS / SOS / PM / APC
// up to ST, a charset or other intermediate-byte form, and a bare two-byte one. `[ ] P X ^ _` start the long forms above, so the
// bare form leaves them out (an ESC [ cut at a chunk's end must be held, not eaten as a two-byte one).
const SEQ = String.raw`\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[PX^_][^\x1b]*\x1b\\|[ -/]+[0-~]|[0-OQ-WYZ\\\`-~])`;
const SEQ_G = new RegExp(SEQ, 'g');
// what a sequence looks like before its last byte arrives
const SEQ_PARTIAL = /^\x1b(?:\[[0-?]*[ -/]*|\][^\x07\x1b]*\x1b?|[PX^_][^\x1b]*\x1b?|[ -/]*)$/;
// C0 controls that mean nothing in a log: all but tab and newline (ESC is gone by then, CR was turned into a newline)
const CONTROLS = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g;
/** the most an unfinished sequence is held for the next chunk; a longer one is not an escape sequence */
const HOLD_MAX = 4096;

/**
 * Plain text out of a process's output stream: ANSI escape sequences removed, CR and CRLF made newlines (a progress bar's
 * rewrites become lines instead of overprinting), other control characters dropped. Stateful, one per stream: a sequence or
 * a CRLF cut by a chunk boundary is held until the next chunk (or `end`).
 */
export class AnsiStripper {
  private held = '';

  push(chunk: string): string {
    let t = this.held + chunk;
    this.held = '';
    const esc = t.lastIndexOf('\x1b');
    if (esc >= 0 && t.length - esc <= HOLD_MAX && SEQ_PARTIAL.test(t.slice(esc))) {
      this.held = t.slice(esc);
      t = t.slice(0, esc);
    } else if (t.endsWith('\r')) {
      this.held = '\r'; // the \n of a CRLF may open the next chunk
      t = t.slice(0, -1);
    }
    return clean(t);
  }

  /** The end of the stream: whatever is still held (an unfinished sequence is dropped). */
  end(): string {
    const rest = this.held;
    this.held = '';
    return rest.startsWith('\x1b') ? '' : clean(rest);
  }
}

function clean(t: string): string {
  return t.replace(SEQ_G, '').replace(/\r\n?/g, '\n').replace(/\x1b/g, '').replace(CONTROLS, '');
}

/** The last `cap` characters pushed; `cut` says anything was dropped from the front. */
export class Tail {
  text = '';
  cut = false;
  private readonly cap: number;

  constructor(cap = SHELL_OUTPUT_CAP) {
    this.cap = cap;
  }

  push(s: string): void {
    const all = this.text + s;
    this.text = cutTail(all, this.cap); // well-formed: never starts on the second half of a surrogate pair
    if (this.text.length < all.length) this.cut = true;
  }
}

/**
 * The environment of a `! cmd` run: ours minus what is only ours. The launcher's variables (a nested server or launcher would
 * take them for its own: see dropInheritedLauncherEnv), and, when npm started this server, what npm leaked into it, exactly as
 * bin/nota-bene.mjs `serverEnv` removes it from the server child (`npm_*`, INIT_CWD, the node_modules/.bin and node-gyp-bin
 * PATH prefix); bin/nota-bene.test.ts and shellText.test.ts hold the two together.
 */
export function shellEnv(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env = { ...base };
  for (const k of ['NOTA_BENE_SUPERVISED', 'NOTA_BENE_LAUNCHER_PID', 'NOTA_BENE_LOCKED', 'NOTA_BENE_AUTOPORT']) delete env[k];
  // under /nb the window is a Claude Code background task: these carry its token and a false "inside Claude Code" state.
  // CLAUDE_CONFIG_DIR stays: it is the user's own choice of where Claude Code keeps its settings
  for (const k of Object.keys(env)) if (k === 'CLAUDECODE' || k === 'CLAUDE_PID' || k.startsWith('CLAUDE_CODE_')) delete env[k];
  if (!(base.npm_execpath || base.npm_lifecycle_event)) return env;
  for (const k of Object.keys(env)) if (/^npm_/.test(k)) delete env[k];
  delete env.INIT_CWD;
  const key = Object.keys(env).find((k) => k.toUpperCase() === 'PATH');
  if (key && env[key]) {
    const parts = env[key]!.split(path.delimiter);
    let i = 0;
    while (i < parts.length && /(^|[\\/])(node_modules[\\/]\.bin|node-gyp-bin)$/.test(parts[i]!)) i++;
    env[key] = parts.slice(i).join(path.delimiter);
  }
  return env;
}

/** One finished run, as the agent is told of it. */
export type ShellResult = { cmd: string; stdout: string; stdoutCut: boolean; stderr: string; stderrCut: boolean; note?: string };

const NO_OUTPUT = '(Bash completed with no output)';
const CUT_MARK = '[… earlier output cut: the last 32 KB follow]\n';
/** a stream of a run reaches the agent with at most this many characters (the run's own tails hold this much) */
export const AGENT_STREAM_CAP = 32 * 1024;
/** the runs put in front of a message come to at most this many characters, the newest first kept (the newest run is always in) */
export const LEAD_CAP = 64 * 1024;

/**
 * Output must not close our tags: `</bash-` becomes `<\/bash-`. A backslash run before `/bash-` is doubled first (k backslashes
 * become 2k+1), so what the output really held, `<\/bash-` included, comes back as it was.
 */
const neutral = (s: string): string => s.replace(/<(\\*)\/bash-/g, (_m, bs: string) => `<${bs}${bs}\\/bash-`);
const restore = (s: string): string => s.replace(/<(\\+)\/bash-/g, (m, bs: string) => (bs.length % 2 ? `<${'\\'.repeat((bs.length - 1) / 2)}/bash-` : m));

/**
 * The text Claude Code puts in the conversation for a command typed with `!` (checked against its transcripts):
 * `<bash-input>cmd</bash-input>` and, on the next line, `<bash-stdout>…</bash-stdout><bash-stderr>…</bash-stderr>`, with
 * "(Bash completed with no output)" as the stdout of a silent run. `note` (a run we stopped, an exit code) goes to the end of stderr.
 */
export function bashBlock(r: ShellResult): string {
  const body = (s: string, cut: boolean) => neutral((cut ? CUT_MARK : '') + s.replace(/\n+$/, ''));
  const stdout = body(r.stdout, r.stdoutCut);
  let stderr = body(r.stderr, r.stderrCut);
  if (r.note) stderr += `${stderr ? '\n' : ''}${neutral(r.note)}`;
  return `<bash-input>${neutral(r.cmd)}</bash-input>\n<bash-stdout>${stdout || stderr ? stdout : NO_OUTPUT}</bash-stdout><bash-stderr>${stderr}</bash-stderr>`;
}

/** The queued blocks as one lead, the oldest dropped (and said so) once they pass LEAD_CAP; the newest is always in. */
export function leadOf(blocks: string[], cap = LEAD_CAP): string {
  let from = blocks.length - 1;
  let total = blocks[from]?.length ?? 0;
  while (from > 0 && total + blocks[from - 1]!.length + 2 <= cap) total += blocks[--from]!.length + 2;
  // the note comes after the blocks: a reader of the transcript takes the blocks from the very start of the message
  const mark = from > 0 ? `\n\n[${from} earlier shell run${from === 1 ? '' : 's'} left out: too long]` : '';
  return blocks.slice(from).join('\n\n') + mark;
}

/** A text the CLI would run as a slash command: a bash block in front of it would stop that. */
export const isSlashCommand = (text: string): boolean => /^\/[^\s/]+(\s|$)/.test(text);

const LEFT_OUT = /^\[\d+ earlier shell runs? left out: too long\](\n\n|$)/;
const SEP_OUT = '</bash-input>\n<bash-stdout>';
const SEP_ERR = '</bash-stdout><bash-stderr>';
const END = '</bash-stderr>';

/** One block of `bashBlock`'s form exactly at `at`, or null. Linear: every tag is looked for once, with indexOf. */
function blockAt(t: string, at: number): { cmd: string; output: string; end: number } | null {
  if (!t.startsWith('<bash-input>', at)) return null;
  const a = at + 12;
  const b = t.indexOf('</bash-input>', a);
  if (b < 0 || !t.startsWith(SEP_OUT, b)) return null;
  const c = b + SEP_OUT.length;
  const d = t.indexOf('</bash-stdout>', c);
  if (d < 0 || !t.startsWith(SEP_ERR, d)) return null;
  const e = d + SEP_ERR.length;
  const f = t.indexOf(END, e);
  if (f < 0) return null;
  const out = restore(t.slice(c, d));
  return { cmd: restore(t.slice(a, b)), output: [out === NO_OUTPUT ? '' : out, restore(t.slice(e, f))].filter(Boolean).join('\n'), end: f + END.length };
}

/**
 * The leading bash blocks of a user message, only in the exact form `bashBlock` writes (blocks joined by a blank line, then the
 * message), and what follows them. No marker tells them from a user who typed the same tags at the start of a message; that one
 * may show as a shell block, which is accepted.
 */
export function splitBashBlocks(text: string): { runs: { cmd: string; output: string }[]; rest: string } {
  const runs: { cmd: string; output: string }[] = [];
  let at = 0;
  for (let b = blockAt(text, at); b; b = blockAt(text, at)) {
    runs.push({ cmd: b.cmd, output: b.output });
    at = b.end;
    if (text.startsWith('\n\n', at)) at += 2;
    else break;
  }
  if (runs.length) at += LEFT_OUT.exec(text.slice(at, at + 80))?.[0].length ?? 0; // our note about runs left out: not the user's words
  return { runs, rest: runs.length ? text.slice(at) : text };
}
