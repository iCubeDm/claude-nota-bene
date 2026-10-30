import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { Provider } from 'react-redux';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { setTmpDirs } from '@/files/tmpImages.ts';
import { setLang } from '@/i18n/index.ts';
import { makeStore } from '@/store/store.ts';
import { selectTabs } from '@/tabs/slice.ts';
import { ToolLine } from './ToolLine.tsx';

// B1e: a tool line names a temp image (Read's file_path, a screenshot command): a button beside the line opens its tab
beforeEach(() => {
  setLang('en');
  setTmpDirs(['/tmp', '/private/tmp']);
});
afterEach(() => {
  cleanup();
  setTmpDirs([]);
});

const item = (name: string, input: Record<string, unknown>) => ({ kind: 'tool', id: 't1', name, arg: String(Object.values(input)[0]), sub: false, input }) as never;
const mount = (it: ReturnType<typeof item>) => {
  const store = makeStore({ url: 'ws://x', connect: () => ({ send: () => true, close() {} }) });
  render(<Provider store={store}><ToolLine item={it} /></Provider>);
  return store;
};

it('a Read of a temp image gets a button that opens the tab', () => {
  const store = mount(item('Read', { file_path: '/tmp/shot.png' }));
  fireEvent.click(screen.getByRole('button', { name: /⤢ shot\.png/ }));
  expect(selectTabs(store.getState()).active).toBe('file:/tmp/shot.png');
});

it('a command that writes one names it once; a project path, a text file and a path outside the temp folders get none', () => {
  mount(item('Bash', { command: 'screencapture -x /tmp/a.png && cp /tmp/a.png /tmp/a.png' }));
  expect(document.querySelectorAll('[data-tmp-image]').length).toBe(1);
  cleanup();
  for (const [name, input] of [['Read', { file_path: 'img/a.png' }], ['Read', { file_path: '/tmp/a.txt' }], ['Read', { file_path: '/etc/a.png' }], ['Bash', { command: 'ls' }]] as const) {
    mount(item(name, input));
    expect(document.querySelectorAll('[data-tmp-image]').length, JSON.stringify(input)).toBe(0);
    cleanup();
  }
});

it('without the server naming its temp folders there is no button', () => {
  setTmpDirs([]);
  mount(item('Read', { file_path: '/tmp/shot.png' }));
  expect(document.querySelectorAll('[data-tmp-image]').length).toBe(0);
});
