// Values copied from prototype/public/index.html STR.ru. Tooltip texts (stopTip, keysTip) are PLAIN TEXT:
// the prototype's <kbd> tags are dropped and <br> became "\n"; consumers render them as text (whitespace-pre-line).
export const ru = {
  langTip: 'Язык интерфейса: English',
  connecting: 'подключение…', // new in M0 (the prototype set the label from markup)
  offline: 'нет связи с сервером…',
  serverError: (w?: string) => `Ошибка сервера${w ? ' · ' + w : ''}`,
  you: 'ты',
  youBusy: ' · во время работы',
  youForced: ' · прервал агента',
  reply: (n: number, at: string) => `ответ #${n} · ${at}`,
  working: 'агент работает…',
  done: 'готово',
  failed: 'ошибка', // a turn that ended with an error (new in M0)
  secondsSuffix: 'с', // after the duration on the done line
  interrupted: 'прервано',
  send: 'Отправить',
  sendN: (n: number) => `Отправить (${n})`,
  stopTip: 'Остановить агента · Esc',
  keysTip: 'Enter — отправить\nShift+Enter — новая строка\n⌘Enter — прервать агента и отправить\nEsc — остановить агента',
  composerPh: 'Сообщение агенту… @ — сослаться на файл, выдели текст в чате или файле, чтобы прокомментировать',
  allowQ: (tool: string) => `Разрешить ${tool}?`,
  allow: 'Разрешить',
  deny: 'Запретить',
  allowed: '✓ разрешено',
  denied: '✕ запрещено',
  resumed: (id: string) => `↻ продолжение сессии ${id}`,
};
