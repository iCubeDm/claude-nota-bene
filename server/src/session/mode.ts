import type { AgentMode as Mode } from '@nota-bene/shared';
import type { EmitInput } from '../hub.ts';
import { prefsKey, readPrefs, setModePref } from '../prefs.ts';

type ModeOptions = { modes: readonly Mode[]; dir: string; emit: (ev: Extract<EmitInput, { kind: 'mode' }>) => void; report: (where: string, e: unknown) => void };

/** The project's own mode, else Settings → Defaults, else auto. */
const modeFor = (root: string): Mode => { const p = readPrefs(); return p.modes[prefsKey(root)] ?? p.defaultMode ?? 'auto'; };

/**
 * The permission mode. The mode we START an agent in is clamped to the modes it offers (the pref stays as the user
 * set it); a mode the agent itself reports (init/status) is adopted as it is: the pill shows the truth.
 */
export class ModeKeeper {
  private m: Mode;
  private readonly o: ModeOptions;

  constructor(o: ModeOptions) {
    this.o = o;
    this.m = this.startMode(o.dir);
  }

  get mode(): Mode {
    return this.m;
  }

  /** a switch to `dir`: its start mode (announced by the switch) */
  enter(dir: string): Mode {
    return (this.m = this.startMode(dir));
  }

  /** the agent changed the mode itself (plan approval, its own keys): follow it, but only on a real change */
  adopt(next: Mode, dir: string): void {
    if (next === this.m) return;
    this.m = next;
    try { setModePref(dir, next); } catch (e) { this.o.report('mode', e); }
    this.o.emit({ kind: 'mode', mode: this.m });
  }

  /** the user's mode, once the agent accepted it; a pref that cannot be written throws (the caller reports it) */
  set(next: Mode, dir: string): void {
    if (this.m === next) return; // the CLI's own status frame may have set it already
    this.m = next;
    setModePref(dir, next);
  }

  /** every `mode` request gets exactly one answer carrying its ack: the sender ignores the other echoes until it has it */
  ack(id?: string): void {
    this.o.emit({ kind: 'mode', mode: this.m, ...(id && { ack: id }) });
  }

  private startMode(dir: string): Mode {
    const m = modeFor(dir);
    const { modes } = this.o;
    return modes.includes(m) ? m : (modes[0] ?? m);
  }
}
