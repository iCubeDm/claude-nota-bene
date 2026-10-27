import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SessionInfo, SessionListEntry } from '../agent/types.ts';
import { SwitchError } from './phase.ts';
import { checkTarget, realOr } from './target.ts';

const SID = '44444444-4444-4444-8444-444444444444';
let tmp: string;
let A: string;
let B: string;
beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nb-target-')));
  A = path.join(tmp, 'a');
  B = path.join(tmp, 'b');
  fs.mkdirSync(A);
  fs.mkdirSync(B);
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

function backend(o: { list?: SessionListEntry[] | Error; info?: SessionInfo | null | Error } = {}) {
  return {
    listSessions: async () => { if (o.list instanceof Error) throw o.list; return o.list ?? []; },
    sessionInfo: async () => { if (o.info instanceof Error) throw o.info; return o.info === undefined ? null : o.info; },
  };
}
const check = (b: ReturnType<typeof backend>, id: string | null, dir: string, ownSession = false) =>
  checkTarget({ backend: b, root: A, id, dir, ownSession });
async function refusal(p: Promise<string>): Promise<string> {
  const e = await p.catch((x: unknown) => x);
  expect(e).toBeInstanceOf(SwitchError);
  expect(e).toMatchObject({ where: 'switch' });
  return (e as Error).message;
}

describe('checkTarget', () => {
  it('a relative, missing or non-directory dir is refused', async () => {
    fs.writeFileSync(path.join(tmp, 'f'), '');
    for (const d of ['a', path.join(tmp, 'nope'), path.join(tmp, 'f')]) {
      expect(await refusal(check(backend(), null, d))).toMatch(/not an existing, readable directory/);
    }
  });

  it('its own session (a restart) needs only the directory', async () => {
    expect(await check(backend({ info: new Error('x') }), 'whatever', A, true)).toBe(A);
  });

  it('a new session: here, or where a session lives; elsewhere refused; a failed list refused', async () => {
    expect(await check(backend(), null, A)).toBe(A);
    expect(await refusal(check(backend(), null, B))).toBe(`no session lives in ${B}`);
    expect(await check(backend({ list: [{ sessionId: SID, lastModified: 0, cwd: B }] }), null, B)).toBe(B);
    expect(await refusal(check(backend({ list: new Error('down') }), null, B))).toBe('cannot list sessions: down');
  });

  it('an id: must look like a session id and belong to the dir', async () => {
    expect(await refusal(check(backend(), 'x/../y', B))).toBe('invalid session id: x/../y');
    expect(await refusal(check(backend({ info: null }), SID, B))).toBe(`session 44444444 does not belong to ${B}`);
    expect(await refusal(check(backend({ info: { cwd: A } }), SID, B))).toBe(`session 44444444 does not belong to ${B}`);
    expect(await refusal(check(backend({ info: new Error('io') }), SID, B))).toBe('cannot read session 44444444: io');
    expect(await check(backend({ info: { cwd: B } }), SID, B)).toBe(B);
  });

  it('realOr: the realpath, or the resolved path when it does not exist', () => {
    expect(realOr(A)).toBe(A);
    expect(realOr('/nonexistent-nb/x/..')).toBe('/nonexistent-nb');
  });
});
