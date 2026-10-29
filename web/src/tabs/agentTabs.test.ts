import { beforeEach, expect, it } from 'vitest';
import { activate, closeOthers, closeTab, openAgent, readSavedTabs, serializeTabs, setAgentTitle, tabsKey, tabsSlice, type TabsState } from './slice.ts';

const fresh = (): TabsState => tabsSlice.getInitialState();
const run = (s: TabsState, ...actions: Parameters<typeof tabsSlice.reducer>[1][]) => actions.reduce(tabsSlice.reducer, s);

beforeEach(() => localStorage.clear());

it('openAgent opens a tab once per Agent call, activates it, and a later title renames it', () => {
  let s = run(fresh(), openAgent({ tool: 'toolu_A', title: 'first' }), openAgent({ tool: 'toolu_B', title: 'other' }), openAgent({ tool: 'toolu_A', title: '' }));
  expect(s.open.map((t) => t.id)).toEqual(['chat', 'agent:toolu_A', 'agent:toolu_B']);
  expect(s.active).toBe('agent:toolu_A');
  s = run(s, setAgentTitle({ tool: 'toolu_A', title: 'real description' }), setAgentTitle({ tool: 'toolu_nope', title: 'x' }));
  expect(s.open[1]).toMatchObject({ kind: 'agent', title: 'real description' });
  expect(s.open).toHaveLength(3);
});

it('an agent tab closes like the others and is not remembered for Alt+Shift+T', () => {
  const s = run(fresh(), openAgent({ tool: 'toolu_A', title: 'a' }), activate('chat'), closeTab('agent:toolu_A'));
  expect(s.open.map((t) => t.id)).toEqual(['chat']);
  expect(s.closed).toEqual([]);
  expect(run(fresh(), openAgent({ tool: 'toolu_A', title: 'a' }), openAgent({ tool: 'toolu_B', title: 'b' }), closeOthers('agent:toolu_B')).open.map((t) => t.id)).toEqual(['chat', 'agent:toolu_B']);
});

it('saved agent tabs round-trip through storage; an entry with a path-like id is dropped, the others keep their place', () => {
  const s = run(fresh(), openAgent({ tool: 'toolu_A', title: 'a' }));
  localStorage.setItem(tabsKey('/r'), JSON.stringify({ ...serializeTabs(s), tabs: [...serializeTabs(s).tabs, { agent: { tool: '../x', title: 'bad' } }, { agent: { tool: 'toolu_B', title: 'b' } }] }));
  expect(readSavedTabs('/r')?.tabs).toEqual([{ agent: { tool: 'toolu_A', title: 'a' } }, { agent: { tool: 'toolu_B', title: 'b' } }]);
});
