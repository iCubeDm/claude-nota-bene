import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { EmitInput } from '../hub.ts';
import { lastSession } from '../state.ts';
import { SessionIdentity } from './identity.ts';

const ID1 = '11111111-1111-4111-8111-111111111111';
const ID2 = '22222222-2222-4222-8222-222222222222';
let home: string;
const prevHome = process.env.NOTA_BENE_HOME;
beforeEach(() => {
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nb-identity-')));
  process.env.NOTA_BENE_HOME = home;
});
afterEach(() => {
  if (prevHome === undefined) delete process.env.NOTA_BENE_HOME; else process.env.NOTA_BENE_HOME = prevHome;
  fs.rmSync(home, { recursive: true, force: true });
});

function make(o: { resume?: string; fork?: boolean } = {}) {
  const events: EmitInput[] = [];
  const errors: string[] = [];
  let title: string | null = null;
  const heard: [string, string | null][] = [];
  const s = new SessionIdentity({ root: '/p', ...o, title: () => title, emit: (ev) => events.push(ev), report: (w) => errors.push(w) });
  s.onId((id, prev) => heard.push([id, prev]));
  return { s, events, errors, heard, setTitle: (t: string | null) => { title = t; } };
}

describe('SessionIdentity', () => {
  it('announce sends `session` only when a field changed; forget makes the next one go out', () => {
    const { s, events, setTitle } = make();
    s.announce();
    s.announce();
    expect(events).toEqual([{ kind: 'session', id: null, root: '/p', title: null, model: null }]);
    setTitle('T');
    s.announce();
    s.forget();
    s.announce();
    expect(events).toHaveLength(3);
  });

  it("init: the CLI's id is adopted, saved once, announced, and heard (with the previous id)", () => {
    const { s, events, heard } = make({ resume: ID1 });
    s.init({ sessionId: ID1, model: 'm' });
    expect(heard).toEqual([]); // the resumed id was heard already
    expect(lastSession('/p')).toBe(ID1);
    s.init({ sessionId: ID2 });
    expect(s.info()).toEqual({ id: ID2, root: '/p', model: 'm' });
    expect(lastSession('/p')).toBe(ID2);
    expect(heard).toEqual([[ID2, ID1]]);
    expect(events.at(-1)).toMatchObject({ kind: 'session', id: ID2, model: 'm' });
  });

  it('a fork start: the agent starts with fork from the source, which is never saved; its init ends the fork', () => {
    const { s } = make({ resume: ID1, fork: true });
    expect(s.startOptions()).toEqual({ cwd: '/p', resume: ID1, fork: true });
    expect(lastSession('/p')).toBeUndefined();
    s.init({ sessionId: ID2 });
    expect(s.startOptions()).toEqual({ cwd: '/p', resume: ID2 });
    expect(lastSession('/p')).toBe(ID2);
  });

  it('enter (a switch): a restart before the fork has its id keeps forking and saves nothing; another target ends it', () => {
    const { s, heard } = make({ resume: ID1, fork: true });
    expect(s.enter(ID1, '/p')).toBe(true); // the same session in the same dir
    expect(s.startOptions()).toEqual({ cwd: '/p', resume: ID1, fork: true });
    expect(lastSession('/p')).toBeUndefined();
    expect(s.enter(ID2, '/q')).toBe(false);
    expect(s.startOptions()).toEqual({ cwd: '/q', resume: ID2 });
    expect(lastSession('/q')).toBe(ID2);
    expect(heard).toEqual([]); // a switch's id is announced by the switch listeners, not the id listeners
    s.init({ sessionId: ID2 });
    expect(heard).toEqual([]);
  });

  it('enter clears the model and saves a new session as nothing', () => {
    const { s } = make();
    s.init({ model: 'm' });
    s.enter(null, '/p');
    expect(s.info()).toEqual({ id: null, root: '/p', model: null });
    expect(s.startOptions()).toEqual({ cwd: '/p' });
  });

  it('reset (/clear): a uuid becomes the id, saved and heard; anything else is ignored; the next announce always goes out', () => {
    const { s, events, heard } = make({ resume: ID1, fork: true });
    s.announce();
    expect(s.reset('not-a-uuid')).toBeNull();
    expect(s.info().id).toBe(ID1);
    s.announce();
    expect(events).toHaveLength(2); // forgotten by the reset
    expect(s.reset(ID2)).toBe(ID2);
    expect(s.startOptions()).toEqual({ cwd: '/p', resume: ID2 });
    expect(lastSession('/p')).toBe(ID2);
    s.hear(ID2);
    expect(heard).toEqual([[ID2, ID1]]);
  });

  it('a failing id listener is reported and the others still hear', () => {
    const { s, errors, heard } = make();
    s.onId(() => { throw new Error('x'); });
    const later: string[] = [];
    s.onId((id) => later.push(id));
    s.hear(ID1);
    expect(errors).toEqual(['session-id']);
    expect(heard).toEqual([[ID1, null]]);
    expect(later).toEqual([ID1]);
  });
});
