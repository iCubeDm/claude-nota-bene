// The demo project ("shortly", a tiny URL shortener) and the scripted fake agent. Everything here is invented for the
// README media: neutral names, nothing from a real project.
import fs from 'node:fs';
import path from 'node:path';

export const FILES = {
  'package.json': `{
  "name": "shortly",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": { "start": "node src/server.ts", "test": "node --test" }
}
`,
  'README.md': `# shortly

A tiny URL shortener. \`POST /links\` with a URL, get back a short code;
\`GET /<code>\` redirects to the original address.

## Run

\`\`\`sh
npm start
\`\`\`
`,
  'src/shorten.ts': `import { randomInt } from 'node:crypto';

// No 0/o/1/l: codes get read aloud and typed by hand.
const ALPHABET = '23456789abcdefghijkmnpqrstuvwxyz';

export const CODE_LENGTH = 6;

/** A random code of \`length\` characters, drawn with the crypto RNG so it cannot be guessed from earlier ones. */
export function newCode(length = CODE_LENGTH): string {
  let code = '';
  for (let i = 0; i < length; i++) code += ALPHABET[randomInt(ALPHABET.length)];
  return code;
}

export function isValidCode(code: string): boolean {
  return code.length === CODE_LENGTH && [...code].every((c) => ALPHABET.includes(c));
}

export function normalizeUrl(input: string): string {
  const url = new URL(/^https?:\\/\\//i.test(input) ? input : \`https://\${input}\`);
  url.hash = '';
  return url.toString();
}
`,
  'src/store.ts': `import { newCode } from './shorten.ts';

export type Link = { code: string; url: string; createdAt: number; hits: number };

const MAX_ATTEMPTS = 5;
const links = new Map<string, Link>();

export function save(url: string): Link {
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const code = newCode();
    if (links.has(code)) continue;
    const link: Link = { code, url, createdAt: Date.now(), hits: 0 };
    links.set(code, link);
    return link;
  }
  throw new Error('could not find a free code');
}

export function resolve(code: string): Link | undefined {
  const link = links.get(code);
  if (link) link.hits++;
  return link;
}

export function stats() {
  let hits = 0;
  for (const l of links.values()) hits += l.hits;
  return { total: links.size, hits };
}
`,
  'src/server.ts': `import http from 'node:http';
import { isValidCode, normalizeUrl } from './shorten.ts';
import { resolve, save } from './store.ts';

const PORT = Number(process.env.PORT ?? 3000);

const server = http.createServer(async (req, res) => {
  if (req.method === 'POST' && req.url === '/links') {
    let body = '';
    for await (const chunk of req) body += chunk;
    try {
      const { url } = JSON.parse(body) as { url: string };
      const link = save(normalizeUrl(url));
      res.writeHead(201, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ code: link.code }));
    } catch {
      res.writeHead(400).end('bad request');
    }
    return;
  }
  const code = (req.url ?? '').slice(1);
  const link = isValidCode(code) ? resolve(code) : undefined;
  if (!link) return void res.writeHead(404).end('not found');
  res.writeHead(302, { location: link.url }).end();
});

server.listen(PORT, () => console.log(\`shortly on :\${PORT}\`));
`,
  'src/shorten.test.ts': `import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CODE_LENGTH, isValidCode, newCode, normalizeUrl } from './shorten.ts';

test('a new code has the right length and is valid', () => {
  const code = newCode();
  assert.equal(code.length, CODE_LENGTH);
  assert.ok(isValidCode(code));
});

test('normalizeUrl adds a scheme and drops the fragment', () => {
  assert.equal(normalizeUrl('example.com/a#top'), 'https://example.com/a');
});
`,
  'web/styles.css': `:root { --accent: #4f46e5; --ink: #1f2430; }
body { font: 16px/1.5 system-ui, sans-serif; color: var(--ink); }
.cta { height: 36px; padding: 0 14px; border: 1px solid #c9ccd6; border-radius: 6px; background: #fff; }
.result { margin-top: 24px; padding: 16px; border-radius: 10px; background: #f3f4f8; }
`,
  'src/ui/result.ts': `export function show(code: string): void {
  const el = document.querySelector('.result')!;
  el.textContent = \`shortly.example/\${code}\`;
}
`,
  'docs/notes.md': `# Notes

- Codes are 6 characters, see \`src/shorten.ts\`.
- The store is in memory for now.
`,
};

/** The prompts and fixed texts of the scenes. The fake matches a turn by a phrase of the prompt (a sent batch carries its comments' text). */
export const TEXT = {
  intro: 'Give me a quick overview of the project.',
  introReply:
    '`shortly` is a small URL shortener written in TypeScript with no dependencies.\n\n' +
    '- `src/shorten.ts` generates and validates the short codes.\n' +
    '- `src/store.ts` keeps the links in memory and counts the hits.\n' +
    '- `src/server.ts` is the HTTP layer: `POST /links` creates a link, `GET /<code>` redirects.\n\n' +
    'There are unit tests for the code helpers in `src/shorten.test.ts`.',
  ask: 'How are the short codes generated, and what happens if two links get the same code?',
  reply:
    'Codes come from `newCode()` in `src/shorten.ts`: 6 characters from a 32-letter alphabet that leaves out look-alikes (`0`, `o`, `1`, `l`), drawn with `crypto.randomInt`, so one code cannot be guessed from the one before it.\n\n' +
    'That gives about a billion codes (32^6). Collisions are rare at this size but not impossible, so `save()` in `src/store.ts` retries up to five times and then throws an error.\n\n' +
    'Links are kept in an in-memory `Map`. Nothing is written to disk, so a restart loses every link.\n\n' +
    'Say the word and I can make both of those more forgiving.',
  // hero: two comments on the reply
  heroC1: "Don't throw. Use a longer code instead.",
  heroC2: 'Keep links in a file.',
  heroAnswer:
    'Both changes are in `src/store.ts`.\n\n' +
    '1. `save()` no longer throws: after five failed attempts it switches to an 8-character code, so a collision cannot fail a request.\n' +
    '2. Links are written to `data/links.json` on every save and loaded at startup, so a restart keeps them.',
  // code
  codeAsk: 'Can you review the retry loop in the store?',
  codeReply:
    'The loop in `save()` is correct, but two things are worth a look: the attempt limit is a magic number, and a collision is not logged, so you would never know the codes are filling up.',
  codeC: 'Log a warning on every collision.',
  codeAnswer:
    'Done. `save()` now logs `shortly: code collision, attempt N of 5` on every retry. The limit is still `MAX_ATTEMPTS`, so the message stays in step with it if you change the number.',
  // image
  imgAsk: 'Here is the design for the landing page: `design/landing.png`. What do you think?',
  imgReply:
    'The layout is clear: one input, one action, and the result right below. I would only check the contrast of the button and the space around the result card on a narrow screen.',
  imgC: 'Make this button at least 48 px tall.',
  imgAnswer:
    'Agreed. The button is now 48 px tall, with the accent colour and a 16 px label.',
  // video
  vidAsk: 'I recorded the flow: `media/flow.mp4`. Anything to improve?',
  vidReply:
    'The flow reads well from start to finish. The one thing I would check is what the user sees right after the click, because the result appears without much of a cue.',
  vidC: 'Show "Copied" here.',
  vidAnswer:
    'Done. After the click the new link is copied to the clipboard and a small "Copied" label fades in beside the code for two seconds (`src/ui/result.ts`).',
};

export const COMMANDS = [
  { name: 'review', description: 'Review the pending changes for bugs and style', argumentHint: '[path]' },
  { name: 'test-plan', description: 'Draft a test plan for the current change', argumentHint: '[topic]' },
  { name: 'release-notes', description: 'Write release notes from the git history' },
  { name: 'explain', description: 'Explain a file or a function in plain words', argumentHint: '<path>' },
  { name: 'compact', description: 'Free up context by summarising the conversation', argumentHint: '[focus]', builtin: true },
  { name: 'clear', description: 'Start a new conversation with an empty context', builtin: true },
  { name: 'context', description: 'Show what fills the context window', builtin: true },
  { name: 'usage', description: 'Show session cost and plan usage', builtin: true, aliases: ['cost'] },
  { name: 'code-review', description: 'Review the current diff for correctness bugs', builtin: true },
  { name: 'init', description: 'Create a CLAUDE.md with project notes', builtin: true },
];

/** The fake-agent script. Replies stream in small chunks at a pace a viewer can read. */
export function fakeScript() {
  const stream = { chunk: 12, delayMs: 30 };
  const edit = (file, oldS, newS) => ({ name: 'Edit', input: { file_path: file, old_string: oldS, new_string: newS }, output: `The file ${file} has been updated.` });
  return {
    commands: COMMANDS,
    turns: [
      { match: 'overview of the project', text: TEXT.introReply, ...stream },
      { match: 'short codes generated', text: TEXT.reply, ...stream },
      {
        match: TEXT.heroC1.slice(0, 20),
        text: TEXT.heroAnswer,
        ...stream,
        tools: [
          edit('src/store.ts', "throw new Error('could not find a free code');", 'return saveLong(url);'),
          edit('src/store.ts', 'const links = new Map<string, Link>();', 'const links = loadLinks();'),
        ],
      },
      { match: 'retry loop', text: TEXT.codeReply, ...stream },
      {
        match: TEXT.codeC.slice(0, 20),
        text: TEXT.codeAnswer,
        ...stream,
        tools: [edit('src/store.ts', 'if (links.has(code)) continue;', 'if (links.has(code)) {\n      console.warn(`shortly: code collision, attempt ${attempt + 1} of ${MAX_ATTEMPTS}`);\n      continue;\n    }')],
      },
      {
        match: 'at least 48 px',
        text: TEXT.imgAnswer,
        ...stream,
        tools: [edit('web/styles.css', '.cta { height: 36px; }', '.cta { height: 48px; background: var(--accent); font-size: 16px; }')],
      },
      {
        match: 'Show "Copied"',
        text: TEXT.vidAnswer,
        ...stream,
        tools: [edit('src/ui/result.ts', 'show(code);', 'show(code);\n  await navigator.clipboard.writeText(url);\n  flash("Copied", 2000);')],
      },
      // the plain-question turns come after the batch turns: a batch quotes the file path its comment is on
      { match: 'design/landing.png', text: TEXT.imgReply, ...stream },
      { match: 'media/flow.mp4', text: TEXT.vidReply, ...stream },
      { text: 'Sure. What would you like to look at?', ...stream },
    ],
  };
}

export function writeProject(dir) {
  for (const [rel, body] of Object.entries(FILES)) {
    const p = path.join(dir, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, body);
  }
}
