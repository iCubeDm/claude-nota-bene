import type { AgentEvent, SlashCommand } from '@nota-bene/shared';

/**
 * The CLI's own commands the `/` menu offers (the user's, project's, plugin's and MCP commands are all offered). Each was run
 * against a real CLI (SDK 0.3.310, streaming input) with no terminal behind it. The first group are local commands whose output
 * comes back as a reply; the second are the bundled skills, which expand into a prompt like any skill.
 * Left out on purpose: `model` `effort` `advisor` `output-style` `config` `autocompact` (they change what the model pill and
 * the settings show, from behind the UI's back), `fast` and `focus` (answer "not available"), `color` `doctor` `reload-plugins`
 * (the CLI itself tags them terminal-only), `mcp` (sends the user to the terminal), `agents` (removed), `import`, and the rest
 * that were not tried. A command typed by hand that is not here still runs.
 */
export const BUILTIN_OK: ReadonlySet<string> = new Set([
  'compact', 'clear', 'context', 'usage', 'recap', 'rename', 'skill-doctor', 'reload-skills', 'list-agents',
  'dataviz', 'claude-api', 'simplify', 'code-review', 'verify', 'run', 'security-review', 'loop', 'update-config', 'init',
]);

type Row = { name: string; description: string; argumentHint?: string; aliases?: string[]; builtin?: boolean };

/** The SDK's row as the wire's. */
export function toSlash(r: Row): SlashCommand {
  return {
    name: r.name, description: r.description,
    ...(r.argumentHint ? { hint: r.argumentHint } : {}),
    ...(r.aliases?.length ? { aliases: r.aliases } : {}),
    ...(r.builtin ? { builtin: true } : {}),
  };
}

/** What the menu shows: no terminal-bound command, no builtin off the allowlist, one row per name, the user's own (skills, commands) first. */
export function pickCommands(rows: SlashCommand[], terminal: readonly string[] = []): SlashCommand[] {
  const hidden = new Set(terminal);
  const ok = rows.filter((c) => !hidden.has(c.name) && (!c.builtin || BUILTIN_OK.has(c.name)));
  const sorted = [...ok.filter((c) => !c.builtin), ...ok.filter((c) => c.builtin)];
  const seen = new Set<string>();
  return sorted.filter((c) => !seen.has(c.name) && !!seen.add(c.name));
}

/** The events with every pushed `commands` list filtered as the asked one is; `terminal` is read at each event (it is known from the first init on). */
export async function* offered(events: AsyncIterable<AgentEvent>, terminal: () => readonly string[]): AsyncGenerator<AgentEvent> {
  for await (const e of events) yield e.t === 'commands' ? { ...e, commands: pickCommands(e.commands, terminal()) } : e;
}
