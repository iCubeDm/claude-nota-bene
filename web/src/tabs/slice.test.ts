import { beforeEach, expect, it, vi } from 'vitest';
import type { ClientMessage, ServerEvent } from '@nota-bene/shared';
import { makeStore } from '../store/store.ts';
import { MediaController } from '../media/mediaController.ts';
import { filesSlice, setFileLoad } from '../files/slice.ts';
import { setSource, toggleDir } from '../tree/slice.ts';
import { activate, CLOSED_MAX, closeAll, closeOthers, closeRight, closeTab, fileTabId, openDiagram, openFile, reopenClosed, selectActiveTab, selectTabs } from './slice.ts';

function mk() {
  let onEvent!: (e: ServerEvent) => void;
  const store = makeStore({
    url: 'u',
    connect: ((_u: string, e: typeof onEvent) => ((onEvent = e), { send: (_m: ClientMessage) => true, close() {} })) as never,
  });
  return { store, ev: (e: ServerEvent) => onEvent(e), session: (root: string) => onEvent({ kind: 'session', id: null, root, title: null, model: null }) };
}
const requestJumpForTest = filesSlice.actions.requestJump;
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
  expect(JSON.parse(localStorage.getItem('tabs:/r1')!)).toEqual({ tabs: [{ file: { path: 'a.md' } }, { file: { path: 'b.md' } }], active: 'file:a.md' });
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
  const saved = JSON.stringify({ tabs: [{ file: { path: 'a.md' } }, { file: { path: 'b.md' } }], active: 'file:b.md' });
  localStorage.setItem('tabs:/r1', saved);
  const m = mk();
  m.session('/r1');
  expect(localStorage.getItem('tabs:/r1')).toBe(saved);
});

// M4-10: a switch to another root replaces the file tabs (and the tree and file state) with that root's own
it('another root replaces the tabs with its saved ones (no merge); switching back restores the first root again', () => {
  localStorage.setItem('tabs:/r2', JSON.stringify({ files: [{ path: 'x.md' }], active: 'file:x.md' }));
  const m = mk();
  m.session('/r1');
  m.store.dispatch(openFile('a.md'));
  m.store.dispatch(openFile('b.md'));
  m.session('/r2');
  expect(ids(m.store)).toEqual(['chat', 'file:x.md']);
  expect(selectTabs(m.store.getState()).active).toBe('file:x.md');
  expect(JSON.parse(localStorage.getItem('tabs:/r1')!).tabs).toEqual([{ file: { path: 'a.md' } }, { file: { path: 'b.md' } }]);
  m.store.dispatch(openFile('y.md'));
  m.session('/r1');
  expect(ids(m.store)).toEqual(['chat', 'file:a.md', 'file:b.md']);
  expect(selectTabs(m.store.getState()).active).toBe('file:b.md');
  m.session('/r2');
  expect(ids(m.store)).toEqual(['chat', 'file:x.md', 'file:y.md']);
});

it('a root with nothing saved starts with only the chat; the same root again (reconnect) restores nothing', () => {
  const m = mk();
  m.session('/r1');
  m.store.dispatch(openFile('a.md'));
  m.session('/r1');
  expect(ids(m.store)).toEqual(['chat', 'file:a.md']);
  m.session('/fresh');
  expect(ids(m.store)).toEqual(['chat']);
  expect(selectTabs(m.store.getState()).active).toBe('chat');
});

it('a re-root closes every old tab through the media controller, even one whose id the new root also has', () => {
  const onClose = vi.spyOn(MediaController.prototype, 'onClose');
  localStorage.setItem('tabs:/r2', JSON.stringify({ files: [{ path: 'v.mp4' }], active: 'chat' }));
  const m = mk();
  m.session('/r1');
  m.store.dispatch(openFile('v.mp4'));
  m.store.dispatch(openFile('a.md'));
  onClose.mockClear();
  m.session('/r2');
  expect(onClose.mock.calls.map((c) => c[0]).sort()).toEqual(['file:a.md', 'file:v.mp4']);
  expect(selectTabs(m.store.getState()).root).toBe('/r2');
  onClose.mockRestore();
});

it('a re-root resets the tree to the new root\'s saved folders in this folder\'s source, and clears file load state and jumps', () => {
  localStorage.setItem('tree:/r2', JSON.stringify(['docs']));
  const m = mk();
  m.session('/r1');
  m.store.dispatch(toggleDir('src'));
  m.store.dispatch(setSource({ id: 'ref:x', dirs: ['lib'] }));
  m.store.dispatch(setFileLoad({ path: 'a.md', s: 'loaded' }));
  m.store.dispatch(openFile('a.md'));
  m.store.dispatch(requestJumpForTest({ path: 'a.md', src: 'here', id: 'c1' }));
  m.session('/r2');
  const st = m.store.getState();
  expect(st.tree.src).toBe('here');
  expect(st.tree.dirs).toEqual(['docs']);
  expect(st.files.load).toEqual({});
  expect(st.files.jump).toBeNull();
  expect(JSON.parse(localStorage.getItem('tree:/r1')!)).toEqual(['src']);
  m.session('/r1');
  expect(m.store.getState().tree.dirs).toEqual(['src']);
});

it('a re-root in the real order (replay [], then session) leaves tabs:/r2 and tree:/r2 exactly as saved', () => {
  const tabs2 = JSON.stringify({ tabs: [{ file: { path: 'x.md' } }, { file: { path: 'y.md', src: 'ref:f', ref: 'f' } }], active: 'file:x.md' });
  const tree2 = JSON.stringify(['docs', 'docs/a']);
  localStorage.setItem('tabs:/r2', tabs2);
  localStorage.setItem('tree:/r2', tree2);
  const m = mk();
  m.session('/r1');
  m.store.dispatch(openFile('a.md'));
  m.store.dispatch(toggleDir('src'));
  m.ev({ kind: 'replay', events: [] });
  m.ev({ kind: 'session', id: 'new-id', root: '/r2', title: null, model: null });
  expect(localStorage.getItem('tabs:/r2')).toBe(tabs2);
  expect(localStorage.getItem('tree:/r2')).toBe(tree2);
  expect(ids(m.store)).toEqual(['chat', 'file:x.md', 'file:ref:f:y.md']);
});

it('one onSwitch per restore: the first root and every re-root report the active change once', () => {
  const onSwitch = vi.spyOn(MediaController.prototype, 'onSwitch');
  localStorage.setItem('tabs:/r1', JSON.stringify({ files: [{ path: 'b.md' }], active: 'file:b.md' }));
  localStorage.setItem('tabs:/r2', JSON.stringify({ files: [{ path: 'x.md' }], active: 'file:x.md' }));
  const m = mk();
  m.session('/r1');
  expect(onSwitch.mock.calls).toEqual([['chat', 'file:b.md']]);
  onSwitch.mockClear();
  m.ev({ kind: 'replay', events: [] });
  m.session('/r2');
  expect(onSwitch.mock.calls).toEqual([['file:b.md', 'file:x.md']]);
  onSwitch.mockRestore();
});

it('the closed-tab stack: every close kind remembers its files, last closed first; an open one is skipped; capped (M6-14)', () => {
  const { store } = mk();
  for (const f of ['a', 'b', 'c', 'd', 'e']) store.dispatch(openFile(`${f}.ts`));
  store.dispatch(closeTab('file:e.ts'));
  store.dispatch(closeRight('file:b.ts')); // c, d
  store.dispatch(closeOthers('file:b.ts')); // a
  expect(selectTabs(store.getState()).closed.map((f) => (typeof f === 'string' ? f : f.path))).toEqual(['e.ts', 'c.ts', 'd.ts', 'a.ts']);
  store.dispatch(reopenClosed());
  expect(selectTabs(store.getState()).active).toBe('file:a.ts');
  store.dispatch(openFile('d.ts')); // opened again by hand: skipped
  store.dispatch(reopenClosed());
  expect(ids(store)).toEqual(['chat', 'file:b.ts', 'file:a.ts', 'file:d.ts', 'file:c.ts']);
  store.dispatch(closeAll());
  expect(selectTabs(store.getState()).closed.slice(-4).map((f) => (typeof f === 'string' ? f : f.path))).toEqual(['b.ts', 'a.ts', 'd.ts', 'c.ts']);
  for (let i = 0; i < CLOSED_MAX + 5; i++) { store.dispatch(openFile(`n${i}.ts`)); store.dispatch(closeTab(`file:n${i}.ts`)); }
  expect(selectTabs(store.getState()).closed).toHaveLength(CLOSED_MAX);
  store.dispatch(closeAll());
  store.dispatch(reopenClosed());
  expect(selectTabs(store.getState()).active).toBe(`file:n${CLOSED_MAX + 4}.ts`);
});

it('another folder empties the closed-tab stack: its paths are other files (M6-14)', () => {
  const { store, session } = mk();
  session('/p');
  store.dispatch(openFile('a.ts'));
  store.dispatch(closeTab('file:a.ts'));
  session('/q');
  expect(selectTabs(store.getState()).closed).toEqual([]);
  store.dispatch(reopenClosed());
  expect(ids(store)).toEqual(['chat']);
});

// M7-01: a diagram opens in its own tab
const SRC = 'graph TD; A-->B';
const diagramIds = (s: ReturnType<typeof mk>['store']) => ids(s).filter((i) => i.startsWith('diagram:'));

it('a diagram opens as a tab titled by its first line (40 chars), id diagram:<8 hex>', () => {
  const { store } = mk();
  store.dispatch(openDiagram({ source: `${'x'.repeat(50)}\nsecond`, lang: 'mermaid' }));
  const tab = selectActiveTab(store.getState());
  expect(tab).toMatchObject({ kind: 'diagram', lang: 'mermaid', title: 'x'.repeat(40) });
  expect(tab.id).toMatch(/^diagram:[0-9a-f]{8}$/);
});

it('the same diagram opened twice reuses its tab; another source gets its own', () => {
  const { store } = mk();
  store.dispatch(openDiagram({ source: SRC, lang: 'mermaid' }));
  store.dispatch(openFile('a.md'));
  store.dispatch(openDiagram({ source: SRC, lang: 'mermaid' }));
  expect(diagramIds(store)).toHaveLength(1);
  expect(selectTabs(store.getState()).active).toBe(diagramIds(store)[0]);
  store.dispatch(openDiagram({ source: 'graph LR; C-->D', lang: 'mermaid' }));
  expect(diagramIds(store)).toHaveLength(2);
});

it('diagram tabs are saved with the file tabs, source included, and restored after a reload', () => {
  const a = mk();
  a.session('/p');
  a.store.dispatch(openFile('a.md'));
  a.store.dispatch(openDiagram({ source: SRC, lang: 'mermaid' }));
  const id = diagramIds(a.store)[0];
  expect(JSON.parse(localStorage.getItem('tabs:/p')!).tabs).toEqual([{ file: { path: 'a.md' } }, { diagram: { source: SRC, lang: 'mermaid' } }]);
  const b = mk(); // a reload
  b.session('/p');
  expect(ids(b.store)).toEqual(['chat', 'file:a.md', id]);
  expect(selectTabs(b.store.getState()).active).toBe(id);
  expect(selectActiveTab(b.store.getState())).toMatchObject({ kind: 'diagram', source: SRC });
});

it('a closed diagram tab is not offered by reopen (only files are remembered)', () => {
  const { store } = mk();
  store.dispatch(openDiagram({ source: SRC, lang: 'svg' }));
  store.dispatch(closeTab(diagramIds(store)[0]));
  store.dispatch(reopenClosed());
  expect(diagramIds(store)).toEqual([]);
});

it('the order of mixed tabs and the active one survive a reload', () => {
  const a = mk();
  a.session('/p');
  a.store.dispatch(openDiagram({ source: SRC, lang: 'mermaid' }));
  a.store.dispatch(openFile('a.md'));
  a.store.dispatch(openDiagram({ source: 'graph LR; C-->D', lang: 'mermaid' }));
  a.store.dispatch(activate(diagramIds(a.store)[0]));
  const before = ids(a.store);
  expect(before).toHaveLength(4);
  expect(before[2]).toBe('file:a.md');
  const b = mk();
  b.session('/p');
  expect(ids(b.store)).toEqual(before);
  expect(selectTabs(b.store.getState()).active).toBe(diagramIds(a.store)[0]);
});

it('tabs saved in the older formats ({files}, {paths}) are still read', () => {
  localStorage.setItem('tabs:/o1', JSON.stringify({ files: [{ path: 'a.md' }], active: 'file:a.md' }));
  localStorage.setItem('tabs:/o2', JSON.stringify({ paths: ['b.md'], active: 'file:b.md' }));
  const a = mk();
  a.session('/o1');
  expect(ids(a.store)).toEqual(['chat', 'file:a.md']);
  const b = mk();
  b.session('/o2');
  expect(ids(b.store)).toEqual(['chat', 'file:b.md']);
});
