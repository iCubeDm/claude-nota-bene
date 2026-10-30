import DOMPurify from 'dompurify';
import hljs from 'highlight.js';
import 'highlight.js/styles/github-dark.min.css';
import { marked } from 'marked';
import { memo, type MouseEvent as ReactMouseEvent, useContext, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ReactReduxContext } from 'react-redux';
import { t } from '@/i18n/index.ts';
import { AUDIO, VIDEO, fileUrl } from '@/files/kinds.ts';
import { useSources } from '@/files/sources.ts';
import { useTmpDirs } from '@/files/tmpImages.ts';
import { openDiagram } from '@/tabs/slice.ts';
import { HARDEN, renderMermaid, sanitizeSvg, type DiagramLang } from '@/diagram/render.ts';
import { fileOfImage, markMentions, markRefs, openMediaFile } from '@/refs/refs.ts';
import { fileTabId } from '@/tabs/slice.ts';
import { ChatPlayer } from '@/media/ChatPlayer.tsx';
import { setStartAt } from '@/files/startAt.ts';
import './markdown.css';

// external links in agent replies open in a new browser tab instead of replacing the app
DOMPurify.addHook('afterSanitizeAttributes', (n) => {
  if (n.tagName === 'A' && /^https?:/i.test(n.getAttribute('href') ?? '')) {
    n.setAttribute('target', '_blank');
    n.setAttribute('rel', 'noopener noreferrer');
  }
});

const escAttr = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

// marked renderers are global and parse is synchronous, so the current render's baseDir and source live here
let currentBase: string | undefined;
let currentSrc: string | undefined;
let currentNoHtml = false;
const escHtml = (s: string) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]!);

marked.use({
  gfm: true,
  renderer: {
    image(href: string, _title: string | null, text: string) {
      const src = escAttr(fileUrl(href, currentBase, currentSrc));
      if (VIDEO.test(href)) return `<video controls preload="metadata" src="${src}"></video>`;
      if (AUDIO.test(href)) return `<audio controls src="${src}"></audio>`;
      return `<img src="${src}" alt="${escAttr(text || '')}">`;
    },
    // what a person typed (user messages, comments): `<Composer>` is text, not a tag the sanitizer would drop
    html(html: string) {
      return currentNoHtml ? escHtml(html) : html;
    },
    // <input> is forbidden by the sanitizer: a task-list box is a CSS-drawn span (no text, so anchors read the same)
    checkbox(checked: boolean) {
      return `<span class="task-box${checked ? ' checked' : ''}" aria-hidden="true"></span> `;
    },
  },
});

/** The source and language behind each ⤢ button (kept out of the DOM: sanitized content must not be able to forge one). */
/** A stable React key per media element, so a re-collect of the same wrappers keeps their players mounted. */
let playerSeq = 0;
const playerIds = new WeakMap<Element, number>();
const playerId = (m: Element) => { let n = playerIds.get(m); if (!n) playerIds.set(m, (n = ++playerSeq)); return n; };

const openers = new WeakMap<Element, { source: string; lang: DiagramLang }>();

/** The ⤢ button, made after sanitizing and skipped by comment anchors; shown on hover (markdown.css). */
function addOpenButton(out: HTMLElement, source: string, lang: DiagramLang) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'md-open-diagram';
  b.textContent = '⤢';
  b.setAttribute('data-anchor-skip', '');
  b.setAttribute('aria-label', t('openDiagram'));
  b.title = t('openDiagram');
  openers.set(b, { source: source.replace(/\s+$/, ''), lang });
  out.appendChild(b);
}

/**
 * Video and audio get a wrapper (the host of our player bar); project media (src is a /file URL; not /attach, not http)
 * also gets an "open in a tab" button. Once per element.
 */
function addMediaButtons(root: HTMLElement) {
  root.querySelectorAll<HTMLElement>('img, video, audio').forEach((m) => {
    if (m.parentElement?.classList.contains('md-media')) return;
    const f = fileOfImage(m);
    // `![](/attach/<id>)` also renders as a /file URL (an absolute path): it is a pasted image, not a project file
    const project = !!f && !f.path.startsWith('/attach/');
    if (!project && m instanceof HTMLImageElement) return;
    const wrap = document.createElement('span');
    wrap.className = 'md-media';
    m.replaceWith(wrap);
    wrap.appendChild(m);
    if (!project) return;
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'md-open-media';
    b.textContent = '⤢';
    b.setAttribute('data-anchor-skip', '');
    b.setAttribute('aria-label', t('openInTab'));
    b.title = t('openInTab');
    wrap.appendChild(b);
  });
}

function postProcess(root: HTMLElement, final: boolean) {
  if (final) addMediaButtons(root);
  root.querySelectorAll<HTMLElement>('pre code').forEach((c) => {
    const lang = /language-(\w+)/.exec(c.className)?.[1];
    const pre = c.parentElement!;
    if (final && lang === 'mermaid') {
      const out = document.createElement('div');
      out.className = 'mermaid-out';
      pre.replaceWith(out);
      const code = c.textContent ?? '';
      void renderMermaid(code).then((r) => {
        if ('svg' in r) {
          out.innerHTML = r.svg;
          addOpenButton(out, code, 'mermaid');
        } else out.textContent = r.error;
      });
    } else if (final && lang === 'svg') {
      const out = document.createElement('div');
      out.className = 'svg-out';
      out.innerHTML = sanitizeSvg(c.textContent ?? '');
      addOpenButton(out, c.textContent ?? '', 'svg');
      pre.replaceWith(out);
    } else if (!c.dataset.highlighted) {
      hljs.highlightElement(c);
      c.dataset.highlighted = 'yes';
    }
  });
}

export const Markdown = memo(
  /**
   * `src`: the source of the file being shown (M3-16): its relative images load from that source.
   * `breaks`: a single newline is a line break (what the user typed in the composer). `mentions`: `@path` in the text
   * becomes a clickable ref (user messages; the text must have gone through `escapeMentions`). `noHtml`: raw HTML in
   * the text is shown as typed (what a person wrote: `<Tag>` stays visible), not passed to the sanitizer.
   */
  function Markdown({ text, final, baseDir, src, breaks, mentions, noHtml }: { text: string; final: boolean; baseDir?: string; src?: string; breaks?: boolean; mentions?: boolean; noHtml?: boolean }) {
    const ref = useRef<HTMLDivElement>(null);
    // Markdown is also rendered without a store in tests: the ⤢ button is then inert
    const redux = useContext(ReactReduxContext);
    // absolute paths become refs only inside a known source's dir: re-mark when the list arrives or changes
    const sources = useSources();
    const tmpDirs = useTmpDirs(); // likewise a temp folder's images
    const html = useMemo(
      () => {
        currentBase = baseDir;
        currentSrc = src;
        currentNoHtml = !!noHtml;
        try {
          return DOMPurify.sanitize(marked.parse(text, { async: false, breaks }) as string, {
            ADD_TAGS: ['video', 'audio'],
            ADD_ATTR: ['controls', 'preload'],
            ...HARDEN,
          });
        } finally {
          currentBase = undefined;
          currentSrc = undefined;
          currentNoHtml = false;
        }
      },
      [text, baseDir, src, breaks, noHtml],
    );
    useLayoutEffect(() => {
      if (!ref.current || !final) return;
      markRefs(ref.current, baseDir);
      if (mentions) markMentions(ref.current);
    }, [html, final, baseDir, sources, tmpDirs, mentions]);
    // the wrappers of the reply's video/audio, each hosting our player bar (not without a store: native controls stay)
    const [players, setPlayers] = useState<{ media: HTMLMediaElement; box: HTMLElement }[]>([]);
    useLayoutEffect(() => {
      if (!ref.current) return;
      postProcess(ref.current, final);
      if (!final || !redux) return setPlayers((p) => (p.length ? [] : p));
      setPlayers(Array.from(ref.current.querySelectorAll<HTMLMediaElement>('.md-media > video, .md-media > audio'), (media) => ({ media, box: media.parentElement! })));
    }, [html, final, redux]);
    const onClick = (e: ReactMouseEvent<HTMLDivElement>) => {
      const mb = (e.target as Element).closest('button.md-open-media');
      if (mb && e.currentTarget.contains(mb)) {
        // inside a link or a ref, the click must not navigate or open a second time
        e.preventDefault();
        e.stopPropagation();
        const m = mb.parentElement?.querySelector('img, video, audio');
        const open = m && openMediaFile(m);
        if (!open || !redux) return;
        // a played video/audio opens at that time, a playing one plays on (consumed once by the file view, see files/startAt.ts)
        if (m instanceof HTMLMediaElement && m.currentTime > 0) {
          const f = fileOfImage(m)!;
          setStartAt(fileTabId(f.path, f.src), m.currentTime, !m.paused && !m.ended);
        }
        redux.store.dispatch(open);
        return;
      }
      const b = (e.target as Element).closest('button.md-open-diagram');
      const d = b && e.currentTarget.contains(b) ? openers.get(b) : undefined;
      if (d) redux?.store.dispatch(openDiagram(d));
    };
    return (
      <>
        <div ref={ref} className="md" onClick={onClick} dangerouslySetInnerHTML={{ __html: html }} />
        {players.map((p) => createPortal(<ChatPlayer media={p.media} box={p.box} />, p.box, String(playerId(p.media))))}
      </>
    );
  },
  (a, b) => a.text === b.text && a.final === b.final && a.baseDir === b.baseDir && a.src === b.src && a.breaks === b.breaks && a.mentions === b.mentions && a.noHtml === b.noHtml,
);
