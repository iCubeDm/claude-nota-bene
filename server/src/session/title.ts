const TITLE_THROTTLE_MS = 10_000;
const TITLE_TIMEOUT_MS = 5000;

type TitleOptions = {
  lookup: (id: string, dir: string) => Promise<string | null | undefined>;
  /** the session as it is now: a lookup names it when it runs, and is dropped when it moved by the answer */
  current: () => { id: string | null; dir: string; gen: number };
  onChange: () => void;
};

/**
 * The session title as the CLI lists it, looked up after results: at most one lookup per 10 s, the last result's
 * lookup trailing. A lookup reads the session as it is when it runs (`current`), and its answer is dropped when the
 * generation or the id moved meanwhile.
 */
export class TitleTracker {
  private t: string | null = null;
  private at = -Infinity;
  private timer: NodeJS.Timeout | null = null;

  private readonly o: TitleOptions;

  constructor(o: TitleOptions) {
    this.o = o;
  }

  get title(): string | null {
    return this.t;
  }

  /** A result came: look the title up now, or once the throttle allows. */
  afterResult(): void {
    if (this.timer) return;
    const wait = this.at + TITLE_THROTTLE_MS - Date.now();
    if (wait <= 0) {
      void this.refresh();
      return;
    }
    this.timer = setTimeout(() => { this.timer = null; void this.refresh(); }, wait);
    this.timer.unref();
  }

  /** The title of a session being loaded; not announced (the caller announces the session). */
  async load(id: string, dir: string): Promise<void> {
    this.at = Date.now();
    this.t = (await this.fetch(id, dir)) ?? null;
  }

  /** No title, and the next lookup is due at once (a new conversation); a scheduled lookup still runs. */
  reset(): void {
    this.t = null;
    this.at = -Infinity;
  }

  /** Cancels a scheduled lookup (a lookup in flight is dropped by the generation check). */
  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private async refresh(): Promise<void> {
    const { id, dir, gen } = this.o.current();
    if (!id) return;
    this.at = Date.now();
    const t = await this.fetch(id, dir);
    const now = this.o.current();
    if (gen !== now.gen || id !== now.id || t === undefined || t === this.t) return;
    this.t = t;
    this.o.onChange();
  }

  /** undefined when the lookup failed (the caller keeps what it had) */
  private async fetch(id: string, dir: string): Promise<string | null | undefined> {
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        this.o.lookup(id, dir),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('session info timeout')), TITLE_TIMEOUT_MS); }),
      ]);
    } catch (e) {
      console.error('[title]', e); // cosmetic and retried after the next result: not a toast
      return undefined;
    } finally {
      clearTimeout(timer);
    }
  }
}
