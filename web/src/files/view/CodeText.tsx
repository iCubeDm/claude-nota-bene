import hljs from 'highlight.js';
import { useLayoutEffect, useRef } from 'react';

export const HIGHLIGHT_MAX = 200_000; // hljs on a 1-2 MB file freezes the tab

const extOf = (p: string) => /\.([a-z0-9]+)$/i.exec(p)?.[1]?.toLowerCase();

export function CodeText({ text, path }: { text: string; path: string }) {
  const ref = useRef<HTMLElement>(null);
  const plain = text.length > HIGHLIGHT_MAX;
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (plain) {
      el.textContent = text;
      return;
    }
    const ext = extOf(path);
    el.textContent = text;
    delete el.dataset.highlighted;
    el.className = 'hljs';
    if (ext && hljs.getLanguage(ext)) el.classList.add(`language-${ext}`);
    hljs.highlightElement(el);
  }, [text, path, plain]);
  return <code ref={ref} />;
}
