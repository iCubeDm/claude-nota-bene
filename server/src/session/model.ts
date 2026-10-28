import type { EffortLevel, ModelOption } from '@nota-bene/shared';
import type { AgentSession } from '../agent/types.ts';
import type { EmitInput } from '../hub.ts';
import { prefsKey, readPrefs, setModelPref } from '../prefs.ts';

type ModelOptions = { dir: string; emit: (ev: Extract<EmitInput, { kind: 'model' | 'models' }>) => void; report: (where: string, e: unknown) => void };
export type CurrentModel = { model: string | null; effort?: EffortLevel };
type Agent = Pick<AgentSession, 'supportedModels' | 'setModel' | 'setEffort'>;

/**
 * The model and its effort. Like the permission mode: the pref is the user's choice and what a new agent STARTS with
 * (dropped from the start options when the agent's list does not offer it; the pref stays); what the agent itself
 * reports (init) is the truth the pill shows, and never a pref: only the user's explicit change writes one.
 */
export class ModelKeeper {
  private cur: CurrentModel;
  private opts: ModelOption[] | null = null; // kept over agent restarts, so a later start can clamp upfront
  private queue: Promise<unknown> = Promise.resolve(); // user changes, one after another
  private inflight = false; // a user change is being applied to the agent
  private fresh = false; // a model change was just applied: the first init after it may still be of the old model
  private readonly o: ModelOptions;

  constructor(o: ModelOptions) {
    this.o = o;
    this.cur = this.startChoice(o.dir);
  }

  get current(): CurrentModel {
    return this.cur;
  }

  get models(): ModelOption[] {
    return this.opts ?? [];
  }

  /** the pref, as far as the known list offers it; with no list yet it is trusted (load() corrects a bad one) */
  private startChoice(dir: string): CurrentModel {
    const p = readPrefs().models[prefsKey(dir)];
    if (!p) return { model: null };
    const o = this.opts && this.find(p.model);
    if (this.opts && !o) return { model: null };
    const effort = p.effort && (!o || o.efforts?.includes(p.effort)) ? p.effort : undefined;
    return { model: p.model, ...(effort && { effort }) };
  }

  /** the options for a new agent in `dir`: call once per start */
  forStart(dir: string): { model?: string; effort?: EffortLevel } {
    const c = this.startChoice(dir);
    return { ...(c.model && { model: c.model }), ...(c.effort && { effort: c.effort }) };
  }

  /** a switch to `dir`: its start choice (announced by the switch) */
  enter(dir: string): void {
    this.cur = this.startChoice(dir);
  }

  private find(id: string): ModelOption | undefined {
    return this.opts?.find((m) => m.value === id || m.resolved === id);
  }

  /** the CLI reports resolved ids (`claude-…`), the list has aliases (`sonnet`) */
  private same(a: string, b: string): boolean {
    const canon = (x: string) => { const m = this.find(x); return m ? (m.resolved ?? m.value) : x; };
    return a === b || canon(a) === canon(b);
  }

  /** The agent's list, once it is up. A model it started with that the list does not offer goes back to the default. */
  async load(a: Agent, still: () => boolean): Promise<void> {
    const list = await a.supportedModels();
    if (!still()) return;
    // a restart brings the same list again: only news is sent
    if (JSON.stringify(list) !== JSON.stringify(this.opts)) this.o.emit({ kind: 'models', models: list });
    this.opts = list;
    const m = this.cur.model;
    if (m && !this.find(m)) {
      await a.setModel(null);
      if (!still()) return;
      this.cur = { model: null };
      this.announce();
    } else if (this.cur.effort && !(m && this.find(m)?.efforts?.includes(this.cur.effort))) {
      await a.setEffort(null);
      if (!still()) return;
      this.cur = { model: this.cur.model };
      this.announce();
    }
  }

  /**
   * the model the agent reports (init, every turn): shown as it is, never saved. During a user change it is ignored
   * (the change sets the choice); the first one after it that differs from the choice began before setModel (the old
   * model, or a default we never saw) and is ignored.
   */
  adopt(reported: string): void {
    if (this.inflight) return;
    const was = this.fresh;
    this.fresh = false;
    if (this.cur.model && this.same(this.cur.model, reported)) return;
    if (was) return;
    this.cur = { model: reported }; // its effort is unknown now
    this.announce();
  }

  /**
   * The user's choice (`model` is a list value): validated against the list, applied to the agent from its next
   * response on, then saved. With no agent the next one starts with it. A refusal throws (the caller reports it).
   * Changes are serialized: each compares against what the previous one left.
   */
  change(a: Agent | null, next: { model: string; effort?: EffortLevel }, dir: string, still: () => boolean): Promise<void> {
    const run = this.queue.then(() => this.apply(a, next, dir, still));
    this.queue = run.catch(() => {});
    return run;
  }

  private async apply(a: Agent | null, next: { model: string; effort?: EffortLevel }, dir: string, still: () => boolean): Promise<void> {
    const opt = this.find(next.model);
    if (!opt) throw new Error(`model ${next.model} is not offered`);
    if (next.effort && !opt.efforts?.includes(next.effort)) throw new Error(`model ${opt.value} has no effort ${next.effort}`);
    const before = this.cur.model;
    this.fresh = false;
    this.inflight = true;
    try {
      if (a) {
        if (!before || !this.same(before, opt.value)) await a.setModel(opt.value);
        // (applyFlagSettings also turns ultracode off; nothing here surfaces ultracode)
        if (next.effort !== this.cur.effort) await a.setEffort(next.effort ?? null);
      }
    } finally {
      this.inflight = false;
    }
    if (!still()) return; // a switch meanwhile: this was the old session's
    this.fresh = !!a && !(before && this.same(before, opt.value));
    this.cur = { model: opt.value, ...(next.effort && { effort: next.effort }) };
    setModelPref(dir, this.cur as { model: string; effort?: EffortLevel });
  }

  private announce(): void {
    this.o.emit({ kind: 'model', model: this.cur.model, ...(this.cur.effort && { effort: this.cur.effort }) });
  }

  /** every `model` request gets exactly one answer carrying its ack */
  ack(id?: string): void {
    this.o.emit({ kind: 'model', model: this.cur.model, ...(this.cur.effort && { effort: this.cur.effort }), ...(id && { ack: id }) });
  }
}
