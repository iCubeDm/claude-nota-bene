import { getSessionInfo, getSessionMessages, getSubagentMessages, listSessions, listSubagents, query } from '@anthropic-ai/claude-agent-sdk';
import type { ModelInfo, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { CLAUDE_CAPABILITIES, type AgentEvent, type EffortLevel, type Mode, type ModelOption } from '@nota-bene/shared';
import type { AgentBackend, AgentSession, PermissionAsk, SendImage } from '../types.ts';
import { mapFrames } from './map.ts';
import { transcriptToEvents } from './transcript.ts';
import { agentOfCall, findSubagentMeta, hitFresh, hitGet, hitSet, isRunning, noMetaAdd, noMetaHas } from './subagents.ts';
import { defaultProjectsDir } from '../../sessions.ts';
import { UsageUnavailableError, mapContextUsage, mapUsage } from '../../stats.ts';

const APPEND = `
You are running inside a browser-based chat window that renders GitHub-flavored markdown.
- Draw diagrams as \`\`\`mermaid code blocks (or \`\`\`svg blocks with a complete <svg> element). Never draw ASCII-art diagrams.
- To show an image or video from the project, embed it with markdown image syntax and a path relative to the project root, e.g. ![frame](part_1/frames/1.01.png) or ![clip](part_1/video/1.01.mp4). Videos and audio files render as players.
- Refer to project files as inline code with a path relative to the project root (\`media/pilot/notes.md\`, not an absolute or ~ path): the UI makes these clickable and opens them in a tab. Paths outside the project cannot be opened, so do not present them as links.
- The user may send batched inline comments: each item quotes a fragment from the conversation or a file, followed by their comment. Address every item. Whatever the user read and left without a comment has no objections: treat it as accepted, do not ask about it or revisit it.`;

/** the SDK's model row as the wire's; the effort levels only where the model has any */
export function toModelOption(m: ModelInfo): ModelOption {
  return {
    value: m.value, name: m.displayName, description: m.description,
    ...(m.resolvedModel ? { resolved: m.resolvedModel } : {}),
    ...(m.supportsEffort && m.supportedEffortLevels?.length ? { efforts: [...m.supportedEffortLevels] } : {}),
  };
}

// 'default' is a row of the list, not a model id: it means "no model option" (the CLI's own default)
const realModel = (m: string | null | undefined): string | undefined => (m && m !== 'default' ? m : undefined);

/** A text block first, then a [label text, image block] pair per image, so the agent can tell which image is which. */
export function toContent(text: string, images?: SendImage[]): SDKUserMessage['message']['content'] {
  if (!images?.length) return text;
  return [
    { type: 'text', text: text || ' ' },
    ...images.flatMap((im) => [
      { type: 'text' as const, text: im.label || '[image]' },
      { type: 'image' as const, source: { type: 'base64' as const, media_type: im.mediaType, data: im.data } },
    ]),
  ];
}

// Async queue feeding the SDK's streaming input; ends after close().
class InputQueue implements AsyncIterable<SDKUserMessage> {
  private readonly items: SDKUserMessage[] = [];
  private wake: (() => void) | null = null;
  private done = false;

  push(m: SDKUserMessage): void {
    if (this.done) return;
    this.items.push(m);
    this.wake?.();
  }

  end(): void {
    this.done = true;
    this.wake?.();
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<SDKUserMessage> {
    while (true) {
      while (this.items.length) yield this.items.shift()!;
      if (this.done) return;
      await new Promise<void>((r) => { this.wake = r; });
      this.wake = null;
    }
  }
}

class SdkSession implements AgentSession {
  readonly messages: AsyncIterable<AgentEvent>;
  private readonly input = new InputQueue();
  private readonly q: ReturnType<typeof query>;
  private readonly warmup: NodeJS.Timeout;

  constructor(o: Parameters<AgentBackend['start']>[0]) {
    this.q = query({
      prompt: this.input,
      options: {
        cwd: o.cwd,
        ...(o.resume ? { resume: o.resume } : {}),
        ...(o.resume && o.fork ? { forkSession: true } : {}),
        permissionMode: o.permissionMode,
        ...(realModel(o.model) ? { model: realModel(o.model) } : {}),
        ...(o.effort ? { effort: o.effort } : {}),
        includePartialMessages: true,
        // predicted next prompt after each turn: the UI shows it as ghost text in the composer
        promptSuggestions: true,
        // the SDK doesn't enable Claude in Chrome on its own — without the flag the session has no browser tools
        extraArgs: { chrome: null },
        systemPrompt: { type: 'preset', preset: 'claude_code', append: APPEND },
        canUseTool: async (toolName, input, { signal }) =>
          (await o.ask(toolName, input, signal))
            ? { behavior: 'allow', updatedInput: input }
            : { behavior: 'deny', message: 'User denied this action in the UI.' },
      },
    });
    this.messages = mapFrames(this.q);
    // warm the CLI's file index (it answers [] for a few seconds after start); the failure does not matter
    this.warmup = setTimeout(() => void this.fileSuggestions('').catch(() => {}), 2000);
    this.warmup.unref();
  }

  async fileSuggestions(query: string): Promise<string[]> {
    // `request` is the SDK's internal control channel, not public API (the prototype does the same), so it is
    // reached through a narrow cast; any throw or odd shape is the caller's cue to fall back
    const { q } = this as unknown as {
      q: { request(r: { subtype: 'file_suggestions'; query: string }, o?: { signal?: AbortSignal }): Promise<{ response: { suggestions: { path: string }[] } }> };
    };
    const r = await q.request({ subtype: 'file_suggestions', query }, { signal: AbortSignal.timeout(1500) });
    return r.response.suggestions.map((x) => x.path);
  }

  async stopTask(taskId: string): Promise<void> {
    await this.q.stopTask(taskId);
  }

  async backgroundTask(toolUseId: string): Promise<boolean> {
    return await this.q.backgroundTasks(toolUseId);
  }

  async taskOutput(taskId: string): Promise<{ output: string; totalBytes: number; truncated: boolean }> {
    // The control request is typed in the SDK; the runtime also has Query.getTaskOutput, but it is not in sdk.d.ts and takes no
    // abort signal. Only `request` takes one (the 5 s cap below), so it stays; same narrow cast as fileSuggestions. Move to the
    // public method when the .d.ts exposes it with a signal.
    const { q } = this as unknown as {
      q: { request(r: { subtype: 'get_task_output'; task_id: string }, o?: { signal?: AbortSignal }): Promise<{ response: { output: string; total_bytes: number; truncated: boolean } }> };
    };
    const { response: r } = await q.request({ subtype: 'get_task_output', task_id: taskId }, { signal: AbortSignal.timeout(5000) });
    if (typeof r?.output !== 'string') throw new Error('get_task_output: unexpected answer');
    return { output: r.output, totalBytes: Number(r.total_bytes) || 0, truncated: r.truncated === true };
  }

  async contextUsage(): Promise<{ used: number; max: number; pct: number }> {
    return mapContextUsage(await this.q.getContextUsage({ detail: 'summary' }));
  }

  async usage(): Promise<Awaited<ReturnType<AgentSession['usage']>>> {
    // EXPERIMENTAL in the SDK ("method name will change when stabilized"): feature-check it and reach it through a
    // narrow cast, so a release that renames or drops it gives a recognisable error instead of a TypeError
    const { q } = this as unknown as {
      q: { usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET?: (o: { skipBehaviors: boolean }) => Promise<Parameters<typeof mapUsage>[0]> };
    };
    const fn = q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET;
    if (typeof fn !== 'function') throw new UsageUnavailableError();
    return mapUsage(await fn.call(q, { skipBehaviors: true }));
  }

  send(m: { uuid: string; text: string; priority: 'next' | 'now'; images?: SendImage[] }): void {
    this.input.push({
      type: 'user',
      message: { role: 'user', content: toContent(m.text, m.images) },
      parent_tool_use_id: null,
      uuid: m.uuid as SDKUserMessage['uuid'],
      priority: m.priority,
    });
  }

  async setPermissionMode(mode: Mode): Promise<void> {
    await this.q.setPermissionMode(mode);
  }

  async supportedModels(): Promise<ModelOption[]> {
    return (await this.q.supportedModels()).map(toModelOption);
  }

  async setModel(model: string | null): Promise<void> {
    await this.q.setModel(realModel(model));
  }

  async setEffort(effort: EffortLevel | null): Promise<void> {
    await this.q.applyFlagSettings({ effortLevel: effort }); // null: back to the model's default
  }

  async interrupt(): Promise<void> {
    await this.q.interrupt(); // resolves when idle; real failures reach the session manager
  }

  close(): void {
    clearTimeout(this.warmup);
    this.input.end();
    try {
      this.q.close();
    } catch {
      // already closed
    }
  }
}

export function sdkBackend(): AgentBackend {
  return {
    capabilities: CLAUDE_CAPABILITIES,
    start: (o) => new SdkSession(o),
    listSessions: () => listSessions({ limit: 300 }),
    sessionInfo: async (id, dir) => (await getSessionInfo(id, { dir })) ?? null,
    history: async (sessionId, cwd, attachments, onError) => transcriptToEvents(await getSessionMessages(sessionId, { dir: cwd }), attachments, onError),
    subagent: async (sessionId, cwd, toolUseId, attachments, onError, call) => {
      const ids = await listSubagents(sessionId, { dir: cwd });
      const meta = findSubagentMeta(defaultProjectsDir(), sessionId, toolUseId);
      let agentId = meta && ids.includes(meta.agentId) ? meta.agentId : null;
      let type = meta?.type ?? '', description = meta?.description ?? '';
      // no live task and no fresh transcript: whatever the meta lacks, it is not running (see isRunning)
      let running = meta ? isRunning(meta, call?.live ?? false) : false;
      if (!agentId) {
        // no meta (an older CLI): the Agent call in the main transcript names it, `agentId: …` in its result. The answer
        // changes when the call's result arrives or its files show up, so a miss is remembered per (session, call,
        // hasResult) for a few seconds only (noMetaHas): a poll does not parse the whole main transcript again, a late
        // file is still found
        const key = `${sessionId}\0${toolUseId}\0${call?.hasResult ?? ''}`;
        const hitKey = `${sessionId}\0${toolUseId}`;
        const cached = hitGet(hitKey);
        if (!cached && noMetaHas(key)) return null;
        let hit = cached ? hitFresh(cached, defaultProjectsDir(), sessionId, call?.live ?? false) : null;
        if (!hit) {
          hit = agentOfCall(await getSessionMessages(sessionId, { dir: cwd }), toolUseId, ids, defaultProjectsDir(), sessionId, call?.live ?? false);
          if (!hit) return (noMetaAdd(key), null);
          hitSet(hitKey, hit);
        }
        ({ agentId, type, description, running } = hit);
      }
      return { events: transcriptToEvents(await getSubagentMessages(sessionId, agentId, { dir: cwd }), attachments, onError, { subagent: true }), running, type, description };
    },
  };
}
