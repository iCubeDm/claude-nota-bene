import DOMPurify from 'dompurify';
import hljs from 'highlight.js';
import 'highlight.js/styles/github-dark.min.css';
import { marked } from 'marked';
import { memo, useLayoutEffect, useMemo, useRef } from 'react';
import { t } from '@/i18n/index.ts';
import { AUDIO, VIDEO, fileUrl } from '@/files/kinds.ts';
import { useSources } from '@/files/sources.ts';
import { markMentions, markRefs } from '@/refs/refs.ts';
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

marked.use({
  gfm: true,
  renderer: {
    image(href: string, _title: string | null, text: string) {
      const src = escAttr(fileUrl(href, currentBase, currentSrc));
      if (VIDEO.test(href)) return `<video controls preload="metadata" src="${src}"></video>`;
      if (AUDIO.test(href)) return `<audio controls src="${src}"></audio>`;
      return `<img src="${src}" alt="${escAttr(text || '')}">`;
    },
    // <input> is forbidden by the sanitizer: a task-list box is a CSS-drawn span (no text, so anchors read the same)
    checkbox(checked: boolean) {
      return `<span class="task-box${checked ? ' checked' : ''}" aria-hidden="true"></span> `;
    },
  },
});

/**
 * Markdown from any repo branch is rendered, so it is hostile input: no <style> (global CSS), no form controls, and no
 * data-* attributes at all (content data-pane / data-file-path / data-lightbox would collide with app hooks; markRefs and
 * hljs add their own data-* after sanitizing).
 */
const HARDEN = { FORBID_TAGS: ['style', 'form', 'input', 'button', 'select', 'textarea'], ALLOW_DATA_ATTR: false };

type MermaidApi = { render: (id: string, code: string) => Promise<{ svg: string }> };
let mermaidP: Promise<MermaidApi> | undefined;
function loadMermaid(): Promise<MermaidApi> {
  mermaidP ??= import('mermaid').then((m) => {
    m.default.initialize({
      startOnLoad: false,
      theme: 'dark',
      securityLevel: 'strict',
      themeVariables: { background: 'transparent', fontFamily: 'Inter, system-ui, sans-serif' },
    });
    return m.default as MermaidApi;
  });
  return mermaidP;
}

let seq = 0;

function postProcess(root: HTMLElement, final: boolean) {
  root.querySelectorAll<HTMLElement>('pre code').forEach((c) => {
    const lang = /language-(\w+)/.exec(c.className)?.[1];
    const pre = c.parentElement!;
    if (final && lang === 'mermaid') {
      const out = document.createElement('div');
      out.className = 'mermaid-out';
      pre.replaceWith(out);
      loadMermaid()
        .then((m) => m.render(`m${++seq}`, c.textContent ?? ''))
        .then(({ svg }) => {
          out.innerHTML = svg;
        })
        .catch((e: unknown) => {
          out.textContent = t('mermaidError', e instanceof Error ? e.message : String(e));
        });
    } else if (final && lang === 'svg') {
      const out = document.createElement('div');
      out.className = 'svg-out';
      out.innerHTML = DOMPurify.sanitize(c.textContent ?? '', { USE_PROFILES: { svg: true, svgFilters: true }, ...HARDEN });
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
   * becomes a clickable ref (user messages; the text must have gone through `escapeMentions`).
   */
  function Markdown({ text, final, baseDir, src, breaks, mentions }: { text: string; final: boolean; baseDir?: string; src?: string; breaks?: boolean; mentions?: boolean }) {
    const ref = useRef<HTMLDivElement>(null);
    // absolute paths become refs only inside a known source's dir: re-mark when the list arrives or changes
    const sources = useSources();
    const html = useMemo(
      () => {
        currentBase = baseDir;
        currentSrc = src;
        try {
          return DOMPurify.sanitize(marked.parse(text, { async: false, breaks }) as string, {
            ADD_TAGS: ['video', 'audio'],
            ADD_ATTR: ['controls', 'preload'],
            ...HARDEN,
          });
        } finally {
          currentBase = undefined;
          currentSrc = undefined;
        }
      },
      [text, baseDir, src, breaks],
    );
    useLayoutEffect(() => {
      if (!ref.current || !final) return;
      markRefs(ref.current, baseDir);
      if (mentions) markMentions(ref.current);
    }, [html, final, baseDir, sources, mentions]);
    useLayoutEffect(() => {
      if (ref.current) postProcess(ref.current, final);
    }, [html, final]);
    return <div ref={ref} className="md" dangerouslySetInnerHTML={{ __html: html }} />;
  },
  (a, b) => a.text === b.text && a.final === b.final && a.baseDir === b.baseDir && a.src === b.src && a.breaks === b.breaks && a.mentions === b.mentions,
);
