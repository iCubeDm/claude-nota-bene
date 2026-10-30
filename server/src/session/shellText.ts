import path from 'node:path';
import { SHELL_OUTPUT_CAP } from '@nota-bene/shared';

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
    this.text += s;
    if (this.text.length > this.cap) {
      this.text = this.text.slice(this.text.length - this.cap);
      this.cut = true;
    }
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
const CUT_MARK = '[… earlier output cut: the last 64 KB follow]\n';

/**
 * The text Claude Code puts in the conversation for a command typed with `!` (checked against its transcripts):
 * `<bash-input>cmd</bash-input>` and, on the next line, `<bash-stdout>…</bash-stdout><bash-stderr>…</bash-stderr>`, with
 * "(Bash completed with no output)" as the stdout of a silent run. `note` (a run we stopped) goes to the end of stderr.
 */
export function bashBlock(r: ShellResult): string {
  const body = (s: string, cut: boolean) => (cut ? CUT_MARK : '') + s.replace(/\n+$/, '');
  const stdout = body(r.stdout, r.stdoutCut);
  let stderr = body(r.stderr, r.stderrCut);
  if (r.note) stderr += `${stderr ? '\n' : ''}${r.note}`;
  return `<bash-input>${r.cmd}</bash-input>\n<bash-stdout>${stdout || stderr ? stdout : NO_OUTPUT}</bash-stdout><bash-stderr>${stderr}</bash-stderr>`;
}

/** A text the CLI would run as a slash command: a bash block in front of it would stop that. */
export const isSlashCommand = (text: string): boolean => /^\/[^\s/]+(\s|$)/.test(text);

const BLOCK = /^\s*<bash-input>([\s\S]*?)<\/bash-input>\s*<bash-stdout>([\s\S]*?)<\/bash-stdout><bash-stderr>([\s\S]*?)<\/bash-stderr>/;

/** The leading bash blocks of a user message (as `bashBlock` wrote them), and what follows them. */
export function splitBashBlocks(text: string): { runs: { cmd: string; output: string }[]; rest: string } {
  const runs: { cmd: string; output: string }[] = [];
  let rest = text;
  for (let m = BLOCK.exec(rest); m; m = BLOCK.exec(rest)) {
    const stdout = m[2]! === NO_OUTPUT ? '' : m[2]!;
    runs.push({ cmd: m[1]!, output: [stdout, m[3]!].filter(Boolean).join('\n') });
    rest = rest.slice(m[0].length);
  }
  return { runs, rest: runs.length ? rest.replace(/^\s+/, '') : text };
}
