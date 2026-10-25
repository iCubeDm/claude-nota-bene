// Throwaway spike: browser chat over Claude Agent SDK with inline comments.
// Usage: node server.mjs [projectDir] [--port 4777] [--resume <sessionId> [--fork]] [--continue]
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, execFile } from 'node:child_process';
import { WebSocketServer } from 'ws';
import { query, getSessionMessages, listSessions, getSessionInfo } from '@anthropic-ai/claude-agent-sdk';

const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const flag = (name) => { const i = args.indexOf(name); return i >= 0 ? args.splice(i, 2)[1] : undefined; };
const bool = (name) => { const i = args.indexOf(name); return i >= 0 ? (args.splice(i, 1), true) : false; };
const PORT = Number(flag('--port') || 4777);
const CONTINUE = bool('--continue');

// .sessions.json: last session id per project dir, plus `_root:<port>` — the project this server instance was
// last on. --continue (↻ restart, session switch) reopens `_root`, so a session from another folder
// survives the relaunch even though ide.sh passes the original project dir again.
const SESSIONS_FILE = path.join(here, '.sessions.json');
const readSessions = () => { try { return JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8')); } catch { return {}; } };
const writeSessions = (patch) => fs.writeFileSync(SESSIONS_FILE, JSON.stringify({ ...readSessions(), ...patch }, null, 2));
const isDir = (d) => { try { return fs.statSync(d).isDirectory(); } catch { return false; } };
// realpath: session cwd is stored resolved (/tmp → /private/tmp on macOS), and we compare against it
const ARG_ROOT = fs.realpathSync(path.resolve(args.find((a) => !a.startsWith('--')) || process.cwd()));
const ROOT_KEY = `_root:${PORT}`; // per port: two ide.sh windows must not drag each other between projects
const ROOT = CONTINUE && isDir(readSessions()[ROOT_KEY]) ? readSessions()[ROOT_KEY] : ARG_ROOT;
writeSessions({ [ROOT_KEY]: ROOT });
const saveSession = (id) => writeSessions({ [ROOT]: id ?? undefined });
// --continue wins over --resume: ide.sh relaunches with the original args plus --continue, and the
// session picker (/switch) works by rewriting .sessions.json before that relaunch
const RESUME_ARG = flag('--resume');
const RESUME = CONTINUE ? readSessions()[ROOT] : RESUME_ARG;
// --fork: branch off --resume into a new session id. The /nb skill uses it to carry a live terminal
// conversation over without both processes appending to one transcript. Relaunches resume the fork itself.
const FORK = bool('--fork') && !CONTINUE && !!RESUME;
let currentSession = RESUME;
const RESTART_CODE = 75;
// permission mode (Shift+Tab in the CLI): kept per port so ↻ and session switches don't drop you out of plan mode
const MODES = ['default', 'acceptEdits', 'plan', 'auto'];
const MODE_KEY = `_mode:${PORT}`;
let currentMode = MODES.includes(readSessions()[MODE_KEY]) ? readSessions()[MODE_KEY] : 'auto';

const APPEND = `
You are running inside a browser-based chat window that renders GitHub-flavored markdown.
- Draw diagrams as \`\`\`mermaid code blocks (or \`\`\`svg blocks with a complete <svg> element). Never draw ASCII-art diagrams.
- To show an image or video from the project, embed it with markdown image syntax and a path relative to the project root, e.g. ![frame](part_1/frames/1.01.png) or ![clip](part_1/video/1.01.mp4). Videos and audio files render as players.
- Refer to project files as inline code with a path relative to the project root (\`media/pilot/notes.md\`, not an absolute or ~ path): the UI makes these clickable and opens them in a tab. Paths outside the project cannot be opened, so do not present them as links.
- The user may send batched inline comments: each item quotes a fragment from the conversation or a file, followed by their comment. Address every item.`;

// ---------- agent session ----------
const clients = new Set();
const history = []; // every event sent to clients, replayed on reconnect
const broadcast = (ev) => {
  ev.ts = Date.now();
  history.push(ev);
  const s = JSON.stringify(ev);
  for (const c of clients) if (c.readyState === 1) c.send(s);
};

// async queue feeding the SDK's streaming input
const pending = [];
let wake = null;
const input = {
  async *[Symbol.asyncIterator]() {
    while (true) {
      while (pending.length) yield pending.shift();
      await new Promise((r) => (wake = r));
    }
  },
};
const push = (msg) => { pending.push(msg); wake?.(); wake = null; };

// rebuild the feed from the transcript when resuming
if (RESUME) {
  try {
    for (const sm of await getSessionMessages(RESUME, { dir: ROOT })) {
      const content = sm.message?.content;
      if (sm.type === 'assistant') {
        history.push({ kind: 'sdk', m: { type: 'assistant', message: sm.message, parent_tool_use_id: sm.parent_tool_use_id } });
      } else if (sm.type === 'user' && !sm.parent_tool_use_id) {
        if (Array.isArray(content) && content.some((b) => b.type === 'tool_result')) continue;
        // pasted images go as [label text, image] pairs (see toContent): labels back to the image, the rest is the prompt
        const blocks = typeof content === 'string' ? [{ type: 'text', text: content }] : content || [];
        const text = blocks.filter((b, i) => b.type === 'text' && blocks[i + 1]?.type !== 'image').map((b) => b.text).join('\n');
        const images = blocks.flatMap((b, i) => b.type === 'image' && b.source?.type === 'base64'
          ? [{ media_type: b.source.media_type, data: b.source.data, label: blocks[i - 1]?.type === 'text' ? blocks[i - 1].text : '' }] : []);
        if (text.trim() || images.length) history.push({ kind: 'user', text, comments: [], images, historic: true });
      }
    }
    history.push({ kind: 'resumed', session: RESUME });
  } catch (e) {
    history.push({ kind: 'error', message: `could not load transcript: ${e}` });
  }
}

const permissionWaiters = new Map();
let permSeq = 0;

const q = query({
  prompt: input,
  options: {
    cwd: ROOT,
    resume: RESUME,
    forkSession: FORK,
    permissionMode: currentMode,
    includePartialMessages: true,
    promptSuggestions: true, // predicted next prompt after each turn, as the CLI's grey ghost text
    // the SDK doesn't enable Claude in Chrome on its own — without the flag the session has no browser tools
    extraArgs: { chrome: null },
    systemPrompt: { type: 'preset', preset: 'claude_code', append: APPEND },
    canUseTool: (toolName, toolInput, { signal }) =>
      new Promise((resolve) => {
        const id = String(++permSeq);
        permissionWaiters.set(id, resolve);
        signal.addEventListener('abort', () => {
          permissionWaiters.delete(id);
          resolve({ behavior: 'deny', message: 'aborted' });
        });
        broadcast({ kind: 'permission', id, toolName, input: toolInput });
      }),
  },
});

// listSessions() leaves cwd empty for some (large) transcripts; every transcript line carries it, so read the head
const PROJECTS_DIR = path.join(process.env.HOME, '.claude', 'projects');
const cwdCache = new Map();
function cwdOf(id) {
  if (cwdCache.has(id)) return cwdCache.get(id);
  let cwd = null;
  try {
    for (const d of fs.readdirSync(PROJECTS_DIR)) {
      const f = path.join(PROJECTS_DIR, d, id + '.jsonl');
      if (!fs.existsSync(f)) continue;
      const fd = fs.openSync(f, 'r'), buf = Buffer.alloc(262144);
      const n = fs.readSync(fd, buf, 0, buf.length, 0); fs.closeSync(fd);
      cwd = JSON.parse(buf.toString('utf8', 0, n).match(/"cwd":("(?:[^"\\]|\\.)*")/)?.[1] || 'null');
      break;
    }
  } catch {}
  cwdCache.set(id, cwd);
  return cwd;
}

// a session opened with /clear or /compact would otherwise be titled by that command
const titleOf = (x) => [x?.customTitle, x?.summary, x?.firstPrompt].find((t) => t && !t.startsWith('/')) || null;

// ---------- header stats: session title, context fill, plan limits ----------
// kept out of `history`: a reconnecting page only needs the latest snapshot
let stats = {};
const withTimeout = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))]);
const sendAll = (ev) => { const s = JSON.stringify(ev); for (const c of clients) if (c.readyState === 1) c.send(s); };
let limitsAt = 0;
async function refreshStats() {
  const next = { ...stats };
  if (currentSession) {
    const info = await getSessionInfo(currentSession, { dir: ROOT }).catch(() => null);
    next.title = titleOf(info);
  } else next.title = null;
  try {
    const c = await withTimeout(q.getContextUsage({ detail: 'summary' }), 10000);
    next.context = { used: c.totalTokens, max: c.rawMaxTokens || c.maxTokens, pct: c.percentage };
  } catch {}
  // /usage data is an experimental SDK call — throttle it and survive it disappearing
  if (Date.now() - limitsAt > 60000) {
    try {
      const u = await withTimeout(q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors: true }), 15000);
      limitsAt = Date.now();
      next.cost = u.session?.total_cost_usd;
      next.limits = u.rate_limits_available ? {
        five_hour: u.rate_limits?.five_hour || null, seven_day: u.rate_limits?.seven_day || null,
      } : null;
    } catch {}
  }
  stats = next;
  sendAll({ kind: 'stats', ...stats });
}
setInterval(() => { limitsAt = 0; refreshStats(); }, 5 * 60000);
setTimeout(refreshStats, 1500);
// the CLI builds its @-file index lazily on the first query: kick it off now so the first @ isn't empty
setTimeout(() => q.request({ subtype: 'file_suggestions', query: '' }).catch(() => {}), 2000);

(async () => {
  try {
    for await (const m of q) {
      if (m.type === 'system' && m.subtype === 'init') saveSession(currentSession = m.session_id);
      // the CLI changes the mode on its own too (approving a plan leaves plan mode): follow it
      if (m.type === 'system' && (m.subtype === 'init' || m.subtype === 'status') && m.permissionMode && m.permissionMode !== currentMode) setMode(m.permissionMode);
      // /clear: drop the replay buffer so a reload doesn't bring the old conversation back
      if (m.type === 'conversation_reset') {
        history.length = 0;
        if (m.new_conversation_id) saveSession(currentSession = m.new_conversation_id);
        stats.title = null;
      }
      broadcast({ kind: 'sdk', m });
      if (m.type === 'result' || m.type === 'conversation_reset' || (m.type === 'system' && m.subtype === 'compact_boundary')) refreshStats();
      if (m.type === 'rate_limit_event' && m.rate_limit_info?.rateLimitType in { five_hour: 1, seven_day: 1 } && m.rate_limit_info.utilization != null) {
        const i = m.rate_limit_info, pct = i.utilization <= 1 ? i.utilization * 100 : i.utilization;
        stats.limits = { ...stats.limits, [i.rateLimitType]: { utilization: pct, resets_at: i.resetsAt ? new Date(i.resetsAt * 1000).toISOString() : null } };
        sendAll({ kind: 'stats', ...stats });
      }
    }
  } catch (e) {
    broadcast({ kind: 'error', message: String(e?.stack || e) });
  }
})();

// images: [{media_type, data (base64), label}] from paste/drop in the composer or a comment.
// Each image is preceded by its label as a text block, so the agent can tell which comment it belongs to.
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
function toContent(text, images) {
  const ok = (images || []).filter((im) => IMAGE_TYPES.has(im.media_type) && typeof im.data === 'string');
  if (!ok.length) return text;
  return [{ type: 'text', text: text || ' ' }, ...ok.flatMap((im) => [
    { type: 'text', text: im.label || '[image]' },
    { type: 'image', source: { type: 'base64', media_type: im.media_type, data: im.data } },
  ])];
}

function setMode(mode) {
  currentMode = mode;
  writeSessions({ [MODE_KEY]: mode });
  sendAll({ kind: 'mode', mode });
}

let userSeq = 0;
function handleClient(msg) {
  if (msg.type === 'send') {
    const id = `u${++userSeq}`;
    broadcast({ kind: 'user', id, text: msg.text, comments: msg.comments || [], images: msg.images || [], force: !!msg.force });
    const deliver = () => push({
      type: 'user',
      message: { role: 'user', content: toContent(msg.text, msg.images) },
      parent_tool_use_id: null,
      priority: msg.force ? 'now' : 'next',
    });
    if (msg.force) q.interrupt().catch(() => {}).finally(deliver);
    else deliver();
  } else if (msg.type === 'command' && (msg.name === 'clear' || msg.name === 'compact')) {
    // built-in slash commands go through the same input stream as a typed prompt
    broadcast({ kind: 'user', id: `u${++userSeq}`, text: '/' + msg.name, comments: [] });
    push({ type: 'user', message: { role: 'user', content: '/' + msg.name }, parent_tool_use_id: null, priority: 'next' });
  } else if (msg.type === 'mode' && MODES.includes(msg.mode)) {
    q.setPermissionMode(msg.mode).then(() => setMode(msg.mode), (e) => { reportError('mode', e); sendAll({ kind: 'mode', mode: currentMode }); });
  } else if (msg.type === 'interrupt') {
    q.interrupt().catch(() => {});
  } else if (msg.type === 'permission') {
    const resolve = permissionWaiters.get(msg.id);
    if (!resolve) return;
    permissionWaiters.delete(msg.id);
    resolve(msg.allow ? { behavior: 'allow', updatedInput: msg.input } : { behavior: 'deny', message: 'User denied this action in the UI.' });
    broadcast({ kind: 'permission-done', id: msg.id, allow: !!msg.allow });
  }
}

// ---------- @-mention autocomplete ----------
// project file list: git ls-files when it's a repo (fast, respects .gitignore), else a capped walk; cached briefly
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', '__pycache__', '.venv', 'venv', '.cache', '.DS_Store']);
let fileList = null, fileListAt = 0;
function walk(dir, rel, out) {
  if (out.length >= 30000) return;
  let ents; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of ents) {
    if (SKIP_DIRS.has(e.name)) continue;
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) walk(path.join(dir, e.name), r, out); else out.push(r);
  }
}
const listFiles = () => new Promise((resolve) => {
  if (fileList && Date.now() - fileListAt < 15000) return resolve(fileList);
  const done = (files) => {
    const dirs = new Set();
    for (const f of files) for (let i = f.indexOf('/'); i >= 0; i = f.indexOf('/', i + 1)) dirs.add(f.slice(0, i) + '/');
    fileList = [...dirs, ...files]; fileListAt = Date.now(); resolve(fileList);
  };
  execFile('git', ['ls-files', '-co', '--exclude-standard'], { cwd: ROOT, maxBuffer: 64 << 20 }, (err, out) => {
    if (!err && out.trim()) return done(out.split('\n').filter(Boolean));
    const files = []; walk(ROOT, '', files); done(files);
  });
});
// fuzzy subsequence score: consecutive chars, segment starts and file-name hits rank higher; -1 = no match
function fuzzy(p, q) {
  const lp = p.toLowerCase(), base = lp.replace(/\/$/, '').lastIndexOf('/') + 1;
  let i = 0, last = -2, sc = 0;
  for (const ch of q) {
    const j = lp.indexOf(ch, i);
    if (j < 0) return -1;
    sc += (j === last + 1 ? 5 : 0) + (j === 0 || '/-_. '.includes(lp[j - 1]) ? 4 : 0) + (j >= base ? 2 : 0);
    last = j; i = j + 1;
  }
  const name = lp.slice(base);
  sc += name.startsWith(q) ? 25 : name.includes(q) ? 12 : lp.includes(q) ? 6 : 0;
  return sc - p.length * 0.05;
}

// fallback for /complete: our own fuzzy pass over the file list
const ownComplete = (q) => listFiles().then((all) => all.map((p) => [p, fuzzy(p, q)])
  .filter(([p, sc]) => sc >= 0 && p !== q).sort((a, b) => b[1] - a[1]).slice(0, 30).map(([p]) => p));

// ---------- http ----------
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml',
  '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm', '.m4v': 'video/mp4',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.m4a': 'audio/mp4', '.ogg': 'audio/ogg',
  '.md': 'text/plain; charset=utf-8', '.json': 'application/json', '.txt': 'text/plain; charset=utf-8',
};

// project files are served from the app's own origin: a project .svg or .html opened directly must not run script
// with access to the app's WebSocket (it could send messages to the agent)
const FILE_SAFETY = {
  'X-Content-Type-Options': 'nosniff',
  'Content-Security-Policy': "sandbox; default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'",
  'Cross-Origin-Resource-Policy': 'same-origin',
};
function serveFile(req, res, file) {
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404); return res.end('not found'); }
    const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
    const range = req.headers.range && /bytes=(\d*)-(\d*)/.exec(req.headers.range);
    // a stream error (file deleted mid-read, client gone) must end this response, not the whole server
    const stream = (opts) => fs.createReadStream(file, opts).on('error', (e) => { reportError(path.relative(ROOT, file) || file, e); res.destroy(); }).pipe(res);
    if (range && (range[1] || range[2])) {
      // `bytes=N-` from N, `bytes=-N` the last N bytes, end clamped to the file. Chrome seeking a video asks
      // for start == size at the very end: that is 416, not a crash (it used to throw and kill the server)
      let start = range[1] ? Number(range[1]) : Math.max(0, st.size - Number(range[2]));
      let end = range[1] && range[2] ? Math.min(Number(range[2]), st.size - 1) : st.size - 1;
      if (start >= st.size || start > end) {
        res.writeHead(416, { 'Content-Range': `bytes */${st.size}` }); return res.end();
      }
      res.writeHead(206, { ...FILE_SAFETY, 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Content-Range': `bytes ${start}-${end}/${st.size}`, 'Content-Length': end - start + 1 });
      stream({ start, end });
    } else {
      res.writeHead(200, { ...FILE_SAFETY, 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Content-Length': st.size });
      stream();
    }
  });
}

// last line of defence: one bad request must not take the agent session down with it (a crash used to leave
// the window on «no connection» for good). Logged, and the server keeps running.
// errors never take the server down: logged, and shown to the user as a toast in every open window
// (sent, not stored in `history`: a reload shouldn't bring back old errors)
function reportError(where, e) {
  console.error(`[${where}]`, e);
  sendAll({ kind: 'server-error', where, message: String(e?.message || e) });
}
process.on('uncaughtException', (e) => reportError('server', e));
process.on('unhandledRejection', (e) => reportError('server', e));

// only our own page may talk to us. The server binds 127.0.0.1, but a browser lets any site open
// ws://127.0.0.1:<port> or POST to /switch, and a DNS-rebinding domain can reach it by name — the agent runs
// commands, so: Host must be ours (HTTP + WebSocket), and Origin, when a browser sends one, must be ours too
const OWN_HOSTS = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`]);
const OWN_ORIGINS = new Set([...OWN_HOSTS].map((h) => `http://${h}`));
const hostOk = (req) => OWN_HOSTS.has(String(req.headers.host || '').toLowerCase());
const originOk = (req) => !req.headers.origin || OWN_ORIGINS.has(req.headers.origin);

// a throwing route answers 500 with the message (the page shows it) instead of killing the process
const server = http.createServer((req, res) => {
  // reads stay open to our own Origin-less loads (img/video tags); anything that changes state needs our Origin
  if (!hostOk(req) || (req.method !== 'GET' && req.method !== 'HEAD' && !originOk(req))) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('forbidden');
  }
  try { route(req, res); } catch (e) {
    reportError(req.url, e);
    if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(String(e?.message || e));
  }
});
function route(req, res) {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/') return serveFile(req, res, path.join(here, 'public', 'index.html'));
  if (/^\/(icon\.svg|favicon\.svg|icon-\d+\.png)$/.test(url.pathname)) return serveFile(req, res, path.join(here, 'public', url.pathname.slice(1)));
  if (url.pathname === '/info') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ root: ROOT, supervised: !!process.env.AI_IDE_SUPERVISED }));
  }
  if (url.pathname === '/sessions') {
    // all projects, not just ROOT: opening one from another folder moves this window to that folder
    return listSessions({ limit: 300 }).then((list) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        current: currentSession, root: ROOT,
        // no cwd → can't be resumed in the right folder, so leave it out rather than guess
        sessions: list.map((x) => ({ id: x.sessionId, title: titleOf(x) || '', at: x.lastModified, size: x.fileSize, cwd: x.cwd || cwdOf(x.sessionId) }))
          .filter((x) => x.cwd),
      }));
    }, (e) => { res.writeHead(500); res.end(String(e)); });
  }
  // switch session = remember the choice, then restart through ide.sh (it relaunches with --continue)
  if (url.pathname === '/switch' && req.method === 'POST') {
    if (!process.env.AI_IDE_SUPERVISED) { res.writeHead(409); return res.end('not running under ide.sh'); }
    const id = url.searchParams.get('id') || null; // empty = new session
    const dir = url.searchParams.get('dir') || ROOT;
    if (id && !/^[0-9a-f-]{36}$/i.test(id)) { res.writeHead(400); return res.end('bad id'); }
    if (!path.isAbsolute(dir) || !isDir(dir)) { res.writeHead(400); return res.end('project folder not found'); }
    writeSessions({ [ROOT_KEY]: dir, [dir]: id ?? undefined });
    res.writeHead(200); res.end('switching');
    return setTimeout(() => process.exit(RESTART_CODE), 100);
  }
  if (url.pathname === '/restart' && req.method === 'POST') {
    res.writeHead(200); res.end('restarting');
    // ide.sh relaunches with --continue on this exit code
    return setTimeout(() => process.exit(RESTART_CODE), 100);
  }
  if (url.pathname === '/complete') {
    const raw = url.searchParams.get('q') || '', lq = raw.toLowerCase();
    const send = (hits) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(hits)); };
    // the CLI's own @ search (same ranking as the TUI, plus skill/added dirs as absolute paths).
    // `request` is the SDK's internal control channel, not public API: on any failure, or while the CLI is
    // still indexing (it answers [] for a few seconds after start), fall back to our own search below
    return q.request({ subtype: 'file_suggestions', query: raw })
      .then((r) => r.response.suggestions.map((x) => x.path).filter((p) => p !== raw).slice(0, 30))
      .catch(() => [])
      .then((hits) => hits.length || !lq ? send(hits) : ownComplete(lq).then(send));
  }
  if (url.pathname === '/file' || url.pathname === '/tree') {
    const p = url.searchParams.get('path') || '';
    const abs = path.resolve(ROOT, p.replace(/^\/+/, ''));
    if (abs !== ROOT && !abs.startsWith(ROOT + path.sep)) { res.writeHead(403); return res.end('outside project'); }
    if (url.pathname === '/file') return serveFile(req, res, abs);
    return fs.readdir(abs, { withFileTypes: true }, (err, ents) => {
      if (err) { res.writeHead(404); return res.end('[]'); }
      const list = ents
        .filter((e) => e.name !== '.DS_Store' && e.name !== 'node_modules' && e.name !== '.git')
        .map((e) => ({ name: e.name, dir: e.isDirectory() }))
        .sort((a, b) => (b.dir - a.dir) || a.name.localeCompare(b.name, 'ru', { numeric: true }));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(list));
    });
  }
  res.writeHead(404); res.end();
}

const wss = new WebSocketServer({ server, verifyClient: ({ req }) => hostOk(req) && originOk(req) });
wss.on('connection', (ws) => {
  clients.add(ws);
  ws.send(JSON.stringify({ kind: 'replay', events: history }));
  ws.send(JSON.stringify({ kind: 'stats', ...stats }));
  ws.send(JSON.stringify({ kind: 'mode', mode: currentMode }));
  ws.on('message', (data) => { try { handleClient(JSON.parse(data)); } catch (e) { reportError('ws', e); } });
  ws.on('close', () => clients.delete(ws));
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Nota Bene: http://127.0.0.1:${PORT}  project: ${ROOT}`);
  if (!process.env.NO_OPEN) spawn('open', [`http://127.0.0.1:${PORT}`]);
});
