// Runs plugin/skills/nb/open.sh (the /nb skill's launcher) with /bin/bash, a temp HOME / NOTA_BENE_HOME / CLAUDE_CONFIG_DIR, stub
// `open` / `xdg-open` on PATH (no real browser), fake windows on 4791-4795 that answer /info, and either:
//  - a stub app (a copy of open.sh beside a stub bin/nota-bene.mjs that records its argv and hands --find / --last to
//    the real bin), for argument, guard and output checks; or
//  - the real bin with the fake agent (NOTA_BENE_FAKE), for the concurrent-open test.
// Every server the real bin starts is SIGKILLed in afterAll, and `ps` must show nothing of ours left.
import { execFile, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { proofFor } from '../server/src/auth.ts';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const SKILL = fileURLToPath(new URL('../plugin/skills/nb', import.meta.url)); // not beside the test: the plugin dir ships to users
const REAL_BIN = fileURLToPath(new URL('../bin/nota-bene.mjs', import.meta.url));
const FAKE = fileURLToPath(new URL('../server/test/fixtures/hello.json', import.meta.url));
const SID = '0123abcd-4567-89ab-cdef-0123456789ab';

let tmp: string; // the whole suite's temp root (also TMPDIR of every run)
let home: string; // HOME of every run
let nbHome: string;
let claudeDir: string;
let project: string;
let stubApp: string; // tmp/stub-skills/nb/open.sh → tmp/app/plugin/skills/nb (a symlink, like ~/.claude/skills/nb)
let realSkill: string; // tmp/real-skills/nb/open.sh → <repo>/plugin/skills/nb
let pkgOpen: string; // a plugin-cache layout with NO checkout above it: tmp/cache/nota-bene/9.9.9/skills/nb/open.sh
const PKG_VER = '9.9.9';
const servers: http.Server[] = [];

beforeAll(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nb-skill-')));
  // the stub app: open.sh resolves the app from its own (physical) location, so a copy beside a stub bin uses the stub
  fs.mkdirSync(path.join(tmp, 'app/plugin/skills/nb'), { recursive: true });
  fs.mkdirSync(path.join(tmp, 'app/bin'));
  fs.copyFileSync(path.join(SKILL, 'open.sh'), path.join(tmp, 'app/plugin/skills/nb/open.sh'));
  fs.writeFileSync(path.join(tmp, 'app/bin/nota-bene.mjs'), `
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
const argv = process.argv.slice(2);
if (argv[0] === '--front' && process.env.STUB_FRONT_FAIL) process.exit(1);
if (['--find', '--last', '--url', '--front'].includes(argv[0])) {
  const r = spawnSync(process.execPath, [process.env.STUB_REAL_BIN, ...argv], { stdio: 'inherit' });
  process.exit(r.status ?? 1);
}
fs.appendFileSync(process.env.STUB_ARGV, JSON.stringify(argv) + '\\n');
if (process.env.STUB_FAIL) {
  process.stderr.write('nota-bene: the server did not come up in 20s. Last log lines:\\nboom: the last log line\\n');
  process.exit(1);
}
process.stdout.write((process.env.STUB_OUT || 'opened http://127.0.0.1:4795') + '\\n');
process.exit(Number(process.env.STUB_EXIT || 0));
`);
  for (const [name, target] of [['stub-skills', path.join(tmp, 'app/plugin/skills/nb')], ['real-skills', SKILL]] as const) {
    fs.mkdirSync(path.join(tmp, name));
    fs.symlinkSync(target, path.join(tmp, name, 'nb'));
  }
  stubApp = path.join(tmp, 'stub-skills/nb/open.sh');
  realSkill = path.join(tmp, 'real-skills/nb/open.sh');
  // the plugin as the plugin cache holds it (<plugin>/<version>/{.claude-plugin,skills/nb}), no bin/ anywhere above
  const cacheVer = path.join(tmp, 'cache/nota-bene', PKG_VER);
  fs.mkdirSync(path.join(cacheVer, 'skills/nb'), { recursive: true });
  fs.mkdirSync(path.join(cacheVer, '.claude-plugin'));
  fs.copyFileSync(path.join(SKILL, 'open.sh'), path.join(cacheVer, 'skills/nb/open.sh'));
  fs.writeFileSync(path.join(cacheVer, '.claude-plugin/plugin.json'), JSON.stringify({ name: 'nota-bene', version: PKG_VER }, null, 2));
  pkgOpen = path.join(cacheVer, 'skills/nb/open.sh');
  // no real browser: `open` / `xdg-open` record their argument
  fs.mkdirSync(path.join(tmp, 'path'));
  for (const name of ['open', 'xdg-open']) {
    const f = path.join(tmp, 'path', name);
    fs.writeFileSync(f, `#!/bin/sh\necho "$1" >> "${tmp}/opened.log"\n`);
    fs.chmodSync(f, 0o755);
  }
  // a stub npm: records its argv; `install --prefix P pkg@v` puts the stub launcher where the package's bin would be
  fs.writeFileSync(path.join(tmp, 'path/npm'), `#!${process.execPath}
const fs = require('fs'), path = require('path');
const a = process.argv.slice(2);
fs.appendFileSync(process.env.STUB_NPM_LOG, JSON.stringify(a) + '\\n');
if (process.env.STUB_NPM_SLEEP) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number(process.env.STUB_NPM_SLEEP) * 1000);
if (process.env.STUB_NPM_FAIL) { process.stderr.write('npm ERR! boom: the last npm line\\n'); process.exit(1); }
const bin = path.join(a[a.indexOf('--prefix') + 1], 'node_modules/nota-bene-ide/bin');
fs.mkdirSync(bin, { recursive: true });
fs.copyFileSync(process.env.STUB_BIN_SRC, path.join(bin, 'nota-bene.mjs'));
`);
  fs.chmodSync(path.join(tmp, 'path/npm'), 0o755);
});

beforeEach(() => {
  const t = fs.mkdtempSync(path.join(tmp, 't-'));
  home = path.join(t, 'home');
  nbHome = path.join(t, 'nb');
  claudeDir = path.join(t, 'claude');
  project = path.join(t, 'project');
  for (const d of [home, nbHome, claudeDir, project]) fs.mkdirSync(d);
  fs.rmSync(path.join(tmp, 'opened.log'), { force: true });
  fs.rmSync(path.join(tmp, 'npm.log'), { force: true });
});

afterEach(async () => {
  for (const s of servers.splice(0)) {
    s.closeAllConnections();
    await new Promise((r) => s.close(r));
  }
});

// every process the real bin started serves a folder under tmp: kill them all, then check that none is left
function ours(): number[] {
  const ps = execFileSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8' });
  return ps.split('\n').filter((l) => l.includes(tmp) && !l.includes('ps -axo')).map((l) => Number(l.trim().split(/\s+/)[0]))
    .filter((pid) => pid !== process.pid);
}
afterAll(async () => {
  for (const pid of ours()) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // already gone
    }
  }
  await new Promise((r) => setTimeout(r, 300));
  const left = ours();
  fs.rmSync(tmp, { recursive: true, force: true });
  expect(left).toEqual([]);
});

const env = (extra: Record<string, string> = {}): NodeJS.ProcessEnv => {
  const e: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: `${path.join(tmp, 'path')}:${path.dirname(process.execPath)}:${process.env.PATH}`, // a node >= 23.6 first
    HOME: home,
    NOTA_BENE_HOME: nbHome,
    CLAUDE_CONFIG_DIR: claudeDir,
    NOTA_BENE_PORT_RANGE: '4791-4795',
    NOTA_BENE_BUILD_CMD: 'true', // never run the real vite build from a test
    TMPDIR: tmp,
    STUB_REAL_BIN: REAL_BIN,
    STUB_ARGV: path.join(tmp, 'argv.log'),
    STUB_NPM_LOG: path.join(tmp, 'npm.log'),
    STUB_BIN_SRC: path.join(tmp, 'app/bin/nota-bene.mjs'),
    ...extra,
  };
  delete e.NOTA_BENE_SUPERVISED;
  delete e.AI_IDE_SUPERVISED;
  delete e.NOTA_BENE_FAKE;
  for (const [k, v] of Object.entries(extra)) {
    if (v === '') delete e[k]; // '' unsets
    else e[k] = v;
  }
  return e;
};

type Result = { code: number; out: string };
type RunOpts = { cwd?: string; env?: Record<string, string>; script?: string; shell?: string };
/** Runs `<shell> argv...` (default: /bin/bash, the shebang's interpreter, 3.2 on macOS) in the test environment. */
function sh(argv: string[], o: RunOpts = {}) {
  return new Promise<Result>((resolve) => {
    execFile(o.shell ?? '/bin/bash', argv, { cwd: o.cwd ?? project, env: env(o.env), timeout: 30_000 },
      (err, stdout, stderr) => resolve({ code: err ? ((err as { code?: number }).code ?? -1) : 0, out: stdout + stderr }));
  });
}
function nb(args: string, o: RunOpts & { sid?: string } = {}) {
  fs.rmSync(path.join(tmp, 'argv.log'), { force: true });
  return sh([o.script ?? stubApp, args, o.sid ?? SID], o);
}
const launches = (): string[][] => {
  try {
    return fs.readFileSync(path.join(tmp, 'argv.log'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  } catch {
    return [];
  }
};
const opened = (): string[] => {
  try {
    return fs.readFileSync(path.join(tmp, 'opened.log'), 'utf8').trim().split('\n').filter(Boolean);
  } catch {
    return [];
  }
};

/** The access token of the test's state dir (the launcher creates it on first use). */
const tokenOf = (): string => fs.readFileSync(path.join(nbHome, 'token'), 'utf8').trim();
/** The login URL the skill prints for a window on `port`. */
const tokUrl = (port: number): string => `http://127.0.0.1:${port}/#t=${tokenOf()}`;
/** The URL the skill prints: plain, the transcript and the API never see the token. */
const plainUrl = (port: number): string => `http://127.0.0.1:${port}`;
/** What the browser was asked to open: pages in the state dir (never a URL, so never a token in argv); the URL each redirects to. */
const openedUrls = (): string[] => opened().map((f) => {
  expect(f).not.toMatch(/^https?:/);
  expect(fs.statSync(f).mode & 0o777).toBe(0o600);
  return /location\.replace\("([^"]+)"\)/.exec(fs.readFileSync(f, 'utf8'))![1]!;
});

/** A directory holding executables: [name, script] are written, [name, path] of an existing file are symlinked. */
function binDir(name: string, tools: [string, string][]): string {
  const d = path.join(tmp, name);
  fs.rmSync(d, { recursive: true, force: true });
  fs.mkdirSync(d);
  for (const [tool, what] of tools) {
    if (what.startsWith('#!')) {
      fs.writeFileSync(path.join(d, tool), what);
      fs.chmodSync(path.join(d, tool), 0o755);
    } else fs.symlinkSync(what, path.join(d, tool));
  }
  return d;
}
const which = (tool: string) => execFileSync('/bin/sh', ['-c', `command -v ${tool}`], { encoding: 'utf8' }).trim();

/** A window on `port` whose /info says `root`. */
async function fakeWindow(port: number, root: string): Promise<void> {
  const s = http.createServer((req, res) => {
    // proves itself as a window of this state dir would (the launcher sends nothing before it does)
    const m = /^\/hello\?c=([0-9a-f]+)$/.exec(req.url ?? '');
    if (m) res.setHeader('content-type', 'application/json').end(JSON.stringify({ proof: proofFor(tokenOf(), port, 'f0'.repeat(16), m[1]!), n: 'f0'.repeat(16) }));
    else if (req.url === '/info') res.setHeader('content-type', 'application/json').end(JSON.stringify({ root, session: null }));
    else res.writeHead(404).end();
  });
  await new Promise<void>((r) => s.listen(port, '127.0.0.1', () => r()));
  servers.push(s);
}
function register(port: number, root: string, pid: number): void {
  fs.mkdirSync(path.join(nbHome, 'windows'), { recursive: true });
  fs.writeFileSync(path.join(nbHome, 'windows', `${port}.json`), JSON.stringify({ root, pid, startedAt: Date.now() }));
}
const registry = (): string[] => {
  try {
    return fs.readdirSync(path.join(nbHome, 'windows')).filter((n) => /^\d+\.json$/.test(n));
  } catch {
    return [];
  }
};

describe('arguments', () => {
  it('an unknown argument prints the usage line and launches nothing', async () => {
    const r = await nb('frobnicate');
    expect(r.code).toBe(0);
    expect(r.out).toBe("NB: unknown argument 'frobnicate'. Use /nb (resume the last window session here), /nb new, or "
      + '/nb fork (carry this conversation over).\n');
    expect(launches()).toEqual([]);
  });

  it.each(['-n', 'new please'])('%j is an unknown argument too, and launches nothing', async (arg) => {
    const r = await nb(arg);
    expect(r.code).toBe(0);
    expect(r.out).toBe(`NB: unknown argument '${arg}'. Use /nb (resume the last window session here), /nb new, or `
      + '/nb fork (carry this conversation over).\n');
    expect(launches()).toEqual([]);
  });

  it.each(['new', 'новая'])('%j starts a new session (--new)', async (arg) => {
    const r = await nb(arg);
    expect(r.code).toBe(0);
    expect(launches()).toEqual([[project, '--detach', '--new']]);
    expect(r.out).toBe(`NB: opened http://127.0.0.1:4795 for ${project}. Log: ${tmp}/nota-bene-4795.log\n`);
  });

  it.each(['fork', 'FORK', 'форк'])('%j forks the caller (--resume SID --fork)',
    async (arg) => {
      const r = await nb(arg);
      expect(r.code).toBe(0);
      expect(launches()).toEqual([[project, '--detach', '--resume', SID, '--fork']]);
      expect(r.out).toMatch(/\(forked from this conversation\)/);
    });

  it('fork refuses a session id that is not a UUID', async () => {
    for (const sid of ['', 'not-a-session', '0123abcd-4567-89ab-cdef-0123456789ab; rm -rf ~', '------------------------------------']) {
      const r = await nb('fork', { sid });
      expect(r.code).toBe(1);
      expect(r.out).toBe(`NB: no valid session id to fork ('${sid}').\n`);
    }
    expect(launches()).toEqual([]);
  });

  it('no argument launches with the default resume; --last only words the note', async () => {
    let r = await nb('');
    expect(launches()).toEqual([[project, '--detach']]);
    expect(r.out).toBe(`NB: opened http://127.0.0.1:4795 for ${project} (new session: no earlier window session for this `
      + `folder). Log: ${tmp}/nota-bene-4795.log\n`);

    const id = 'feedface-0000-4000-8000-000000000001';
    fs.writeFileSync(path.join(nbHome, 'sessions.json'), JSON.stringify({ [project]: id }));
    r = await nb('');
    expect(r.out).toMatch(/\(new session: no earlier window session/); // saved, but its transcript is gone
    fs.mkdirSync(path.join(claudeDir, 'projects/p'), { recursive: true });
    fs.writeFileSync(path.join(claudeDir, 'projects/p', `${id}.jsonl`), '');
    r = await nb('');
    expect(launches()).toEqual([[project, '--detach']]); // the server resumes it itself
    expect(r.out).toBe(`NB: opened http://127.0.0.1:4795 for ${project} (resumed the last window session feedface). `
      + `Log: ${tmp}/nota-bene-4795.log\n`);
  });

  it('NOTA_BENE_FAKE (test only) is passed on as --fake', async () => {
    await nb('new', { env: { NOTA_BENE_FAKE: FAKE } });
    expect(launches()).toEqual([[project, '--detach', '--new', '--fake', FAKE]]);
  });

  it('the launcher\'s lines carry #t=TOKEN; what the skill prints never does (it enters the transcript and the API)', async () => {
    const tok = 'ab'.repeat(32);
    let r = await nb('', { env: { STUB_OUT: `opened http://127.0.0.1:4795/#t=${tok}` } });
    expect(r.out).toMatch(/^NB: opened http:\/\/127\.0\.0\.1:4795 for .*Log: /);
    expect(r.out).not.toContain(tok);
    r = await nb('', { env: { STUB_OUT: `already-open http://127.0.0.1:4794/#t=${tok}` } });
    expect(r.out).toBe('NB: already open at http://127.0.0.1:4794 (brought to front).\n');
    expect(r.out).not.toContain(tok);
  });

  it('a launch that lost the race to another on this folder (already-open) is reported as already open', async () => {
    let r = await nb('', { env: { STUB_OUT: 'already-open http://127.0.0.1:4794' } });
    expect(r.code).toBe(0);
    expect(r.out).toBe('NB: already open at http://127.0.0.1:4794 (brought to front).\n');
    expect(opened()).toEqual([]); // the bin brought it to front, not us (no second tab)
    r = await nb('new', { env: { STUB_OUT: 'something else' } });
    expect(r.code).toBe(1);
    expect(r.out).toBe('NB: the launcher failed (exit code 0): something else\n');
  });

  it('a launch failure is relayed with the log tail, exit 1', async () => {
    const r = await nb('', { env: { STUB_FAIL: '1' } });
    expect(r.code).toBe(1);
    expect(r.out).toBe('NB: the server did not come up in 20s. Last log lines:\nboom: the last log line\n');
  });
});

describe('guards', () => {
  it.each(['NOTA_BENE_SUPERVISED', 'AI_IDE_SUPERVISED'])('inside Nota Bene (%s) there is nothing to open', async (v) => {
    const r = await nb('', { env: { [v]: '1' } });
    expect(r.code).toBe(0);
    expect(r.out).toBe('NB: already running inside Nota Bene — nothing to open.\n');
    expect(launches()).toEqual([]);
  });

  it('refuses $HOME and /', async () => {
    let r = await nb('', { cwd: home });
    expect(r.out).toBe(`NB: refusing to open the whole ${home} as a project — cd into a project first.\n`);
    r = await nb('new', { cwd: '/' });
    expect(r.out).toBe('NB: refusing to open the whole / as a project — cd into a project first.\n');
    expect(r.code).toBe(0);
    expect(launches()).toEqual([]);
  });
});

describe('an existing window', () => {
  it('a registered window is brought to front', async () => {
    await fakeWindow(4792, project);
    register(4792, project, process.pid);
    const r = await nb('');
    expect(r.code).toBe(0);
    expect(r.out).toBe(`NB: already open at ${plainUrl(4792)} (brought to front).\n`);
    expect(openedUrls()).toEqual([tokUrl(4792)]);
    expect(launches()).toEqual([]);
  });

  it('with fork it says the window was NOT switched', async () => {
    await fakeWindow(4792, project);
    register(4792, project, process.pid);
    const r = await nb('fork');
    expect(r.out).toBe(`NB: a window is already open on this folder at ${plainUrl(4792)} (brought to front). It was `
      + 'NOT switched to this conversation: switching restarts it and may cut a running turn. To move this conversation '
      + 'there, quit the terminal claude and pick it in Sessions ▾.\n');
    expect(launches()).toEqual([]);
  });

  it('fork with an invalid session id still brings an open window to front with the NOT switched note', async () => {
    await fakeWindow(4792, project);
    register(4792, project, process.pid);
    const r = await nb('fork', { sid: 'garbage' });
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/^NB: a window is already open on this folder at http:\/\/127\.0\.0\.1:4792 \(brought to front\)\. It was NOT switched/);
    expect(openedUrls()).toEqual([tokUrl(4792)]);
  });

  it('an unregistered window (a lost registry write) is found by the /info scan', async () => {
    await fakeWindow(4791, path.join(tmp, 'elsewhere'));
    await fakeWindow(4793, project);
    const r = await nb('new');
    expect(r.out).toBe(`NB: already open at ${plainUrl(4793)} (brought to front).\n`);
    expect(openedUrls()).toEqual([tokUrl(4793)]);
    expect(launches()).toEqual([]);
  });

  it('a --front that fails is not reported as "brought to front": it says how to get a login link', async () => {
    await fakeWindow(4792, project);
    register(4792, project, process.pid);
    const r = await nb('', { env: { STUB_FRONT_FAIL: '1' } });
    expect(r.out).toBe(`NB: already open at ${plainUrl(4792)} (no browser could be opened from here: run \`nota-bene --url 4792\` in a terminal for a login link).\n`);
    expect(r.out).not.toContain('brought to front');
    expect(r.out).not.toContain('#t=');
  });

  it('the launcher\'s failure line is relayed without any #t= fragment', async () => {
    const tok = 'cd'.repeat(32);
    const r = await nb('', { env: { STUB_OUT: `opened http://127.0.0.1:4795/#t=${tok}`, STUB_EXIT: '3' } });
    expect(r.code).toBe(1);
    expect(r.out).toContain('the launcher failed (exit code 3)');
    expect(r.out).not.toContain(tok);
    expect(r.out).not.toContain('#t=');
  });

  it('stale registry entries are skipped (dead pid, port now serving another folder) and a window is launched', async () => {
    const dead = execFileSync(process.execPath, ['-e', 'console.log(process.pid)'], { encoding: 'utf8' }).trim();
    register(4791, project, Number(dead));
    await fakeWindow(4792, path.join(tmp, 'elsewhere'));
    register(4792, project, process.pid);
    const r = await nb('');
    expect(r.out).toMatch(/^NB: opened http:\/\/127\.0\.0\.1:4795 for /);
    expect(launches()).toEqual([[project, '--detach']]);
    expect(opened()).toEqual([]); // a wrong window is never brought to front
    expect(registry()).toEqual([]); // both pruned by --find
  });
});

describe('the environment', () => {
  const OLD = (v: string) => `#!/bin/sh\necho ${v}\n`;
  it.each(['18.19.0', '23.5.1', '9.99.0'])('an old node (%s) is refused with a clear message', async (v) => {
    const d = binDir('oldnode', [['node', OLD(v)]]);
    const r = await nb('', { env: { PATH: `${d}:${process.env.PATH}` } });
    expect(r.code).toBe(1);
    expect(r.out).toBe(`NB: Nota Bene needs Node >= 23.6; found ${v} at ${d}/node. Make it the default node for Claude `
      + "Code's shell (e.g. nvm alias default).\n");
    expect(launches()).toEqual([]);
  });

  it('no node at all is refused with the same message', async () => {
    const tools = ['dirname', 'tr', 'sed', 'uname'].map((t): [string, string] => [t, which(t)]);
    const r = await nb('', { env: { PATH: binDir('nonode', tools) } });
    expect(r.code).toBe(1);
    expect(r.out).toBe("NB: Nota Bene needs Node >= 23.6; found none on PATH. Make it the default node for Claude Code's "
      + 'shell (e.g. nvm alias default).\n');
  });

  // only the tools open.sh needs: no open / xdg-open, and a uname that says Linux
  const sandbox = () => binDir('sandbox', [
    ...['dirname', 'tr', 'sed', 'seq', 'mktemp', 'cat', 'rm'].map((t): [string, string] => [t, which(t)]),
    ['node', process.execPath],
    ['uname', '#!/bin/sh\necho Linux\n'],
  ]);

  it('on Linux without xdg-open it says to open the URL instead of "brought to front"', async () => {
    await fakeWindow(4792, project);
    register(4792, project, process.pid);
    const r = await nb('', { env: { PATH: sandbox() } });
    expect(r.code).toBe(0);
    expect(r.out).toBe(`NB: already open at ${plainUrl(4792)} (no browser could be opened from here: run \`nota-bene --url 4792\` in a terminal for a login link).\n`);
  });
});

describe('two /nb calls on one folder at the same moment', () => {
  it('end with exactly one window, and both point at it', async () => {
    const run = () => nb('', { script: realSkill, env: { NOTA_BENE_FAKE: FAKE } });
    const [a, b] = await Promise.all([run(), run()]);
    const url = (r: Result) => /^NB: (?:opened|already open at) (http:\/\/127\.0\.0\.1:\d+)/.exec(r.out)?.[1];
    expect(url(a), a.out).toBeTruthy();
    expect(url(b), b.out).toBe(url(a));
    const verbs = [a, b].map((r) => (r.out.startsWith('NB: opened') ? 'opened' : 'already'));
    expect(verbs.sort()).toEqual(['already', 'opened']);

    // one registry entry for the folder, and one /info root among the ports
    const entries = registry().map((n) => JSON.parse(fs.readFileSync(path.join(nbHome, 'windows', n), 'utf8')));
    expect(entries.filter((w) => w.root === project)).toHaveLength(1);
    const roots: string[] = [];
    for (let p = 4791; p <= 4795; p++) {
      try {
        const r = await fetch(`http://127.0.0.1:${p}/info`, { headers: { authorization: `Bearer ${tokenOf()}` }, signal: AbortSignal.timeout(500) });
        roots.push(((await r.json()) as { root: string }).root);
      } catch {
        // nothing there
      }
    }
    expect(roots.filter((r) => r === project)).toHaveLength(1);
    expect(url(a)).toBe(`http://127.0.0.1:${registry()[0]!.replace('.json', '')}`);
  }, 60_000);
});

// --plan: what the /nb skill runs. It launches nothing; the skill runs NB-RUN as a background task, then NB-WAIT.
describe('--plan', () => {
  const stubBin = () => path.join(tmp, 'app/bin/nota-bene.mjs');
  const plan = (args: string, o: RunOpts & { sid?: string } = {}) => {
    fs.rmSync(path.join(tmp, 'argv.log'), { force: true });
    return sh([o.script ?? stubApp, '--plan', args, o.sid ?? SID], o);
  };
  const lines = (r: Result) => Object.fromEntries(r.out.trimEnd().split('\n').map((l) => {
    const m = /^(NB-RUN|NB-WAIT|NB-NAME): (.*)$/.exec(l);
    if (!m) throw new Error(`not a plan line: ${l}`);
    return [m[1], m[2]];
  }));

  it('new: the foreground launcher with --new, the wait, the task name; nothing launched', async () => {
    const r = await plan('new');
    expect(r.code).toBe(0);
    expect(r.out).toBe(`NB-RUN: node ${stubBin()} ${project} --new\n`
      + `NB-WAIT: ${stubApp} --wait ${project}\n`
      + 'NB-NAME: Nota Bene · project\n');
    expect(launches()).toEqual([]);
    expect(opened()).toEqual([]);
  });

  it('no argument: the default resume, and --last words the note the wait prints', async () => {
    let r = await plan('');
    expect(lines(r)['NB-RUN']).toBe(`node ${stubBin()} ${project}`);
    expect(lines(r)['NB-WAIT']).toBe(`${stubApp} --wait ${project} `
      + "' (new session: no earlier window session for this folder)'");
    const id = 'feedface-0000-4000-8000-000000000001';
    fs.writeFileSync(path.join(nbHome, 'sessions.json'), JSON.stringify({ [project]: id }));
    fs.mkdirSync(path.join(claudeDir, 'projects/p'), { recursive: true });
    fs.writeFileSync(path.join(claudeDir, 'projects/p', `${id}.jsonl`), '');
    r = await plan('');
    expect(lines(r)['NB-RUN']).toBe(`node ${stubBin()} ${project}`);
    expect(lines(r)['NB-WAIT']).toBe(`${stubApp} --wait ${project} `
      + "' (resumed the last window session feedface)'");
    expect(launches()).toEqual([]);
  });

  it('fork with a valid session id: --resume SID --fork', async () => {
    const r = await plan('форк');
    expect(r.code).toBe(0);
    expect(lines(r)['NB-RUN']).toBe(`node ${stubBin()} ${project} --resume ${SID} --fork`);
    expect(lines(r)['NB-WAIT']).toBe(`${stubApp} --wait ${project} ` + "' (forked from this conversation)'");
  });

  it('a window already open on the folder: the usual NB: line, brought to front, no NB-RUN', async () => {
    await fakeWindow(4792, project);
    register(4792, project, process.pid);
    let r = await plan('');
    expect(r.out).toBe(`NB: already open at ${plainUrl(4792)} (brought to front).\n`);
    expect(openedUrls()).toEqual([tokUrl(4792)]);
    r = await plan('fork');
    expect(r.out).toMatch(/^NB: a window is already open on this folder at http:\/\/127\.0\.0\.1:4792 .*NOT switched/);
    await fakeWindow(4793, path.join(tmp, 'elsewhere'));
    const other = path.join(project, 'sub');
    fs.mkdirSync(other);
    await fakeWindow(4794, other); // unregistered: found by the /info scan
    r = await plan('new', { cwd: other });
    expect(r.out).toBe(`NB: already open at ${plainUrl(4794)} (brought to front).\n`);
    expect(launches()).toEqual([]);
  });

  it('guards and refusals are the same NB: lines', async () => {
    let r = await plan('', { env: { AI_IDE_SUPERVISED: '1' } });
    expect(r.out).toBe('NB: already running inside Nota Bene — nothing to open.\n');
    r = await plan('', { cwd: home });
    expect(r.out).toBe(`NB: refusing to open the whole ${home} as a project — cd into a project first.\n`);
    r = await plan('frobnicate');
    expect(r.out).toMatch(/^NB: unknown argument 'frobnicate'\. /);
    r = await plan('fork', { sid: 'x; rm -rf ~' });
    expect(r.code).toBe(0); // --plan runs in the skill's `!` preprocessing: a non-zero exit would fail it with no model turn
    expect(r.out).toBe("NB: no valid session id to fork ('x; rm -rf ~').\n");
    const d = binDir('oldnode-plan', [['node', '#!/bin/sh\necho 23.5.1\n']]);
    r = await plan('', { env: { PATH: `${d}:${process.env.PATH}` } });
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/^NB: Nota Bene needs Node >= 23\.6; found 23\.5\.1/);
    expect(launches()).toEqual([]);
  });

  it('a folder named `p r$oj Проект`: one word per command, the UTF-8 raw inside single quotes (no escape codes), read back exactly in bash and zsh', async () => {
    const odd = path.join(project, 'p r$oj Проект');
    fs.mkdirSync(odd);
    const r = await plan('new', { cwd: odd });
    expect(r.code).toBe(0);
    // Claude Code refuses text with escape codes ($'\320...') when it matches allowed-tools: a non-ASCII path stays raw, in '...'
    expect(r.out).not.toMatch(/\$'|\\[0-9]{3}/);
    expect(lines(r)['NB-RUN']).toContain(`'${odd}'`);
    const { 'NB-RUN': run, 'NB-WAIT': wait } = lines(r);
    // a stub node records the argv it gets
    const got = path.join(tmp, 'node-argv.log');
    const d = binDir('stubnode', [['node', `#!/bin/sh\n"${process.execPath}" -e 'console.log(JSON.stringify(process.argv.slice(1)))' -- "$@" >> "${got}"\n`]]);
    const shells = ['/bin/bash', ...(fs.existsSync('/bin/zsh') ? ['/bin/zsh'] : [])];
    for (const shell of shells) {
      fs.rmSync(got, { force: true });
      const e = await sh(['-c', run!], { shell, cwd: tmp, env: { PATH: `${d}:${process.env.PATH}` } });
      expect(e.code, e.out).toBe(0);
      expect(fs.readFileSync(got, 'utf8').trim().split('\n').map((l) => JSON.parse(l))).toEqual([[stubBin(), odd, '--new']]);
    }
    // the wait finds the window of that folder
    await fakeWindow(4792, odd);
    register(4792, odd, process.pid);
    for (const shell of shells) {
      const w = await sh(['-c', wait!], { shell, cwd: tmp });
      expect(w).toEqual({ code: 0, out: `NB: opened ${plainUrl(4792)} for ${odd}.\n` });
    }
  });
});

describe('--wait', () => {
  it('prints the URL with the note once the window is up', async () => {
    await fakeWindow(4793, project);
    register(4793, project, process.pid);
    const r = await sh([stubApp, '--wait', project, ' (forked from this conversation)']);
    expect(r).toEqual({ code: 0, out: `NB: opened ${plainUrl(4793)} for ${project} (forked from this conversation).\n` });
  });

  it('polls until a window that comes up later is registered', async () => {
    const waiting = sh([stubApp, '--wait', project]);
    await new Promise((res) => setTimeout(res, 1200));
    await fakeWindow(4794, project);
    register(4794, project, process.pid);
    expect(await waiting).toEqual({ code: 0, out: `NB: opened ${plainUrl(4794)} for ${project}.\n` });
  });

  it('times out (NB_WAIT_SECS, test only) with a pointer to the task output, exit 1', async () => {
    await fakeWindow(4795, path.join(tmp, 'elsewhere')); // another folder's window is not ours
    register(4795, path.join(tmp, 'elsewhere'), process.pid);
    const t0 = Date.now();
    const r = await sh([stubApp, '--wait', project], { env: { NB_WAIT_SECS: '1' } });
    expect(r).toEqual({ code: 1, out: "NB: the window did not come up in 1s — see the background task's output.\n" });
    expect(Date.now() - t0).toBeGreaterThanOrEqual(1000);
  });
});

// --- the plugin install: no checkout above the skill, the launcher comes from the npm package under ${CLAUDE_PLUGIN_DATA}
describe('the package lookup (plugin install)', () => {
  const esc = (p: string) => (/[^A-Za-z0-9_./:@%+=,-]/.test(p) ? `'${p.replace(/'/g, "'\\\\''")}'` : p); // q(): safe words as they are, the rest in '...'
  let data: string; // a data dir whose name has a space
  beforeEach(() => {
    data = path.join(path.dirname(project), 'plugin data');
  });
  const prefix = () => path.join(data, PKG_VER); // one install per plugin version
  const pkgBin = () => path.join(prefix(), 'node_modules/nota-bene-ide/bin/nota-bene.mjs');
  const npmCalls = (): string[][] => {
    try {
      return fs.readFileSync(path.join(tmp, 'npm.log'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
    } catch {
      return [];
    }
  };
  /** An installed package at `ver`, as a good first run leaves it. */
  function installed() {
    fs.mkdirSync(path.dirname(pkgBin()), { recursive: true });
    fs.copyFileSync(path.join(tmp, 'app/bin/nota-bene.mjs'), pkgBin());
    fs.writeFileSync(path.join(prefix(), '.nb-installed'), `${PKG_VER}\n`);
  }
  const plan = (args: string, o: RunOpts & { sid?: string; data?: string | null } = {}) => {
    fs.rmSync(path.join(tmp, 'argv.log'), { force: true });
    const d = o.data === undefined ? data : o.data;
    return sh([pkgOpen, ...(d === null ? [] : ['--data', d]), '--plan', args, o.sid ?? SID], o);
  };
  const lines = (r: Result) => Object.fromEntries(r.out.trimEnd().split('\n').map((l) => {
    const m = /^(NB-RUN|NB-WAIT|NB-NAME|NB-NOTE): (.*)$/.exec(l);
    if (!m) throw new Error(`not a plan line: ${l}`);
    return [m[1], m[2]];
  }));

  it('a checkout above the skill wins over the data dir (nothing installed, npm untouched)', async () => {
    const r = await sh([stubApp, '--data', data, '--plan', 'new', SID]);
    expect(r.out).toBe(`NB-RUN: node ${path.join(tmp, 'app/bin/nota-bene.mjs')} ${project} --new\n`
      + `NB-WAIT: ${stubApp} --wait ${project}\n`
      + 'NB-NAME: Nota Bene · project\n');
    expect(npmCalls()).toEqual([]);
    expect(fs.existsSync(data)).toBe(false);
  });

  it('no checkout and no data dir: one NB: line saying how to install the plugin', async () => {
    for (const d of [null, '', '${CLAUDE_PLUGIN_DATA}']) {
      const r = await plan('', { data: d });
      expect(r.code).toBe(0); // --plan never fails the skill's preprocessing
      expect(r.out).toMatch(/^NB: cannot find the Nota Bene launcher: no checkout above this skill and no plugin data dir\. Install the plugin /);
      expect(r.out.trimEnd().split('\n')).toHaveLength(1);
    }
  });

  it('first run: the plan only plans (no install, no data dir), the install is inside NB-RUN, with a patience note', async () => {
    const r = await plan('new');
    expect(r.code).toBe(0);
    const l = lines(r);
    expect(l['NB-RUN']).toBe(`${esc(pkgOpen)} --data ${esc(data)} --run ${project} --new`);
    expect(l['NB-WAIT']).toBe(`${esc(pkgOpen)} --data ${esc(data)} --wait ${project}`);
    expect(l['NB-NAME']).toBe('Nota Bene · project');
    expect(l['NB-NOTE']).toBe(`first run: installing nota-bene-ide@${PKG_VER} (about 330 MB) in the background task; this can take a few minutes.`);
    expect(npmCalls()).toEqual([]);
    expect(fs.existsSync(path.join(data, PKG_VER, 'node_modules'))).toBe(false);
  });

  it('--run installs the pinned version once with npm --prefix, then runs the launcher with the plan\'s arguments', async () => {
    const r = await sh([pkgOpen, '--data', data, '--run', project, '--resume', SID, '--fork']);
    expect(r.code).toBe(0);
    expect(npmCalls()).toEqual([['install', '--prefix', prefix(), `nota-bene-ide@${PKG_VER}`, '--no-audit', '--no-fund']]);
    expect(fs.readFileSync(path.join(prefix(), '.nb-installed'), 'utf8').trim()).toBe(PKG_VER);
    expect(launches()).toEqual([[project, '--resume', SID, '--fork']]);
    expect(r.out).toContain(`first run, installing nota-bene-ide@${PKG_VER}`);
    expect(r.out).toMatch(/opened http:\/\/127\.0\.0\.1:4795\n$/);
    // the second time nothing is installed again
    fs.rmSync(path.join(tmp, 'npm.log'));
    await sh([pkgOpen, '--data', data, '--run', project]);
    expect(npmCalls()).toEqual([]);
  });

  it('installed: NB-RUN is plain `node <data>/.../bin/nota-bene.mjs` (matches allowed-tools), no note, no npm', async () => {
    installed();
    const r = await plan('');
    const l = lines(r);
    expect(l['NB-RUN']).toBe(`node ${esc(pkgBin())} ${project}`);
    expect(l['NB-WAIT']).toBe(`${esc(pkgOpen)} --data ${esc(data)} --wait ${project} `
      + "' (new session: no earlier window session for this folder)'");
    expect(l['NB-NOTE']).toBeUndefined();
    expect(npmCalls()).toEqual([]);
  });

  it('fork and its Russian aliases behave as in a checkout; a bad session id is refused', async () => {
    installed();
    for (const a of ['fork', 'форк', 'продолжить']) {
      expect(lines(await plan(a))['NB-RUN']).toBe(`node ${esc(pkgBin())} ${project} --resume ${SID} --fork`);
    }
    expect(lines(await plan('заново'))['NB-RUN']).toBe(`node ${esc(pkgBin())} ${project} --new`);
    const r = await plan('fork', { sid: 'nope' });
    expect(r.out).toBe("NB: no valid session id to fork ('nope').\n");
    expect(r.code).toBe(0);
  });

  it('installed: a window already open on the folder is brought to front, no NB-RUN', async () => {
    installed();
    await fakeWindow(4792, project);
    register(4792, project, process.pid);
    const r = await plan('');
    expect(r.out).toBe(`NB: already open at ${plainUrl(4792)} (brought to front).\n`);
  });

  it('the version is pinned: a plugin update installs beside the old version and leaves it untouched', async () => {
    const old = path.join(data, '9.9.8/node_modules/nota-bene-ide/bin');
    fs.mkdirSync(old, { recursive: true });
    fs.writeFileSync(path.join(old, 'nota-bene.mjs'), '// old');
    fs.writeFileSync(path.join(data, '9.9.8/.nb-installed'), '9.9.8\n');
    expect(lines(await plan('new'))['NB-RUN']).toContain('--run');
    await sh([pkgOpen, '--data', data, '--run', project]);
    expect(npmCalls()).toEqual([['install', '--prefix', prefix(), `nota-bene-ide@${PKG_VER}`, '--no-audit', '--no-fund']]);
    expect(fs.readFileSync(path.join(prefix(), '.nb-installed'), 'utf8').trim()).toBe(PKG_VER);
    expect(fs.readFileSync(path.join(old, 'nota-bene.mjs'), 'utf8')).toBe('// old');
    expect(fs.existsSync(path.join(data, '9.9.8/.nb-installed'))).toBe(true);
  });

  it('a package whose marker is there but whose launcher is gone is installed again', async () => {
    installed();
    fs.rmSync(pkgBin());
    expect(lines(await plan('new'))['NB-RUN']).toContain('--run');
  });

  it('the plugin version equals the package version, and the plugin dir has no package.json or lockfile', () => {
    const root = path.join(SKILL, '../../..');
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    const plugin = JSON.parse(fs.readFileSync(path.join(root, 'plugin/.claude-plugin/plugin.json'), 'utf8'));
    expect(plugin.version).toBe(pkg.version);
    const market = JSON.parse(fs.readFileSync(path.join(root, '.claude-plugin/marketplace.json'), 'utf8'));
    expect(market.plugins).toEqual([expect.objectContaining({ name: plugin.name, source: './plugin' })]);
    expect(market.plugins[0].version).toBeUndefined(); // one place for the version
    const names: string[] = [];
    const walk = (d: string) => fs.readdirSync(d, { withFileTypes: true }).forEach((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : names.push(e.name)));
    walk(path.join(root, 'plugin'));
    expect(names.filter((n) => /^(package\.json|package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?)$/.test(n))).toEqual([]);
  });

  it('npm missing on the first run: one NB: line with the fix, no NB-RUN', async () => {
    const tools = ['dirname', 'tr', 'sed', 'uname', 'cat'].map((t): [string, string] => [t, which(t)]);
    const r = await plan('', { env: { PATH: binDir('nonpm', [...tools, ['node', process.execPath]]) } });
    expect(r.code).toBe(0);
    expect(r.out).toBe(`NB: npm not found on PATH; the first run installs nota-bene-ide@${PKG_VER} with it. Install Node.js with npm (nodejs.org), `
      + 'or run `npm install -g nota-bene-ide` and open it with `nota-bene`.\n');
  });

  it('an install failure: the NB: line with the fix and the npm tail, nothing marked installed, no launch', async () => {
    const r = await sh([pkgOpen, '--data', data, '--run', project], { env: { STUB_NPM_FAIL: '1' } });
    expect(r.code).toBe(1);
    expect(r.out).toContain(`NB: installing nota-bene-ide@${PKG_VER} failed (npm exit 1).`);
    expect(r.out).toContain(`npm install --prefix "${prefix()}" nota-bene-ide@${PKG_VER}`);
    expect(r.out).toContain('npm ERR! boom: the last npm line');
    expect(fs.existsSync(path.join(prefix(), '.nb-installed'))).toBe(false);
    expect(launches()).toEqual([]);
    // --wait reports the same, at once, instead of waiting out the install timeout
    const t0 = Date.now();
    const w = await sh([pkgOpen, '--data', data, '--wait', project]);
    expect(w.code).toBe(1);
    expect(w.out).toContain(`NB: installing nota-bene-ide@${PKG_VER} failed`);
    expect(Date.now() - t0).toBeLessThan(5000);
    // the next plan clears the old failure, so a retry's wait does not read it
    await plan('');
    expect(fs.existsSync(path.join(prefix(), '.nb-install-failed'))).toBe(false);
  });

  it('--wait is patient on a first install: it waits for the install, then for the window', async () => {
    await fakeWindow(4792, project);
    register(4792, project, process.pid);
    const t0 = Date.now();
    const run = sh([pkgOpen, '--data', data, '--run', project], { env: { STUB_NPM_SLEEP: '2' } });
    const wait = sh([pkgOpen, '--data', data, '--wait', project, ' (note)'], { env: { NB_INSTALL_WAIT_SECS: '30' } });
    const [w] = await Promise.all([wait, run]);
    expect(w.code).toBe(0);
    expect(w.out).toBe(`NB: opened ${plainUrl(4792)} for ${project} (note).\n`);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(1900);
  });

  it('--wait gives up on an install that never finishes, pointing at the task output', async () => {
    const r = await sh([pkgOpen, '--data', data, '--wait', project], { env: { NB_INSTALL_WAIT_SECS: '1' } });
    expect(r.code).toBe(1);
    expect(r.out).toBe("NB: the first install is still running after 1s - see the background task's output.\n");
  });

  const lockAt = (o: { pid?: string; ts?: number }) => {
    const lock = path.join(prefix(), '.nb-install.lock');
    fs.mkdirSync(lock, { recursive: true });
    if (o.pid !== undefined) fs.writeFileSync(path.join(lock, 'pid'), o.pid);
    if (o.ts !== undefined) fs.writeFileSync(path.join(lock, 'ts'), String(o.ts));
  };
  const now = () => Math.floor(Date.now() / 1000);

  it.each([
    ['an empty pid file, taken long ago', { ts: 1 }, {}],
    ['a dead pid', { pid: '999999', ts: now() - 10 }, {}],
    ['a live but recycled pid, taken longer ago than the stale limit', { pid: String(process.pid), ts: now() - 100 }, { NB_LOCK_STALE_SECS: '5' }],
  ])('a stale lock (%s) is reclaimed and the install goes ahead', async (_n, lock, extra) => {
    lockAt(lock);
    const r = await sh([pkgOpen, '--data', data, '--run', project], { env: { NB_INSTALL_WAIT_SECS: '20', ...extra } });
    expect(r.code).toBe(0);
    expect(npmCalls()).toHaveLength(1);
    expect(fs.existsSync(path.join(prefix(), '.nb-install.lock'))).toBe(false);
  });

  it('a fresh lock of a live holder is respected (no second install) until it gives up', async () => {
    lockAt({ pid: String(process.pid), ts: now() });
    const r = await sh([pkgOpen, '--data', data, '--run', project], { env: { NB_INSTALL_WAIT_SECS: '2' } });
    expect(r.code).toBe(1);
    expect(r.out).toContain('another install of');
    expect(npmCalls()).toEqual([]);
    expect(fs.existsSync(path.join(prefix(), '.nb-install-failed'))).toBe(true); // --wait learns of it
  });

  it('every failure writes the marker: npm missing in --run, and --wait reports it at once', async () => {
    const tools = ['dirname', 'tr', 'sed', 'uname', 'cat', 'mkdir', 'tee', 'rm', 'date', 'find', 'tail', 'kill'].map((x): [string, string] => [x, which(x)]);
    const env = { PATH: binDir('nonpm-run', [...tools, ['node', process.execPath]]) };
    const r = await sh([pkgOpen, '--data', data, '--run', project], { env });
    expect(r.code).toBe(1);
    expect(r.out).toContain('NB: npm not found on PATH');
    const t0 = Date.now();
    const w = await sh([pkgOpen, '--data', data, '--wait', project], { env });
    expect(w.code).toBe(1);
    expect(w.out).toContain('NB: npm not found on PATH');
    expect(Date.now() - t0).toBeLessThan(5000);
  });

  it('a launcher file without the installed marker (a half-written install) is not enough: --wait keeps waiting for the marker', async () => {
    fs.mkdirSync(path.dirname(pkgBin()), { recursive: true });
    fs.writeFileSync(pkgBin(), '// half');
    const r = await sh([pkgOpen, '--data', data, '--wait', project], { env: { NB_INSTALL_WAIT_SECS: '1' } });
    expect(r.code).toBe(1);
    expect(r.out).toBe("NB: the first install is still running after 1s - see the background task's output.\n");
  });

  it('SKILL.md passes the data dir single-quoted on every line: a live ${...} makes Claude Code refuse the line before any turn', () => {
    const md = fs.readFileSync(path.join(SKILL, 'SKILL.md'), 'utf8');
    const uses = md.split('\n').filter((l) => l.includes('CLAUDE_PLUGIN_DATA'));
    expect(uses.length).toBeGreaterThan(0);
    for (const l of uses) {
      expect(l.replace(/'\$\{CLAUDE_PLUGIN_DATA\}'/g, '')).not.toContain('CLAUDE_PLUGIN_DATA');
    }
  });

  it('several waiters racing for a stale lock install once (a lock moved aside is never taken twice)', async () => {
    for (let trial = 0; trial < 3; trial++) {
      fs.rmSync(path.join(tmp, 'npm.log'), { force: true });
      fs.rmSync(data, { recursive: true, force: true });
      lockAt({ ts: 1 });
      const runs = Array.from({ length: 6 }, () => sh([pkgOpen, '--data', data, '--run', project], { env: { STUB_NPM_SLEEP: '1', NB_INSTALL_WAIT_SECS: '30' } }));
      const rs = await Promise.all(runs);
      expect(rs.map((r) => r.code)).toEqual([0, 0, 0, 0, 0, 0]);
      expect(npmCalls().length, `trial ${trial}`).toBe(1);
    }
  }, 60_000);

  it('--wait reports an interrupted install at once: a lock with a dead pid, or (after a short grace) no lock and no marker', async () => {
    lockAt({ pid: '999999', ts: now() - 10 });
    const t0 = Date.now();
    let w = await sh([pkgOpen, '--data', data, '--wait', project]);
    expect(w.code).toBe(1);
    expect(w.out).toContain('did not finish: the background task stopped or never started');
    fs.rmSync(path.join(prefix(), '.nb-install.lock'), { recursive: true });
    w = await sh([pkgOpen, '--data', data, '--wait', project], { env: { NB_INSTALL_GRACE_SECS: '1' } });
    expect(w.code).toBe(1);
    expect(w.out).toContain('did not finish');
    expect(Date.now() - t0).toBeLessThan(8000);
  });

  it('--plan on a data dir it cannot write: one NB: line naming the sandbox, exit 0, no NB-RUN, no retry advice', async () => {
    fs.mkdirSync(data);
    fs.chmodSync(data, 0o555);
    try {
      const r = await plan('new');
      expect(r.code).toBe(0);
      expect(r.out.trimEnd().split('\n')).toHaveLength(1);
      expect(r.out).toMatch(/^NB: cannot write to the plugin data dir .*9\.9\.9.*sandbox/);
      expect(r.out).not.toMatch(/NB-RUN|run \/nb again/i);
    } finally {
      fs.chmodSync(data, 0o755);
    }
  });

  it('SKILL.md allowed-tools pins the two patterns that survive a quoted (spaced or non-ASCII) path', () => {
    const md = fs.readFileSync(path.join(SKILL, 'SKILL.md'), 'utf8');
    expect(/^allowed-tools: (.*)$/m.exec(md)?.[1]).toBe('Bash(*/nb/open.sh* *), Bash(node */bin/nota-bene.mjs* *)');
  });

  it('a second --run during an install waits for it instead of installing twice', async () => {
    fs.rmSync(path.join(tmp, 'argv.log'), { force: true });
    const first = sh([pkgOpen, '--data', data, '--run', project], { env: { STUB_NPM_SLEEP: '2' } });
    await new Promise((r) => setTimeout(r, 700));
    const second = await sh([pkgOpen, '--data', data, '--run', project]);
    await first;
    expect(second.code).toBe(0);
    expect(npmCalls()).toHaveLength(1);
    expect(launches()).toHaveLength(2);
  });

  it.each([['22.0.0', true], ['22.99.1', true], ['21.9.0', false]])('node floor of the package path is 22 (%s)', async (v, ok) => {
    const d = binDir('floornode', [['node', `#!/bin/sh\necho ${v}\n`]]);
    const r = await plan('new', { env: { PATH: `${d}:${process.env.PATH}` } });
    if (ok) expect(r.code).toBe(0);
    else {
      expect(r.code).toBe(0);
      expect(r.out).toBe(`NB: Nota Bene needs Node >= 22; found ${v} at ${d}/node. Make it the default node for Claude Code's shell (e.g. nvm alias default).\n`);
    }
  });

  it('a checkout still needs 23.6 even when the package floor is lower', async () => {
    const d = binDir('floornode2', [['node', '#!/bin/sh\necho 22.5.0\n']]);
    const r = await nb('', { env: { PATH: `${d}:${process.env.PATH}` } });
    expect(r.out).toContain('needs Node >= 23.6; found 22.5.0');
  });

  it('a Cyrillic folder with an apostrophe: single-quoted, the quote closed and reopened, and read back exactly', async () => {
    const odd = path.join(project, "Проект д'Артаньяна");
    fs.mkdirSync(odd);
    const run = lines(await plan('new', { cwd: odd }))['NB-RUN']!;
    expect(run).toContain("д'\\''Артаньяна");
    expect(run).not.toContain("$'");
    const back = execFileSync('/bin/bash', ['-c', 'eval "set -- $RUN"; printf "%s\\n" "$@"'], { encoding: 'utf8', env: { RUN: run } }).trim().split('\n');
    expect(back.slice(-2)).toEqual([odd, '--new']);
  });

  it("a control character in a folder name keeps %q's $'...' form (the only form that can carry it)", async () => {
    const odd = path.join(project, 'tab\there');
    fs.mkdirSync(odd);
    const run = lines(await plan('new', { cwd: odd }))['NB-RUN']!;
    expect(run).toContain("$'");
    const back = execFileSync('/bin/bash', ['-c', 'eval "set -- $RUN"; printf "%s\\n" "$@"'], { encoding: 'utf8', env: { RUN: run } }).split('\n');
    expect(back).toContain(odd);
  });

  it('an ASCII folder with a space: single-quoted, never a backslash-escaped space (Claude Code refuses those)', async () => {
    installed(); // the wait then carries the --last note
    const odd = path.join(project, 'my project');
    fs.mkdirSync(odd);
    const r = await plan('', { cwd: odd });
    expect(r.out).not.toMatch(/\\ /);
    expect(lines(r)['NB-RUN']).toContain(`'${odd}'`);
    expect(lines(r)['NB-WAIT']).toContain(`'${odd}'`);
    expect(lines(r)['NB-WAIT']).toContain("' (new session: no earlier window session for this folder)'"); // spaces and parentheses
  });

  it('the quoting sed runs under LC_ALL=C whatever the user\'s locale (invalid UTF-8 would be dropped otherwise)', async () => {
    const log = path.join(tmp, 'sed-locale.log');
    fs.rmSync(log, { force: true });
    const d = binDir('sedspy', [['sed', `#!/bin/sh\necho "$LC_ALL" >> "${log}"\nexec ${which('sed')} "$@"\n`]]);
    const odd = path.join(project, "Проект д'А");
    fs.mkdirSync(odd);
    const r = await plan('new', { cwd: odd, env: { PATH: `${d}:${process.env.PATH}`, LC_ALL: 'en_US.UTF-8', LANG: 'en_US.UTF-8' } });
    expect(lines(r)['NB-RUN']).toContain("д'\\''А");
    const seen = fs.readFileSync(log, 'utf8').trim().split('\n');
    expect(seen.filter((l) => l !== 'C' && l !== 'en_US.UTF-8')).toEqual([]);
    expect(seen.filter((l) => l === 'C').length).toBeGreaterThan(0); // the quoting calls
  });

  it('the plan\'s NB-RUN reads back exactly in bash with a data dir and a folder whose names have spaces and quotes', async () => {
    const odd = path.join(path.dirname(project), "my p r$oj 'x'");
    fs.mkdirSync(odd);
    const r = await plan('new', { cwd: odd, data: path.join(path.dirname(project), "da ta $x") });
    const run = lines(r)['NB-RUN'];
    const back = execFileSync('/bin/bash', ['-c', 'eval "set -- $RUN"; printf "%s\\n" "$@"'], { encoding: 'utf8', env: { RUN: run } }).trim().split('\n');
    expect(back).toEqual([pkgOpen, '--data', path.join(path.dirname(project), 'da ta $x'), '--run', odd, '--new']);
  });
});
