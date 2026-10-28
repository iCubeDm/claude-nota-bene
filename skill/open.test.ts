// Runs skill/open.sh (the /nb skill's launcher) with /bin/bash, a temp HOME / NOTA_BENE_HOME / CLAUDE_CONFIG_DIR, stub
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
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const SKILL = fileURLToPath(new URL('.', import.meta.url));
const REAL_BIN = fileURLToPath(new URL('../bin/nota-bene.mjs', import.meta.url));
const FAKE = fileURLToPath(new URL('../server/test/fixtures/hello.json', import.meta.url));
const SID = '0123abcd-4567-89ab-cdef-0123456789ab';

let tmp: string; // the whole suite's temp root (also TMPDIR of every run)
let home: string; // HOME of every run
let nbHome: string;
let claudeDir: string;
let project: string;
let stubApp: string; // tmp/stub-skills/nb/open.sh → tmp/app/skill (a symlink, like ~/.claude/skills/nb)
let realSkill: string; // tmp/real-skills/nb/open.sh → <repo>/skill
const servers: http.Server[] = [];

beforeAll(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nb-skill-')));
  // the stub app: open.sh resolves the app from its own (physical) location, so a copy beside a stub bin uses the stub
  fs.mkdirSync(path.join(tmp, 'app/skill'), { recursive: true });
  fs.mkdirSync(path.join(tmp, 'app/bin'));
  fs.copyFileSync(path.join(SKILL, 'open.sh'), path.join(tmp, 'app/skill/open.sh'));
  fs.writeFileSync(path.join(tmp, 'app/bin/nota-bene.mjs'), `
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
const argv = process.argv.slice(2);
if (argv[0] === '--find' || argv[0] === '--last') {
  const r = spawnSync(process.execPath, [process.env.STUB_REAL_BIN, ...argv], { stdio: 'inherit' });
  process.exit(r.status ?? 1);
}
fs.appendFileSync(process.env.STUB_ARGV, JSON.stringify(argv) + '\\n');
if (process.env.STUB_FAIL) {
  process.stderr.write('nota-bene: the server did not come up in 20s. Last log lines:\\nboom: the last log line\\n');
  process.exit(1);
}
process.stdout.write((process.env.STUB_OUT || 'opened http://127.0.0.1:4795') + '\\n');
`);
  for (const [name, target] of [['stub-skills', path.join(tmp, 'app/skill')], ['real-skills', SKILL]] as const) {
    fs.mkdirSync(path.join(tmp, name));
    fs.symlinkSync(target, path.join(tmp, name, 'nb'));
  }
  stubApp = path.join(tmp, 'stub-skills/nb/open.sh');
  realSkill = path.join(tmp, 'real-skills/nb/open.sh');
  // no real browser: `open` / `xdg-open` record their argument
  fs.mkdirSync(path.join(tmp, 'path'));
  for (const name of ['open', 'xdg-open']) {
    const f = path.join(tmp, 'path', name);
    fs.writeFileSync(f, `#!/bin/sh\necho "$1" >> "${tmp}/opened.log"\n`);
    fs.chmodSync(f, 0o755);
  }
});

beforeEach(() => {
  const t = fs.mkdtempSync(path.join(tmp, 't-'));
  home = path.join(t, 'home');
  nbHome = path.join(t, 'nb');
  claudeDir = path.join(t, 'claude');
  project = path.join(t, 'project');
  for (const d of [home, nbHome, claudeDir, project]) fs.mkdirSync(d);
  fs.rmSync(path.join(tmp, 'opened.log'), { force: true });
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
    if (req.url === '/info') res.setHeader('content-type', 'application/json').end(JSON.stringify({ root, session: null }));
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
    expect(r.out).toBe('NB: already open at http://127.0.0.1:4792 (brought to front).\n');
    expect(opened()).toEqual(['http://127.0.0.1:4792']);
    expect(launches()).toEqual([]);
  });

  it('with fork it says the window was NOT switched', async () => {
    await fakeWindow(4792, project);
    register(4792, project, process.pid);
    const r = await nb('fork');
    expect(r.out).toBe('NB: a window is already open on this folder at http://127.0.0.1:4792 (brought to front). It was '
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
    expect(opened()).toEqual(['http://127.0.0.1:4792']);
  });

  it('an unregistered window (a lost registry write) is found by the /info scan', async () => {
    await fakeWindow(4791, path.join(tmp, 'elsewhere'));
    await fakeWindow(4793, project);
    const r = await nb('new');
    expect(r.out).toBe('NB: already open at http://127.0.0.1:4793 (brought to front).\n');
    expect(opened()).toEqual(['http://127.0.0.1:4793']);
    expect(launches()).toEqual([]);
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

  // only the tools open.sh needs: no curl, no open / xdg-open, and a uname that says Linux
  const sandbox = () => binDir('sandbox', [
    ...['dirname', 'tr', 'sed', 'seq', 'mktemp', 'cat', 'rm'].map((t): [string, string] => [t, which(t)]),
    ['node', process.execPath],
    ['uname', '#!/bin/sh\necho Linux\n'],
  ]);

  it('without curl the /info scan is skipped (the launch goes to the bin, whose re-check covers it)', async () => {
    await fakeWindow(4793, project); // unregistered: only a scan would see it
    const r = await nb('new', { env: { PATH: sandbox() } });
    expect(r.out).toMatch(/^NB: opened http:\/\/127\.0\.0\.1:4795 for /);
    expect(launches()).toEqual([[project, '--detach', '--new']]);
  });

  it('on Linux without xdg-open it says to open the URL instead of "brought to front"', async () => {
    await fakeWindow(4792, project);
    register(4792, project, process.pid);
    const r = await nb('', { env: { PATH: sandbox() } });
    expect(r.code).toBe(0);
    expect(r.out).toBe('NB: already open at http://127.0.0.1:4792 (open it in your browser).\n');
  });

  it('the /info scan covers 4777-4799 but skips the dev port 4780 (curl stubbed: no real port is touched)', async () => {
    const log = path.join(tmp, 'curl.log');
    fs.rmSync(log, { force: true });
    const d = binDir('fakecurl', [['curl', `#!/bin/sh\nfor a; do last="$a"; done\necho "$last" >> "${log}"\n`]]);
    const r = await nb('new', { env: { PATH: `${d}:${path.join(tmp, 'path')}:${path.dirname(process.execPath)}:${process.env.PATH}`, NOTA_BENE_PORT_RANGE: '' } });
    expect(r.out).toMatch(/^NB: opened /);
    const ports = fs.readFileSync(log, 'utf8').trim().split('\n').map((u) => Number(/:(\d+)\/info$/.exec(u)![1]));
    const expected = [];
    for (let p = 4777; p <= 4799; p++) if (p !== 4780) expected.push(p);
    expect(ports).toEqual(expected);
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
        const r = await fetch(`http://127.0.0.1:${p}/info`, { signal: AbortSignal.timeout(500) });
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
      + String.raw`\ \(new\ session:\ no\ earlier\ window\ session\ for\ this\ folder\)`);
    const id = 'feedface-0000-4000-8000-000000000001';
    fs.writeFileSync(path.join(nbHome, 'sessions.json'), JSON.stringify({ [project]: id }));
    fs.mkdirSync(path.join(claudeDir, 'projects/p'), { recursive: true });
    fs.writeFileSync(path.join(claudeDir, 'projects/p', `${id}.jsonl`), '');
    r = await plan('');
    expect(lines(r)['NB-RUN']).toBe(`node ${stubBin()} ${project}`);
    expect(lines(r)['NB-WAIT']).toBe(`${stubApp} --wait ${project} `
      + String.raw`\ \(resumed\ the\ last\ window\ session\ feedface\)`);
    expect(launches()).toEqual([]);
  });

  it('fork with a valid session id: --resume SID --fork', async () => {
    const r = await plan('форк');
    expect(r.code).toBe(0);
    expect(lines(r)['NB-RUN']).toBe(`node ${stubBin()} ${project} --resume ${SID} --fork`);
    expect(lines(r)['NB-WAIT']).toBe(`${stubApp} --wait ${project} ` + String.raw`\ \(forked\ from\ this\ conversation\)`);
  });

  it('a window already open on the folder: the usual NB: line, brought to front, no NB-RUN', async () => {
    await fakeWindow(4792, project);
    register(4792, project, process.pid);
    let r = await plan('');
    expect(r.out).toBe('NB: already open at http://127.0.0.1:4792 (brought to front).\n');
    expect(opened()).toEqual(['http://127.0.0.1:4792']);
    r = await plan('fork');
    expect(r.out).toMatch(/^NB: a window is already open on this folder at http:\/\/127\.0\.0\.1:4792 .*NOT switched/);
    await fakeWindow(4793, path.join(tmp, 'elsewhere'));
    const other = path.join(project, 'sub');
    fs.mkdirSync(other);
    await fakeWindow(4794, other); // unregistered: found by the /info scan
    r = await plan('new', { cwd: other });
    expect(r.out).toBe('NB: already open at http://127.0.0.1:4794 (brought to front).\n');
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
    expect(r.code).toBe(1);
    expect(r.out).toBe("NB: no valid session id to fork ('x; rm -rf ~').\n");
    const d = binDir('oldnode-plan', [['node', '#!/bin/sh\necho 23.5.1\n']]);
    r = await plan('', { env: { PATH: `${d}:${process.env.PATH}` } });
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/^NB: Nota Bene needs Node >= 23\.6; found 23\.5\.1/);
    expect(launches()).toEqual([]);
  });

  it('a folder named `p r$oj Проект`: both commands are plain ASCII and read back exactly in bash and zsh', async () => {
    const odd = path.join(project, 'p r$oj Проект');
    fs.mkdirSync(odd);
    const r = await plan('new', { cwd: odd });
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/^[\x20-\x7e\n]*NB-NAME: Nota Bene · p r\$oj Проект\n$/); // no raw byte before the name
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
      expect(w).toEqual({ code: 0, out: `NB: opened http://127.0.0.1:4792 for ${odd}.\n` });
    }
  });
});

describe('--wait', () => {
  it('prints the URL with the note once the window is up', async () => {
    await fakeWindow(4793, project);
    register(4793, project, process.pid);
    const r = await sh([stubApp, '--wait', project, ' (forked from this conversation)']);
    expect(r).toEqual({ code: 0, out: `NB: opened http://127.0.0.1:4793 for ${project} (forked from this conversation).\n` });
  });

  it('polls until a window that comes up later is registered', async () => {
    const waiting = sh([stubApp, '--wait', project]);
    await new Promise((res) => setTimeout(res, 1200));
    await fakeWindow(4794, project);
    register(4794, project, process.pid);
    expect(await waiting).toEqual({ code: 0, out: `NB: opened http://127.0.0.1:4794 for ${project}.\n` });
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
