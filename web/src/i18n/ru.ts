// Values copied from prototype/public/index.html STR.ru. Tooltip texts (stopTip, keysTip) are PLAIN TEXT:
// the prototype's <kbd> tags are dropped and <br> became "\n"; consumers render them as text (whitespace-pre-line).
export const ru = {
  langTip: 'Язык интерфейса: English',
  emptyChat: 'Напиши агенту, чтобы начать',
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
  mermaidError: (msg: string) => `ошибка mermaid: ${msg}`, // new in M0 (the prototype had it in English only)
  srcMine: 'моё сообщение',
  commentBtn: '💬 Комментировать',
  batchHead: 'Комментарии к фрагментам:',
  resumed: (id: string) => `↻ продолжение сессии ${id}`,
  // quick labels (M1-08)
  'label_looks-good': 'Выглядит хорошо',
  label_clarify: 'Поясни',
  label_verify: 'Проверь',
  label_example: 'Приведи пример',
  label_overview: 'Нет общей картины',
  label_patterns: 'Как в существующем коде',
  label_alternatives: 'Рассмотри альтернативы',
  'label_no-regression': 'Без регрессий',
  'label_out-of-scope': 'Вне задачи',
  'label_needs-tests': 'Нужны тесты',
};
