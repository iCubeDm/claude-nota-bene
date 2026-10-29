// ESC then: a CSI (colours, cursor), an OSC (titles, hyperlinks; ended by BEL or ST), or any other escape (charset selects
// `ESC ( B`, save / restore cursor `ESC 7` / `ESC 8`, keypad `ESC =` / `ESC >`, ...): intermediates, then one final byte
// eslint-disable-next-line no-control-regex
const ESC = /\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007\u001b]*(?:\u0007|\u001b\\)?|[ -/]*[0-~])/g;
// the control characters left once the escapes are gone (all of C0 and DEL but tab, newline, carriage return, backspace)
// eslint-disable-next-line no-control-regex
const CTRL = /[\u0000-\u0007\u000b\u000c\u000e-\u001f\u007f]/g;

/** A line after its backspaces: each one deletes the character before it (a `\b|\b/` spinner leaves nothing). */
function backspaces(line: string): string {
  if (!line.includes('\b')) return line;
  const out: string[] = [];
  for (const ch of line) {
    if (ch === '\b') out.pop();
    else out.push(ch);
  }
  return out.join('');
}

/**
 * A shell task's output as plain text: escape sequences are removed, never interpreted (the CLI's tail may hold colours,
 * cursor moves, window titles); a carriage return rewinds its line (a progress bar shows its last state; one that ends the
 * line, as rsync / wget write it, does not blank it), CRLF is a newline, a backspace deletes the character before it.
 * `truncated`: the tail began in the middle of the output, so it may begin in the middle of an escape sequence (`2;32m…`).
 */
export function plainOutput(raw: string, truncated = false): string {
  const text = truncated ? raw.replace(/^[0-9;:?]+[@-~]/, '') : raw;
  return text
    .replace(ESC, '')
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => {
      const l = line.replace(/\r+$/, '');
      return backspaces(l.slice(l.lastIndexOf('\r') + 1)).replace(CTRL, '');
    })
    .join('\n');
}
