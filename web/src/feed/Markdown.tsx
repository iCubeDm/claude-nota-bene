import DOMPurify from 'dompurify';
import hljs from 'highlight.js';
import 'highlight.js/styles/github-dark.min.css';
import { marked } from 'marked';
import { memo, useLayoutEffect, useMemo, useRef } from 'react';
import { t } from '@/i18n/index.ts';
import { AUDIO, VIDEO, fileUrl } from '@/files/kinds.ts';
import './markdown.css';

// external links in agent replies open in a new browser tab instead of replacing the app
DOMPurify.addHook('afterSanitizeAttributes', (n) => {
  if (n.tagName === 'A' && /^https?:/i.test(n.getAttribute('href') ?? '')) {
    n.setAttribute('target', '_blank');
    n.setAttribute('rel', 'noopener noreferrer');
  }
});

const escAttr = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

// marked renderers are global and parse is synchronous, so the current render's baseDir lives here
let currentBase: string | undefined;

marked.use({
  gfm: true,
  renderer: {
    image(href: string, _title: string | null, text: string) {
      const src = escAttr(fileUrl(href, currentBase));
      if (VIDEO.test(href)) return `<video controls preload="metadata" src="${src}"></video>`;
      if (AUDIO.test(href)) return `<audio controls src="${src}"></audio>`;
      return `<img src="${src}" alt="${escAttr(text || '')}">`;
    },
  },
});

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
      out.innerHTML = DOMPurify.sanitize(c.textContent ?? '', { USE_PROFILES: { svg: true, svgFilters: true } });
      pre.replaceWith(out);
    } else if (!c.dataset.highlighted) {
      hljs.highlightElement(c);
      c.dataset.highlighted = 'yes';
    }
  });
}

export const Markdown = memo(
  function Markdown({ text, final, baseDir }: { text: string; final: boolean; baseDir?: string }) {
    const ref = useRef<HTMLDivElement>(null);
    const html = useMemo(
      () => {
        currentBase = baseDir;
        try {
          return DOMPurify.sanitize(marked.parse(text, { async: false }) as string, {
            ADD_TAGS: ['video', 'audio'],
            ADD_ATTR: ['controls', 'preload'],
          });
        } finally {
          currentBase = undefined;
        }
      },
      [text, baseDir],
    );
    useLayoutEffect(() => {
      if (ref.current) postProcess(ref.current, final);
    }, [html, final]);
    return <div ref={ref} className="md" dangerouslySetInnerHTML={{ __html: html }} />;
  },
  (a, b) => a.text === b.text && a.final === b.final && a.baseDir === b.baseDir,
);
