import type { SlashCommand } from '@nota-bene/shared';
import type { AgentSession } from '../agent/types.ts';
import type { EmitInput } from '../hub.ts';

type Agent = Pick<AgentSession, 'supportedCommands'>;

/**
 * The agent's slash commands and skills, as the `/` menu shows them. Asked once when an agent is up, replaced whenever the
 * agent pushes a new list; clients hear only a change (a restart brings the same list again), and a new socket gets the
 * current one with the other state. A switch empties it first: the next project has its own skills.
 */
export class CommandKeeper {
  private list: SlashCommand[] = [];
  private readonly emit: (ev: Extract<EmitInput, { kind: 'commands' }>) => void;

  constructor(emit: (ev: Extract<EmitInput, { kind: 'commands' }>) => void) {
    this.emit = emit;
  }

  get commands(): SlashCommand[] {
    return this.list;
  }

  set(next: SlashCommand[]): void {
    if (JSON.stringify(next) === JSON.stringify(this.list)) return;
    this.list = next;
    this.emit({ kind: 'commands', commands: next });
  }

  /** the agent's list, once it is up; `still`: it is the current agent (a switch meanwhile made this one stale) */
  async load(a: Agent, still: () => boolean): Promise<void> {
    const list = await a.supportedCommands();
    if (still()) this.set(list);
  }
}
