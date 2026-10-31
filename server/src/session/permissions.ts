import type { InteractionAnswer } from '@nota-bene/shared';
import { randomUUID } from 'node:crypto';
import type { InteractAsk, PermissionAsk } from '../agent/types.ts';
import type { EmitInput } from '../hub.ts';

type AskState = 'open' | 'answered' | 'aborted';

/**
 * The agent's permission asks (R-M7-17): each is `open → answered | aborted`, and only an open ask is shown or
 * counted. An answer naming an unknown or a settled ask is ignored: a second socket answering the same card, or a
 * click that lands after the agent withdrew the ask, is normal traffic, not an error.
 */
export class PermissionBroker {
  private open = new Map<string, (allow: boolean, to: AskState) => void>();

  private structured = new Map<string, { finish(answer: InteractionAnswer | null): void; validate(answer: InteractionAnswer): boolean }>();

  private readonly o: { emit: (ev: EmitInput) => void };

  constructor(o: { emit: (ev: EmitInput) => void }) {
    this.o = o;
  }

  /**
   * The canUseTool of an agent started in generation `g`; `gen` reads the current one. An ask from an old agent
   * (after a switch) is denied at once and never shown; a settled ask is announced only while `g` is current.
   */
  ask(gen: () => number, g: number): PermissionAsk {
    return (toolName, input, signal) => new Promise<boolean>((resolve) => {
      if (g !== gen()) return resolve(false);
      const id = randomUUID();
      let state: AskState = 'open';
      const finish = (allow: boolean, to: AskState) => {
        // the first settle stands; unreachable through the interface (answer/abort/denyAll each find an open ask only)
        if (state !== 'open') return;
        state = to;
        this.open.delete(id);
        signal.removeEventListener('abort', onAbort);
        if (g === gen()) this.o.emit({ kind: 'permission-done', id, allow });
        resolve(allow);
      };
      const onAbort = () => finish(false, 'aborted');
      this.open.set(id, finish);
      signal.addEventListener('abort', onAbort, { once: true });
      this.o.emit({ kind: 'permission', id, toolName, input });
      if (signal.aborted) onAbort();
    });
  }

  interact(gen: () => number, g: number): InteractAsk {
    return (prompt, input, signal) => new Promise((resolve) => {
      if (g !== gen() || signal.aborted) return resolve(null);
      const id = randomUUID(); let done = false;
      const finish = (answer: InteractionAnswer | null) => {
        if (done) return; done = true; this.structured.delete(id); signal.removeEventListener('abort', abort);
        if (g === gen()) this.o.emit({ kind: 'permission-done', id, allow: answer !== null && !['deny', 'decline', 'cancel'].includes(answer.choice) });
        resolve(answer);
      };
      const abort = () => finish(null);
      this.structured.set(id, { finish, validate: (a) => prompt.choices.some((c) => c.id === a.choice) &&
        (['deny', 'decline', 'cancel'].includes(a.choice) || (prompt.fields ?? []).every((f) => !f.required || !!a.values?.[f.id]?.trim())) &&
        Object.keys(a.values ?? {}).every((k) => prompt.fields?.some((f) => f.id === k) === true) });
      signal.addEventListener('abort', abort, { once: true });
      this.o.emit({ kind: 'permission', id, toolName: prompt.title, input, prompt });
    });
  }

  answer(id: string, allow: boolean, response?: InteractionAnswer): void {
    const ask = this.structured.get(id);
    if (ask) { if (response && ask.validate(response)) ask.finish(response); return; }
    this.open.get(id)?.(allow, 'answered');
  }

  pending(): number {
    return this.open.size + this.structured.size;
  }

  /** every open ask: aborted (denied) — the agent died, or the session is torn down */
  denyAll(): void {
    for (const ask of [...this.structured.values()]) ask.finish(null);
    for (const finish of [...this.open.values()]) finish(false, 'aborted');
  }
}
