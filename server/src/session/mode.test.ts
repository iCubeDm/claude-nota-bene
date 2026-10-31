import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AgentMode as Mode } from '@nota-bene/shared';
import type { EmitInput } from '../hub.ts';
import { prefsKey, readPrefs, setModePref } from '../prefs.ts';
import { ModeKeeper } from './mode.ts';

let home: string;
const prevHome = process.env.NOTA_BENE_HOME;
beforeEach(() => {
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nb-mode-')));
  process.env.NOTA_BENE_HOME = home;
});
afterEach(() => {
  if (prevHome === undefined) delete process.env.NOTA_BENE_HOME; else process.env.NOTA_BENE_HOME = prevHome;
  fs.rmSync(home, { recursive: true, force: true });
});

function make(modes: Mode[] = ['default', 'acceptEdits', 'plan', 'auto']) {
  const events: EmitInput[] = [];
  const m = new ModeKeeper({ modes, dir: '/p', emit: (ev) => events.push(ev), report: () => {} });
  return { m, events };
}

describe('ModeKeeper', () => {
  it('starts in the project pref, else the default pref, else auto', () => {
    expect(make().m.mode).toBe('auto');
    setModePref('/p', 'plan');
    expect(make().m.mode).toBe('plan');
  });

  it("the start mode is clamped to the agent's modes; the pref stays as the user set it", () => {
    setModePref('/p', 'plan');
    expect(make(['default', 'auto']).m.mode).toBe('default');
    expect(readPrefs().modes[prefsKey('/p')]).toBe('plan');
  });

  it('enter: a switch takes the new dir\'s start mode, without announcing it', () => {
    const { m, events } = make();
    setModePref('/q', 'acceptEdits');
    expect(m.enter('/q')).toBe('acceptEdits');
    expect(m.mode).toBe('acceptEdits');
    expect(events).toEqual([]);
  });

  it('adopt: a mode the agent reports is taken as it is, saved and announced, only on a change', () => {
    const { m, events } = make(['default']);
    m.adopt('plan', '/p');
    m.adopt('plan', '/p');
    expect(m.mode).toBe('plan');
    expect(readPrefs().modes[prefsKey('/p')]).toBe('plan');
    expect(events).toEqual([{ kind: 'mode', mode: 'plan' }]);
  });

  it('set: the user\'s mode once the agent took it, saved, not announced; ack answers with the current mode', () => {
    const { m, events } = make();
    m.set('plan', '/p');
    expect(m.mode).toBe('plan');
    expect(readPrefs().modes[prefsKey('/p')]).toBe('plan');
    expect(events).toEqual([]);
    m.ack('a1');
    m.ack();
    expect(events).toEqual([{ kind: 'mode', mode: 'plan', ack: 'a1' }, { kind: 'mode', mode: 'plan' }]);
  });
});
