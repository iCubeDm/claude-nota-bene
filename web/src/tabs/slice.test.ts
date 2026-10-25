import { beforeEach, expect, it } from 'vitest';
import type { ClientMessage, ServerEvent } from '@nota-bene/shared';
import { makeStore } from '../store/store.ts';
import { activate, closeAll, closeOthers, closeRight, closeTab, fileTabId, openFile, selectActiveTab, selectTabs } from './slice.ts';

function mk() {
  let onEvent!: (e: ServerEvent) => void;
  const store = makeStore({
    url: 'u',
    connect: ((_u: string, e: typeof onEvent) => ((onEvent = e), { send: (_m: ClientMessage) => true, close() {} })) as never,
  });
  return { store, session: (root: string) => onEvent({ kind: 'session', id: null, root }) };
}
const ids = (s: ReturnType<typeof mk>['store']) => selectTabs(s.getState()).open.map((t) => t.id);

beforeEach(() => localStorage.clear());

it('starts with only the chat, active', () => {
  const { store } = mk();
  expect(ids(store)).toEqual(['chat']);
  expect(selectActiveTab(store.getState())).toEqual({ id: 'chat', kind: 'chat' });
});

it('opening twice keeps one tab and activates it', () => {
  const { store } = mk();
  store.dispatch(openFile('a.md'));
  store.dispatch(openFile('b.md'));
  store.dispatch(openFile('a.md'));
  expect(ids(store)).toEqual(['chat', fileTabId('a.md'), fileTabId('b.md')]);
  expect(selectActiveTab(store.getState())).toMatchObject({ kind: 'file', path: 'a.md' });
});

it('closing the active tab activates its left neighbour; closing an inactive one keeps the active', () => {
  const { store } = mk();
  ['a', 'b', 'c'].forEach((p) => store.dispatch(openFile(p)));
  store.dispatch(closeTab(fileTabId('c')));
  expect(selectTabs(store.getState()).active).toBe(fileTabId('b'));
  store.dispatch(closeTab(fileTabId('a')));
  expect(selectTabs(store.getState()).active).toBe(fileTabId('b'));
  store.dispatch(closeTab(fileTabId('b')));
  expect(selectTabs(store.getState()).active).toBe('chat');
});

it('the chat can never be closed', () => {
  const { store } = mk();
  store.dispatch(openFile('a'));
  store.dispatch(closeTab('chat'));
  store.dispatch(closeOthers(fileTabId('zzz')));
  expect(ids(store)).toEqual(['chat']);
  store.dispatch(openFile('a'));
  store.dispatch(closeRight('chat'));
  expect(ids(store)).toEqual(['chat']);
  store.dispatch(openFile('a'));
  store.dispatch(closeAll());
  expect(ids(store)).toEqual(['chat']);
  expect(selectTabs(store.getState()).active).toBe('chat');
});

it('closeOthers keeps chat and the id; closeRight drops those after it', () => {
  const { store } = mk();
  ['a', 'b', 'c'].forEach((p) => store.dispatch(openFile(p)));
  store.dispatch(closeRight(fileTabId('a')));
  expect(ids(store)).toEqual(['chat', 'file:a']);
  expect(selectTabs(store.getState()).active).toBe('file:a');
  store.dispatch(openFile('b'));
  store.dispatch(closeOthers(fileTabId('b')));
  expect(ids(store)).toEqual(['chat', 'file:b']);
  store.dispatch(activate('chat'));
  expect(selectTabs(store.getState()).active).toBe('chat');
});

it('persists paths and active (never the chat) under tabs:<root>', () => {
  const { store, session } = mk();
  session('/r1');
  store.dispatch(openFile('a.md'));
  store.dispatch(openFile('b.md'));
  store.dispatch(activate(fileTabId('a.md')));
  expect(JSON.parse(localStorage.getItem('tabs:/r1')!)).toEqual({ files: [{ path: 'a.md' }, { path: 'b.md' }], active: 'file:a.md' });
});

it('restores per root, once; another root does not restore', () => {
  localStorage.setItem('tabs:/r1', JSON.stringify({ paths: ['a.md', 'b.md'], active: 'file:b.md' }));
  const m1 = mk();
  m1.session('/r1');
  expect(ids(m1.store)).toEqual(['chat', 'file:a.md', 'file:b.md']);
  expect(selectTabs(m1.store.getState()).active).toBe('file:b.md');
  m1.store.dispatch(closeTab('file:a.md'));
  m1.session('/r1'); // same root again: no second restore
  expect(ids(m1.store)).toEqual(['chat', 'file:b.md']);

  const m2 = mk();
  m2.session('/other');
  expect(ids(m2.store)).toEqual(['chat']);
});

it('ignores corrupt stored data', () => {
  localStorage.setItem('tabs:/r1', '{nope');
  const m = mk();
  m.session('/r1');
  expect(ids(m.store)).toEqual(['chat']);
});

it('a restore leaves the saved tabs in storage (the subscriber must not write the pre-restore state back)', () => {
  const saved = JSON.stringify({ files: [{ path: 'a.md' }, { path: 'b.md' }], active: 'file:b.md' });
  localStorage.setItem('tabs:/r1', saved);
  const m = mk();
  m.session('/r1');
  expect(localStorage.getItem('tabs:/r1')).toBe(saved);
});
