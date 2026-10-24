import { render, waitFor } from '@testing-library/react';
import hljs from 'highlight.js';
import { describe, expect, it, vi } from 'vitest';
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

  it('sanitises <script>', () => {
    const { container } = render(<Markdown text={'hi <script>window.__x=1</script> <img src=x onerror="window.__y=1">'} final />);
    expect(container.querySelector('script')).toBeNull();
    expect(container.innerHTML).not.toContain('onerror');
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
});
