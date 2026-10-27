import DOMPurify from 'dompurify';
import { t } from '@/i18n/index.ts';

/**
 * Markdown from any repo branch is rendered, so it is hostile input: no <style> (global CSS), no form controls, and no
 * data-* attributes at all (content data-pane / data-file-path / data-lightbox would collide with app hooks; markRefs and
 * hljs add their own data-* after sanitizing).
 */
export const HARDEN = { FORBID_TAGS: ['style', 'form', 'input', 'button', 'select', 'textarea'], ALLOW_DATA_ATTR: false };

export type DiagramLang = 'mermaid' | 'svg';
/** An svg string safe to put in the DOM, or the message to show instead (already in the current language). */
export type Rendered = { svg: string } | { error: string };

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
  // a failed chunk load must not stick for the page's lifetime: the next diagram tries again
  mermaidP.catch(() => { mermaidP = undefined; });
  return mermaidP;
}

let seq = 0;

/** The one place an svg block from untrusted text is sanitized (chat, md files, comments, the diagram tab). */
export const sanitizeSvg = (src: string): string => DOMPurify.sanitize(src, { USE_PROFILES: { svg: true, svgFilters: true }, ...HARDEN });

export async function renderMermaid(code: string): Promise<Rendered> {
  let m: MermaidApi;
  try {
    m = await loadMermaid();
  } catch {
    // the page is older than the build on disk (its chunk names are gone): a reload fixes it
    return { error: t('mermaidStale') };
  }
  const id = `m${++seq}`;
  try {
    return { svg: (await m.render(id, code)).svg };
  } catch (e) {
    // on a syntax error mermaid leaves its error graphic (the "bomb") in <body>, under the app
    document.getElementById(`d${id}`)?.remove();
    document.getElementById(id)?.remove();
    return { error: t('mermaidError', e instanceof Error ? e.message : String(e)) };
  }
}

export const renderDiagram = async (lang: DiagramLang, source: string): Promise<Rendered> =>
  lang === 'svg' ? { svg: sanitizeSvg(source) } : renderMermaid(source);

/** The drawing's own size: its viewBox, else numeric width/height, else a guess (800x600). */
export function svgSize(svg: SVGElement): { w: number; h: number } {
  const vb = svg.getAttribute('viewBox')?.trim().split(/[\s,]+/).map(Number);
  if (vb?.length === 4 && vb[2] > 0 && vb[3] > 0) return { w: vb[2], h: vb[3] };
  const [w, h] = [parseFloat(svg.getAttribute('width') ?? ''), parseFloat(svg.getAttribute('height') ?? '')];
  return w > 0 && h > 0 && !/%/.test(svg.getAttribute('width') ?? '') ? { w, h } : { w: 800, h: 600 };
}
