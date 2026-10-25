import type { ru } from './ru.ts';

// Values copied from prototype/public/index.html STR.en. Tooltip texts (stopTip, keysTip) are PLAIN TEXT, see ru.ts.
type Dict = { [K in keyof typeof ru]: (typeof ru)[K] };

export const en: Dict = {
  langTip: 'Interface language: русский',
  emptyChat: 'Write to the agent to get started',
  connecting: 'connecting…',
  offline: 'no connection to the server…',
  serverError: (w) => `Server error${w ? ' · ' + w : ''}`,
  you: 'you',
  youBusy: ' · while working',
  youForced: ' · interrupted the agent',
  reply: (n, at) => `reply #${n} · ${at}`,
  working: 'agent is working…',
  done: 'done',
  failed: 'error', // a turn that ended with an error (new in M0)
  secondsSuffix: 's', // after the duration on the done line
  interrupted: 'interrupted',
  send: 'Send',
  sendN: (n) => `Send (${n})`,
  stopTip: 'Stop the agent · Esc',
  keysTip: 'Enter — send\nShift+Enter — new line\n⌘Enter — interrupt the agent and send\nEsc — stop the agent',
  composerPh: 'Message the agent… @ to reference a file, select text in the chat or a file to comment on it',
  allowQ: (tool) => `Allow ${tool}?`,
  allow: 'Allow',
  deny: 'Deny',
  allowed: '✓ allowed',
  denied: '✕ denied',
  mermaidError: (msg) => `mermaid error: ${msg}`,
  srcMine: 'my message',
  batchHead: 'Comments on fragments:',
  resumed: (id) => `↻ resumed session ${id}`,
};
