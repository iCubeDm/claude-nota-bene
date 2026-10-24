import { getSessionMessages, query } from '@anthropic-ai/claude-agent-sdk';
import type { SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import type { AgentBackend, AgentSession, PermissionAsk } from './types.ts';
import { transcriptToEvents } from './transcript.ts';

const APPEND = `
You are running inside a browser-based chat window that renders GitHub-flavored markdown.
- Draw diagrams as \`\`\`mermaid code blocks (or \`\`\`svg blocks with a complete <svg> element). Never draw ASCII-art diagrams.
- To show an image or video from the project, embed it with markdown image syntax and a path relative to the project root, e.g. ![frame](part_1/frames/1.01.png) or ![clip](part_1/video/1.01.mp4). Videos and audio files render as players.
- Refer to project files as inline code with a path relative to the project root (\`media/pilot/notes.md\`, not an absolute or ~ path): the UI makes these clickable and opens them in a tab. Paths outside the project cannot be opened, so do not present them as links.
- The user may send batched inline comments: each item quotes a fragment from the conversation or a file, followed by their comment. Address every item.`;

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
  readonly messages: AsyncIterable<SDKMessage>;
  private readonly input = new InputQueue();
  private readonly q: ReturnType<typeof query>;

  constructor(o: { cwd: string; resume?: string; ask: PermissionAsk }) {
    this.q = query({
      prompt: this.input,
      options: {
        cwd: o.cwd,
        ...(o.resume ? { resume: o.resume } : {}),
        permissionMode: 'auto',
        includePartialMessages: true,
        // the SDK doesn't enable Claude in Chrome on its own — without the flag the session has no browser tools
        extraArgs: { chrome: null },
        systemPrompt: { type: 'preset', preset: 'claude_code', append: APPEND },
        canUseTool: async (toolName, input, { signal }) =>
          (await o.ask(toolName, input, signal))
            ? { behavior: 'allow', updatedInput: input }
            : { behavior: 'deny', message: 'User denied this action in the UI.' },
      },
    });
    this.messages = this.q;
  }

  send(m: { uuid: string; text: string; priority: 'next' | 'now' }): void {
    this.input.push({
      type: 'user',
      message: { role: 'user', content: m.text },
      parent_tool_use_id: null,
      uuid: m.uuid as SDKUserMessage['uuid'],
      priority: m.priority,
    });
  }

  async interrupt(): Promise<void> {
    await this.q.interrupt(); // resolves when idle; real failures reach the session manager
  }

  close(): void {
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
    start: (o) => new SdkSession(o),
    history: async (sessionId, cwd) => transcriptToEvents(await getSessionMessages(sessionId, { dir: cwd })),
  };
}
