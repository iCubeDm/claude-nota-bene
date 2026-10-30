import { SHELL_CMD_MAX } from '@nota-bene/shared';
import { t } from '../i18n/index.ts';
import { toast } from '../shell/toast.ts';
import { selectPending } from '../comments/slice.ts';
import { activate } from '../tabs/slice.ts';
import { selectConn, type AppThunk, type RootState } from '../store/store.ts';
import { selectDraft, selectImages, setDraft, shellDraftSent } from './slice.ts';

/** The first protocol whose server takes `shell-run` and `shell-stop`: an older one would send `! cmd` to the agent as a message, so the page keeps it a message there. */
export const SHELL_PROTOCOL = 11;

/**
 * A draft that is a shell command (as in Claude Code's terminal): one line that starts with `!` at offset 0 (not `![`, a
 * markdown link or image), and the server knows `shell-run`. A pasted script of several lines is a message: it must not run on one Enter.
 */
export const isShellDraft = (draft: string): boolean => draft.startsWith('!') && !draft.startsWith('![') && !draft.includes('\n');
export const selectShellMode = (s: RootState): boolean => s.controls.protocol >= SHELL_PROTOCOL && isShellDraft(selectDraft(s));

/** The id of the `! cmd` run in progress, if the feed shows one. */
export const selectShellRunning = (s: RootState): string | null => {
  const it = s.feed.items.find((x) => x.kind === 'shell' && x.running);
  return it?.kind === 'shell' ? it.id : null;
};

/** The command of a shell draft: what follows the `!`, trimmed. */
export const commandOf = (draft: string): string => draft.slice(1).trim();

/**
 * Enter on a shell draft. 'blocked' keeps the draft (pending comments or images, a command still running, one too long);
 * 'empty' is a bare `!`; 'offline' sends nothing; 'sent' clears the draft and shows the chat, where the block appears.
 * Never a message to the agent: the server runs it, and the agent hears of it with the next message.
 */
export const runShellDraft = (): AppThunk<'sent' | 'blocked' | 'empty' | 'offline'> => (d, getState, { send }) => {
  const st = getState();
  const draft = selectDraft(st);
  const cmd = commandOf(draft);
  if (selectPending(st).length || selectImages(st).length) return (toast(t('shellWithAttachments'), ''), 'blocked');
  if (!cmd) return 'empty';
  if (new TextEncoder().encode(cmd).length > SHELL_CMD_MAX) return (toast(t('shellTooLong'), ''), 'blocked');
  if (selectShellRunning(st)) return (toast(t('shellBusy'), ''), 'blocked');
  const id = crypto.randomUUID();
  if (selectConn(st) !== 'open' || !send({ type: 'shell-run', id, cmd })) return 'offline';
  d(shellDraftSent({ id, draft })); // until the server's shell-start: a refusal puts it back
  d(setDraft(''));
  d(activate('chat'));
  return 'sent';
};

/** false: the stop did not go out (offline). */
export const stopShell = (id: string): AppThunk<boolean> => (_d, _g, { send }) => send({ type: 'shell-stop', id });
