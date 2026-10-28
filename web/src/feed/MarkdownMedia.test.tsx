import { fireEvent, render } from '@testing-library/react';
import { Provider } from 'react-redux';
import { describe, expect, it } from 'vitest';
import { makeStore } from '@/store/store.ts';
import { selectActiveTab } from '@/tabs/slice.ts';
import { textOf } from '@/anchors/text.ts';
import { t } from '@/i18n/index.ts';
import { takeStartAt } from '@/files/startAt.ts';
import { Markdown } from './Markdown';

// its own file: Markdown.test.tsx resets modules in one test, which leaves later renders with a stale marked instance
describe('the open-in-a-tab button on embedded media', () => {
  const store = () => makeStore({ url: 'ws://x', connect: () => ({ send: () => true, close() {} }) });
  const label = () => t('openInTab');

  it('a project video, audio and image get a hover button; /attach and https media get none', () => {
    const text = '![v](media/a.mp4)\n\n![a](media/a.mp3)\n\n![i](media/a.png)\n\n![p](/attach/abc.png)\n\n![h](https://x.test/a.png)';
    const { container } = render(<Markdown text={text} final />);
    const buttons = container.querySelectorAll('button.md-open-media');
    expect(buttons).toHaveLength(3);
    for (const b of buttons) {
      expect(b).toHaveAttribute('aria-label', label());
      expect(b).toHaveAttribute('data-anchor-skip');
    }
    expect(container.querySelectorAll('img, video, audio')).toHaveLength(5);
    expect(textOf(container.querySelector('.md')!)).not.toContain('⤢');
  });

  it('streaming text has no button; a re-render does not duplicate it', () => {
    const { container, rerender } = render(<Markdown text="![v](a.mp4)" final={false} />);
    expect(container.querySelector('button.md-open-media')).toBeNull();
    rerender(<Markdown text="![v](a.mp4)" final />);
    rerender(<Markdown text="![v](a.mp4)" final baseDir="docs" />);
    expect(container.querySelectorAll('button.md-open-media')).toHaveLength(1);
  });

  it('a click opens the file tab with the resolved path (base dir and source)', () => {
    const st = store();
    const { container } = render(<Provider store={st}><Markdown text="![v](clip.mp4)" final baseDir="docs" src="wt1" /></Provider>);
    fireEvent.click(container.querySelector('button.md-open-media')!);
    expect(selectActiveTab(st.getState())).toMatchObject({ kind: 'file', path: 'docs/clip.mp4', src: 'wt1' });
  });

  it('a played video opens at its current time (once); an unplayed one sets no start', () => {
    const st = store();
    const { container } = render(<Provider store={st}><Markdown text="![v](a.mp4)" final /></Provider>);
    fireEvent.click(container.querySelector('button.md-open-media')!);
    expect(takeStartAt('file:a.mp4')).toBeUndefined();
    container.querySelector('video')!.currentTime = 12.5;
    fireEvent.click(container.querySelector('button.md-open-media')!);
    expect(takeStartAt('file:a.mp4')).toBe(12.5);
    expect(takeStartAt('file:a.mp4')).toBeUndefined();
  });

  it('works without a store (inert)', () => {
    const { container } = render(<Markdown text="![v](a.mp4)" final />);
    fireEvent.click(container.querySelector('button.md-open-media')!);
  });
});
