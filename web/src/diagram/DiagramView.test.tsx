import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import mermaid from 'mermaid';
import { setLang } from '@/i18n/index.ts';
import type { DiagramTab } from '@/tabs/slice.ts';
import { DiagramView } from './DiagramView.tsx';

vi.mock('mermaid', () => ({
  default: {
    initialize: vi.fn(),
    render: vi.fn(async () => ({ svg: '<svg viewBox="0 0 400 200" width="100%" style="max-width: 400px"><g/></svg>' })),
  },
}));

const tab = (o: Partial<DiagramTab> = {}): DiagramTab => ({ id: 'diagram:abcd1234', kind: 'diagram', source: 'graph TD; A-->B', lang: 'mermaid', title: 'graph TD; A-->B', ...o });

// jsdom has no layout: the pane is 800 x 400
beforeEach(() => {
  setLang('en');
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(800);
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(400);
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const sheet = () => screen.getByTestId('diagram-sheet');
const pane = () => document.querySelector('[data-pane="diagram:abcd1234"]') as HTMLElement;
const shown = async () => { await waitFor(() => expect(sheet().querySelector('svg')).not.toBeNull()); };

describe('DiagramView', () => {
  it('renders a mermaid diagram at its own size, fitted and centred in the pane', async () => {
    render(<DiagramView tab={tab()} active />);
    await shown();
    const svg = sheet().querySelector('svg')!;
    expect(svg.getAttribute('width')).toBe('400');
    expect(svg.getAttribute('height')).toBe('200');
    expect(sheet().style.transform).toBe('translate(0px, 0px) scale(2)'); // 800x400 pane, 400x200 drawing
  });

  it('an svg block goes through the sanitizer', async () => {
    render(<DiagramView tab={tab({ lang: 'svg', source: '<svg viewBox="0 0 10 10"><script>alert(1)</script><rect width="5" height="5" onclick="x()"/></svg>' })} active />);
    await shown();
    expect(sheet().querySelector('script')).toBeNull();
    expect(sheet().querySelector('rect')).not.toBeNull();
    expect(sheet().querySelector('rect')!.getAttribute('onclick')).toBeNull();
    expect(mermaid.render).not.toHaveBeenCalled();
  });

  it('a syntax error is shown as text, not as a blank tab', async () => {
    vi.mocked(mermaid.render).mockRejectedValueOnce(new Error('bad graph'));
    render(<DiagramView tab={tab()} active />);
    expect(await screen.findByText('mermaid error: bad graph')).toBeInTheDocument();
  });

  it('wheel zooms around the cursor, within 0.25..8', async () => {
    render(<DiagramView tab={tab()} active />);
    await shown();
    vi.spyOn(pane(), 'getBoundingClientRect').mockReturnValue({ left: 0, top: 0, width: 800, height: 400 } as DOMRect);
    fireEvent.wheel(pane(), { deltaY: -100, ctrlKey: true, clientX: 400, clientY: 200 });
    const m = /translate\(([-\d.]+)px, ([-\d.]+)px\) scale\(([\d.]+)\)/.exec(sheet().style.transform)!;
    const [tx, ty, s] = [Number(m[1]), Number(m[2]), Number(m[3])];
    expect(s).toBeGreaterThan(2);
    // the centre of the pane still shows the centre of the drawing (200, 100)
    expect(200 * s + tx).toBeCloseTo(400, 3);
    expect(100 * s + ty).toBeCloseTo(200, 3);
    for (let i = 0; i < 40; i++) fireEvent.wheel(pane(), { deltaY: -500, ctrlKey: true, clientX: 0, clientY: 0 });
    expect(sheet().style.transform).toMatch(/scale\(8\)$/);
  });

  it('a click toggles fit and 100%; 0 resets to fit', async () => {
    render(<DiagramView tab={tab()} active />);
    await shown();
    fireEvent.click(pane());
    expect(sheet().style.transform).toBe('translate(200px, 100px) scale(1)');
    fireEvent.click(pane());
    expect(sheet().style.transform).toBe('translate(0px, 0px) scale(2)');
    fireEvent.click(pane());
    fireEvent.keyDown(window, { key: '0' });
    expect(sheet().style.transform).toBe('translate(0px, 0px) scale(2)');
  });

  it('a drag pans and does not toggle', async () => {
    render(<DiagramView tab={tab()} active />);
    await shown();
    fireEvent.pointerDown(pane(), { clientX: 100, clientY: 100, button: 0, pointerId: 1 });
    fireEvent.pointerMove(pane(), { clientX: 130, clientY: 90, pointerId: 1 });
    fireEvent.pointerUp(pane(), { clientX: 130, clientY: 90, pointerId: 1 });
    fireEvent.click(pane());
    expect(sheet().style.transform).toBe('translate(30px, -10px) scale(2)');
  });

  it('0 is ignored while the tab is not active', async () => {
    const { rerender } = render(<DiagramView tab={tab()} active />);
    await shown();
    fireEvent.click(pane());
    rerender(<DiagramView tab={tab()} active={false} />);
    fireEvent.keyDown(window, { key: '0' });
    expect(sheet().style.transform).toBe('translate(200px, 100px) scale(1)');
    expect(pane()).toHaveAttribute('hidden');
  });
});
