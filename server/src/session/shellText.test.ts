import { describe, expect, it } from 'vitest';
import { SHELL_OUTPUT_CAP } from '@nota-bene/shared';
import { AnsiStripper, Tail, bashBlock, isSlashCommand, shellEnv, splitBashBlocks } from './shellText.ts';

const strip = (...chunks: string[]) => {
  const s = new AnsiStripper();
  return chunks.map((c) => s.push(c)).join('') + s.end();
};

describe('AnsiStripper', () => {
  it('removes colors, cursor moves, erase, titles and hyperlinks', () => {
    expect(strip('\x1b[31mred\x1b[0m \x1b[1;32mbold\x1b[m')).toBe('red bold');
    expect(strip('a\x1b[2K\x1b[1Gb\x1b[?25l\x1b[?25h')).toBe('ab');
    expect(strip('\x1b]0;title\x07text')).toBe('text');
    expect(strip('\x1b]8;;https://x.test\x1b\\link\x1b]8;;\x1b\\')).toBe('link');
    expect(strip('\x1b(Bplain\x1b=\x1b>')).toBe('plain');
  });

  it('holds a sequence cut by a chunk boundary, wherever it is cut', () => {
    const text = 'a\x1b[1;31mred\x1b[0mb\x1b]0;t\x07c';
    for (let i = 1; i < text.length; i++) expect(strip(text.slice(0, i), text.slice(i))).toBe('aredbc');
  });

  it('turns CR and CRLF into newlines, also across chunks, and drops other controls', () => {
    expect(strip('a\r\nb\rc\n')).toBe('a\nb\nc\n');
    expect(strip('a\r', '\nb')).toBe('a\nb');
    expect(strip('a\x00b\x07c\x08d\te')).toBe('abcd\te');
  });

  it('drops an unfinished sequence at the end of the stream and a stray ESC', () => {
    expect(strip('ok\x1b[31')).toBe('ok');
    expect(strip('a\x1b\nb')).toBe('a\nb');
  });
});

describe('Tail', () => {
  it('keeps the last cap characters and says it cut', () => {
    const t = new Tail(10);
    t.push('12345');
    expect(t).toMatchObject({ text: '12345', cut: false });
    t.push('6789012');
    expect(t).toMatchObject({ text: '3456789012', cut: true });
  });
  it('defaults to 64 K', () => {
    const t = new Tail();
    t.push('x'.repeat(SHELL_OUTPUT_CAP + 1));
    expect(t.text.length).toBe(SHELL_OUTPUT_CAP);
    expect(t.cut).toBe(true);
  });
});

describe('shellEnv', () => {
  it('drops the launcher variables and keeps the rest', () => {
    const e = shellEnv({ PATH: '/usr/bin', HOME: '/h', NOTA_BENE_SUPERVISED: '1', NOTA_BENE_LAUNCHER_PID: '7', NOTA_BENE_LOCKED: '1', NOTA_BENE_AUTOPORT: '1', NOTA_BENE_HOME: '/state' });
    expect(e).toEqual({ PATH: '/usr/bin', HOME: '/h', NOTA_BENE_HOME: '/state' });
  });
  it('strips what npm leaked: the npm_* variables, INIT_CWD and npm’s PATH prefix', () => {
    const e = shellEnv({ npm_execpath: '/x/npm', npm_lifecycle_event: 'start', npm_config_registry: 'r', INIT_CWD: '/w', PATH: '/p/node_modules/.bin:/q/node-gyp-bin:/usr/bin:/bin', HOME: '/h' });
    expect(e).toEqual({ PATH: '/usr/bin:/bin', HOME: '/h' }); // bin/nota-bene.test.ts checks serverEnv gives the same
  });
  it('keeps the user’s own npm variables when npm did not start us', () => {
    expect(shellEnv({ NPM_TOKEN: 't', npm_config_registry: 'r' })).toEqual({ NPM_TOKEN: 't', npm_config_registry: 'r' });
  });
  it('does not touch its input', () => {
    const base = { NOTA_BENE_SUPERVISED: '1' };
    shellEnv(base);
    expect(base).toEqual({ NOTA_BENE_SUPERVISED: '1' });
  });
});

describe('bashBlock', () => {
  const run = { cmd: 'ls', stdout: '', stdoutCut: false, stderr: '', stderrCut: false };
  it('is the form Claude Code records', () => {
    expect(bashBlock({ ...run, stdout: 'a\nb\n' })).toBe('<bash-input>ls</bash-input>\n<bash-stdout>a\nb</bash-stdout><bash-stderr></bash-stderr>');
    expect(bashBlock({ ...run, stdout: 'a\n', stderr: 'oops\n' })).toBe('<bash-input>ls</bash-input>\n<bash-stdout>a</bash-stdout><bash-stderr>oops</bash-stderr>');
  });
  it('says so when there was no output', () => {
    expect(bashBlock(run)).toBe('<bash-input>ls</bash-input>\n<bash-stdout>(Bash completed with no output)</bash-stdout><bash-stderr></bash-stderr>');
  });
  it('an stderr-only run has an empty stdout, not the no-output line', () => {
    expect(bashBlock({ ...run, stderr: 'bad\n' })).toBe('<bash-input>ls</bash-input>\n<bash-stdout></bash-stdout><bash-stderr>bad</bash-stderr>');
  });
  it('marks a cut stream and puts a stop note at the end of stderr', () => {
    expect(bashBlock({ ...run, stdout: 'tail', stdoutCut: true })).toContain('<bash-stdout>[… earlier output cut: the last 64 KB follow]\ntail</bash-stdout>');
    expect(bashBlock({ ...run, stderr: 'e\n', note: '[stopped]' })).toContain('<bash-stderr>e\n[stopped]</bash-stderr>');
    expect(bashBlock({ ...run, note: '[stopped]' })).toContain('<bash-stdout></bash-stdout><bash-stderr>[stopped]</bash-stderr>');
  });
});

describe('isSlashCommand', () => {
  it('is a /word at the start, not a path', () => {
    for (const t of ['/clear', '/compact now', '/review\nmore']) expect(isSlashCommand(t)).toBe(true);
    for (const t of ['', 'hi /clear', '/usr/bin/env', '/ x', ' /clear']) expect(isSlashCommand(t)).toBe(false);
  });
});

describe('splitBashBlocks', () => {
  it('reads back what bashBlock wrote, several in a row, and the message after them', () => {
    const a = bashBlock({ cmd: 'echo hi', stdout: 'hi\n', stdoutCut: false, stderr: '', stderrCut: false });
    const b = bashBlock({ cmd: 'true', stdout: '', stdoutCut: false, stderr: '', stderrCut: false });
    expect(splitBashBlocks(`${a}\n\n${b}\n\nfix it`)).toEqual({ runs: [{ cmd: 'echo hi', output: 'hi' }, { cmd: 'true', output: '' }], rest: 'fix it' });
  });
  it('leaves a message with no leading block alone', () => {
    expect(splitBashBlocks('hello <bash-input>x</bash-input>')).toEqual({ runs: [], rest: 'hello <bash-input>x</bash-input>' });
  });
  it('joins stdout and stderr of a run', () => {
    expect(splitBashBlocks('<bash-input>x</bash-input>\n<bash-stdout>o</bash-stdout><bash-stderr>e</bash-stderr>').runs).toEqual([{ cmd: 'x', output: 'o\ne' }]);
  });
});
