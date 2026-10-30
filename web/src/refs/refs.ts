import type { MouseEvent as ReactMouseEvent } from 'react';
import { t } from '@/i18n/index.ts';
import { fileUrl, isPath } from '@/files/kinds.ts';
import { isTmpImagePath } from '@/files/tmpImages.ts';
import { getSources, loadSources, refOf, sourceForAbs } from '@/files/sources.ts';
import type { AppThunk } from '@/store/store.ts';
import { openFile } from '@/tabs/slice.ts';

/** Folds `.`/`..` of `p` onto `baseDir`. null when it would climb above the project root. */
function normalize(p: string, baseDir?: string): string | null {
  const out: string[] = [];
  for (const seg of `${baseDir ?? ''}/${p}`.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (!out.length) return null;
      out.pop();
    } else out.push(seg);
  }
  return out.length ? out.join('/') : null;
}

/** `src/a.ts:42` / `src/a.ts:42:7` → `src/a.ts`. The line is ignored for now (scrolling to it is a later feature). */
const stripLine = (s: string) => s.replace(/:\d+(?::\d+)?$/, '');

/** `alt`: a second candidate, tried after `path` in each source (the other reading of a relative path). */
function mark(el: HTMLElement, first: string | null, src?: string, alt?: string | null) {
  const path = first ?? alt; // a reading that climbs above the root is no candidate
  if (!path) return;
  el.classList.add('ref');
  el.dataset.path = path;
  if (first && alt && alt !== first) el.dataset.alt = alt;
  if (src) el.dataset.src = src;
}

/**
 * An absolute path is a ref only inside the dir of a known source ('here' or a worktree, from /sources; M3-16).
 * isPath still refuses absolute paths: this is a separate check, with the same forbidden characters.
 */
function markAbs(el: HTMLElement, abs: string): void {
  if (!abs.startsWith('/') || abs.startsWith('//') || /[\n`<>|*]/.test(abs)) return;
  const hit = sourceForAbs(abs);
  if (hit) return mark(el, hit.path, hit.src);
  // an image of a temp folder (the agent's screenshot): the path stays absolute, `data-tmp` tells openRef not to look in a source
  if (isTmpImagePath(abs)) {
    el.classList.add('ref');
    el.dataset.path = abs;
    el.dataset.tmp = '1';
  }
}

/**
 * Marks project paths in rendered markdown: inline `code` (not in `pre`) that looks like a path and relative links.
 * Only classes and data attributes are added, never text or elements, so comment anchors (textOf) are unaffected.
 * `baseDir` is the directory of the md file being shown (none = project root). There a relative path has two readings:
 * inline code is project-relative first (docs name files from the root), then file-relative (`data-alt`); a link is
 * file-relative first, as a browser would read it, then project-relative.
 */
export function markRefs(root: HTMLElement, baseDir?: string): void {
  root.querySelectorAll<HTMLElement>('code').forEach((c) => {
    if (c.closest('pre, a')) return;
    const text = stripLine((c.textContent ?? '').trim()).replace(/^\.\//, '');
    if (text.startsWith('/')) return markAbs(c, text);
    if (!text || !isPath(text)) return;
    mark(c, normalize(text), undefined, baseDir ? normalize(text, baseDir) : null);
  });
  root.querySelectorAll<HTMLAnchorElement>('a[href]').forEach((a) => {
    const href = a.getAttribute('href') ?? '';
    if (!href || href.startsWith('#') || /^[a-z][a-z0-9+.-]*:/i.test(href)) return;
    let p = href.replace(/[?#].*$/, '');
    try {
      p = decodeURI(p);
    } catch {
      // keep raw
    }
    if (p.startsWith('/')) return markAbs(a, p);
    if (p) mark(a, normalize(p, baseDir), undefined, baseDir ? normalize(p) : null);
  });
}

type Part = { text: string } | { mention: string };

/** Like splitMentions, but a mention also carries its source text (`@"a b.md"`), so rendering can keep the text unchanged. */
export function splitMentionsRaw(text: string): ({ text: string } | { mention: string; raw: string })[] {
  const out: ({ text: string } | { mention: string; raw: string })[] = [];
  const re = /(^|\s)@("[^"]+"|[^\s"]+)/g;
  let last = 0;
  for (let m; (m = re.exec(text)); ) {
    const start = m.index + m[1].length;
    if (start > last) out.push({ text: text.slice(last, start) });
    out.push({ mention: m[2].replace(/"/g, ''), raw: `@${m[2]}` });
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push({ text: text.slice(last) });
  return out;
}

/**
 * A user message goes through markdown, which would eat `__init__` or `*` inside `@src/__init__.py`: the mention
 * tokens (outside code spans and fences) get their markdown punctuation backslash-escaped, so they render as typed.
 */
export function escapeMentions(text: string): string {
  return text
    .split(/(```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)|`[^`\n]*`)/)
    .map((seg, i) =>
      i % 2 ? seg : splitMentionsRaw(seg).map((p) => ('mention' in p ? p.raw.replace(/[\\`*_~[\]<>|&]/g, '\\$&') : p.text)).join(''),
    )
    .join('');
}

/**
 * Makes `@path` in the rendered text of a user message a ref span (`.ref.mention`, `data-path`), as the plain-text
 * bubble did. Text inside code, pre and links is left alone. Only splits text nodes and wraps, so the rendered text
 * (comment anchors) is unchanged.
 */
export function markMentions(root: HTMLElement): void {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes: Text[] = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (!(n.parentElement?.closest('code, pre, a, .mention'))) nodes.push(n as Text);
  }
  for (const node of nodes) {
    const parts = splitMentionsRaw(node.data);
    if (!parts.some((p) => 'mention' in p)) continue;
    const frag = document.createDocumentFragment();
    for (const p of parts) {
      if ('mention' in p) {
        const span = document.createElement('span');
        span.className = 'ref mention';
        span.dataset.path = p.mention;
        span.textContent = p.raw;
        frag.append(span);
      } else frag.append(p.text);
    }
    node.replaceWith(frag);
  }
}

export function splitMentions(text: string): Part[] {
  return splitMentionsRaw(text).map((p) => ('mention' in p ? { mention: p.mention } : p));
}

const HEAD_TTL = 10_000;
const heads = new Map<string, { at: number; ok: Promise<boolean> }>();
/** Test hook. */
export const clearRefCache = () => heads.clear();

function exists(path: string, src = 'here'): Promise<boolean> {
  const key = `${src}\n${path}`;
  const hit = heads.get(key);
  if (hit && Date.now() - hit.at < HEAD_TTL) return hit.ok;
  const ok = fetch(fileUrl(path, undefined, src), { method: 'HEAD' }).then((r) => r.ok, () => false);
  heads.set(key, { at: Date.now(), ok });
  return ok;
}

/**
 * Opens a ref. An absolute one (`data-src`) opens from its own source only. A relative one is tried in `from` (the
 * source of the file it sits in, default this folder), then this folder, then each worktree: the first HEAD 200 wins.
 * In each source `path` goes first, then the element's `data-alt` (see markRefs).
 */
export const openRef = (path: string, el: HTMLElement, from = 'here'): AppThunk<Promise<void>> => async (dispatch) => {
  if (el.dataset.tmp) return void dispatch(openFile({ path })); // no HEAD: a gone file is the tab's own state, and the link stays a link
  const own = el.dataset.src;
  const paths = el.dataset.alt && el.dataset.alt !== path ? [path, el.dataset.alt] : [path];
  const tried = new Set<string>();
  const attempt = async (src: string) => {
    if (tried.has(src)) return false;
    tried.add(src);
    for (const p of paths) {
      if (!(await exists(p, src))) continue;
      dispatch(openFile({ path: p, src, ref: refOf(src) }));
      return true;
    }
    return false;
  };
  if (own) {
    if (await attempt(own)) return;
  } else {
    if (await attempt(from)) return;
    if (await attempt('here')) return;
    if (!getSources().some((s) => s.kind === 'worktree')) await loadSources();
    for (const s of getSources()) if (s.kind === 'worktree' && (await attempt(s.id))) return;
  }
  el.classList.add('missing');
  el.title = t('noFile');
};

/** A rendered project media element (`/file?path=…[&src=…]`, see fileUrl): its path and source, from the URL itself. */
export function fileOfImage(img: Element): { path: string; src: string } | null {
  const raw = img.getAttribute('src') ?? '';
  if (!raw.startsWith('/file?')) return null;
  const q = new URL(raw, 'http://x').searchParams;
  const path = q.get('path');
  return path ? { path, src: q.get('src') ?? 'here' } : null;
}

/** The open action of a rendered project image/video/audio: what clicking an image does, and the media ⤢ button. */
export function openMediaFile(el: Element): ReturnType<typeof openFile> | null {
  const f = fileOfImage(el);
  return f ? openFile({ ...f, ref: refOf(f.src) }) : null;
}

/**
 * Delegated click handler for a container holding `.ref[data-path]` elements. A project image in rendered markdown
 * (a chat reply or an md file) opens as a file tab too (prototype parity).
 */
export const refClick =
  (e: ReactMouseEvent<HTMLElement>, dispatch: (a: AppThunk<Promise<void>> | ReturnType<typeof openFile>) => unknown, from?: string): void => {
    const img = (e.target as Element).closest<HTMLImageElement>('.md img');
    if (img && e.currentTarget.contains(img)) {
      const open = openMediaFile(img);
      if (open && (window.getSelection()?.isCollapsed ?? true)) dispatch(open);
      return;
    }
    const el = (e.target as Element).closest<HTMLElement>('.ref[data-path]');
    if (!el || !e.currentTarget.contains(el)) return;
    const link = el.tagName === 'A';
    if (link && (e.metaKey || e.ctrlKey)) return; // browser default
    if (link) e.preventDefault(); // never navigate the SPA
    if (!(window.getSelection()?.isCollapsed ?? true)) return; // selecting text to comment on
    const path = el.dataset.path!;
    if (path.endsWith('/')) return; // a folder mention
    void dispatch(openRef(path, el, from));
  };
