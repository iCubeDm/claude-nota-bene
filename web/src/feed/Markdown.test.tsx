import { render, waitFor } from '@testing-library/react';
import hljs from 'highlight.js';
import mermaid from 'mermaid';
import DOMPurify from 'dompurify';
import { marked } from 'marked';
import { fireEvent } from '@testing-library/react';
import { Provider } from 'react-redux';
import { describe, expect, it, vi } from 'vitest';
import { makeStore } from '@/store/store.ts';
import { selectActiveTab } from '@/tabs/slice.ts';
import { textOf } from '@/anchors/text.ts';
import { setLang, t } from '@/i18n/index.ts';
import { Markdown } from './Markdown';

vi.mock('mermaid', () => ({
  default: {
    initialize: vi.fn(),
    render: vi.fn(async () => ({ svg: '<svg data-test="m"></svg>' })),
  },
}));

const MERMAID = '```mermaid\ngraph TD; A-->B\n```';

describe('Markdown', () => {
  it('renders code with hljs classes', () => {
    const { container } = render(<Markdown text={'```js\nconst a = 1;\n```'} final />);
    expect(container.querySelector('pre code.hljs')).not.toBeNull();
    expect(container.querySelector('.hljs-keyword')).not.toBeNull();
  });

  it('final mermaid block becomes .mermaid-out', async () => {
    const { container } = render(<Markdown text={MERMAID} final />);
    await waitFor(() => expect(container.querySelector('.mermaid-out svg[data-test="m"]')).not.toBeNull());
    expect(container.querySelector('pre')).toBeNull();
  });

  it('non-final mermaid stays a code block', () => {
    const { container } = render(<Markdown text={MERMAID} final={false} />);
    expect(container.querySelector('.mermaid-out')).toBeNull();
    expect(container.querySelector('pre code')).not.toBeNull();
  });

  it('strips <style>, form controls and every data-* attribute (they would collide with app hooks like data-pane)', () => {
    const evil = '<style>body{display:none}</style><p data-pane="chat" data-file-path="x" data-lightbox>hi</p>' +
      '<form><input value="a"><button>b</button><select><option>c</option></select><textarea>d</textarea></form>';
    const { container } = render(<Markdown text={evil} final={false} />);
    const md = container.querySelector('.md')!;
    expect(md.querySelector('style, form, input, button, select, textarea')).toBeNull();
    expect(md.querySelector('p')!.attributes).toHaveLength(0);
    expect(md.innerHTML).not.toMatch(/data-|display:none/);
  });

  it('leaves ordinary markdown exactly as the default sanitizer did', () => {
    const doc = '# H1\n\n## H2\n\nSome *em*, **strong**, `code`, ~~del~~.\n\n- a\n- b\n  1. c\n\n> quote\n\n' +
      '| a | b |\n|---|:-:|\n| 1 | 2 |\n\n[ext](https://x.y/z) [rel](docs/a.md) ![pic](p.png) ![v](m.mp4)\n\n---\n\n<details><summary>s</summary>t</details>\n';
    const { container } = render(<Markdown text={doc} final={false} />);
    const before = DOMPurify.sanitize(marked.parse(doc, { async: false }) as string, { ADD_TAGS: ['video', 'audio'], ADD_ATTR: ['controls', 'preload'] });
    expect(container.querySelector('.md')!.innerHTML).toBe(before);
  });

  it('a task list keeps its boxes without an <input>', () => {
    const { container } = render(<Markdown text={'- [x] done\n- [ ] todo'} final={false} />);
    const md = container.querySelector('.md')!;
    expect(md.querySelector('input')).toBeNull();
    expect([...md.querySelectorAll('.task-box')].map((b) => b.classList.contains('checked'))).toEqual([true, false]);
    expect(md.textContent).not.toMatch(/[☐☑]/); // the box is CSS-only: comment anchors read the same text as before
  });

  it('sanitises <script>', () => {
    const { container } = render(<Markdown text={'hi <script>window.__x=1</script> <img src=x onerror="window.__y=1">'} final />);
    expect(container.querySelector('script')).toBeNull();
    expect(container.innerHTML).not.toContain('onerror');
  });

  it('external links open in a new tab; project links stay in the app', () => {
    const { container } = render(<Markdown text={'[ext](https://example.com) [rel](docs/a.md)'} final />);
    const [ext, rel] = container.querySelectorAll('a');
    expect(ext.getAttribute('target')).toBe('_blank');
    expect(ext.getAttribute('rel')).toBe('noopener noreferrer');
    expect(rel.hasAttribute('target')).toBe(false);
  });

  it('auto-detects untagged fences', () => {
    const { container } = render(<Markdown text={'```\nconst a = 1;\nfunction f() { return a; }\n```'} final />);
    expect(container.querySelector('pre code span[class^="hljs-"]')).not.toBeNull();
  });

  it('highlights a code block once across the final flip', () => {
    const spy = vi.spyOn(hljs, 'highlightElement');
    const text = '```js\nconst a = 1;\n```';
    const { container, rerender } = render(<Markdown text={text} final={false} />);
    rerender(<Markdown text={text} final />);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(container.querySelector('.hljs-keyword .hljs-keyword')).toBeNull();
    spy.mockRestore();
  });

  it('a mermaid failure is shown through t() in the current language', async () => {
    setLang('ru');
    vi.mocked(mermaid.render).mockRejectedValueOnce(new Error('bad graph'));
    const { container } = render(<Markdown text={MERMAID} final />);
    await waitFor(() => expect(container.querySelector('.mermaid-out')).toHaveTextContent('ошибка mermaid: bad graph'));
  });

  it('a mermaid syntax error leaves no error graphic in <body>', async () => {
    vi.mocked(mermaid.render).mockImplementationOnce(async (id: string) => {
      const d = document.createElement('div'); // what mermaid 10 does: its temp box with the bomb stays in body
      d.id = `d${id}`;
      d.innerHTML = `<svg id="${id}"></svg>`;
      document.body.appendChild(d);
      throw new Error('Syntax error in text');
    });
    const { container } = render(<Markdown text={MERMAID} final />);
    await waitFor(() => expect(container.querySelector('.mermaid-out')).toHaveTextContent(/Syntax error in text/));
    expect(document.body.querySelector('[id^="dm"]')).toBeNull();
  });

  it('a failed mermaid load says to reload and is retried by the next diagram (a page older than the build)', async () => {
    setLang('ru');
    vi.resetModules();
    const { Markdown: Fresh } = await import('./Markdown');
    vi.mocked(mermaid.initialize).mockImplementationOnce(() => { throw new Error('Failed to fetch dynamically imported module'); });
    const first = render(<Fresh text={MERMAID} final />);
    await waitFor(() => expect(first.container.querySelector('.mermaid-out')).toHaveTextContent('интерфейс обновился, перезагрузите страницу'));
    const second = render(<Fresh text={MERMAID} final />);
    await waitFor(() => expect(second.container.querySelector('.mermaid-out svg[data-test="m"]')).not.toBeNull());
  });

  describe('the open-diagram button (M7-01)', () => {
    const SVG = '```svg\n<svg viewBox="0 0 10 10"><rect width="5" height="5"/></svg>\n```';
    const store = () => makeStore({ url: 'ws://x', connect: () => ({ send: () => true, close() {} }) });

    it('every rendered diagram gets a button that is skipped by comment anchors', async () => {
      const { container } = render(<Markdown text={`${MERMAID}\n\n${SVG}`} final />);
      await waitFor(() => expect(container.querySelector('.mermaid-out svg')).not.toBeNull());
      const buttons = container.querySelectorAll('.mermaid-out > button, .svg-out > button');
      expect(buttons).toHaveLength(2);
      for (const b of buttons) {
        expect(b).toHaveAttribute('data-anchor-skip');
        expect(b).toHaveAttribute('aria-label', t('openDiagram'));
      }
      expect(textOf(container.querySelector('.md')!)).not.toContain('⤢');
    });

    it('a diagram that failed to render has no button', async () => {
      vi.mocked(mermaid.render).mockRejectedValueOnce(new Error('bad graph'));
      const { container } = render(<Markdown text={MERMAID} final />);
      await waitFor(() => expect(container.querySelector('.mermaid-out')).toHaveTextContent('bad graph'));
      expect(container.querySelector('button')).toBeNull();
    });

    it('a click opens the diagram tab with its source and language', async () => {
      const st = store();
      const { container } = render(<Provider store={st}><Markdown text={MERMAID} final /></Provider>);
      await waitFor(() => expect(container.querySelector('.mermaid-out > button')).not.toBeNull());
      fireEvent.click(container.querySelector('.mermaid-out > button')!);
      expect(selectActiveTab(st.getState())).toMatchObject({ kind: 'diagram', lang: 'mermaid', source: 'graph TD; A-->B' });
    });

    it('works without a store (the button is inert, nothing throws)', async () => {
      const { container } = render(<Markdown text={SVG} final />);
      fireEvent.click(container.querySelector('.svg-out > button')!);
    });
  });
});
