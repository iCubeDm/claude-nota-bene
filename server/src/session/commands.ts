import type { SlashCommand } from '@nota-bene/shared';
import type { ProviderSession as AgentSession } from '../agent/types.ts';
import type { EmitInput } from '../hub.ts';

type Agent = Pick<AgentSession, 'supportedCommands'>;

/**
 * The agent's slash commands and skills, as the `/` menu shows them. Asked once when an agent is up, replaced whenever the
 * agent pushes a new list; clients hear only a change (a restart brings the same list again), and a new socket gets the
 * current one with the other state. A switch empties it first: the next project has its own skills.
 */
export class CommandKeeper {
  private list: SlashCommand[] = [];
  private version = 0; // bumped by every change: a list asked for before a newer one arrived is stale
  private readonly emit: (ev: Extract<EmitInput, { kind: 'commands' }>) => void;
  private readonly timeoutMs: number;

  constructor(emit: (ev: Extract<EmitInput, { kind: 'commands' }>) => void, timeoutMs = 15_000) {
    this.emit = emit;
    this.timeoutMs = timeoutMs;
  }

  get commands(): SlashCommand[] {
    return this.list;
  }

  set(next: SlashCommand[]): void {
    this.version++;
    if (JSON.stringify(next) === JSON.stringify(this.list)) return;
    this.list = next;
    this.emit({ kind: 'commands', commands: next });
  }

  /**
   * The agent's list, once it is up; `still`: it is the current agent (a switch meanwhile made this one stale). Rejects when the
   * agent does not answer in time. An answer that comes after the agent pushed a list is dropped: the push is newer.
   */
  async load(a: Agent, still: () => boolean): Promise<void> {
    const at = this.version;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<never>((_, rej) => { timer = setTimeout(() => rej(new Error('supportedCommands timed out')), this.timeoutMs); });
    try {
      const list = await Promise.race([a.supportedCommands(), late]);
      if (still() && at === this.version) this.set(list);
    } finally {
      clearTimeout(timer);
    }
  }
}
