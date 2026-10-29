// CSI (colours, cursor), OSC (titles, hyperlinks; ended by BEL or ST), and the other two-character escapes
// eslint-disable-next-line no-control-regex
const ESC = /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)?|\u001b[@-Z\\-_]/g;

/**
 * A shell task's output as plain text: escape sequences are removed, never interpreted (the CLI's tail may hold colours,
 * cursor moves, window titles); a carriage return rewinds its line (a progress bar shows its last state), CRLF is a newline.
 */
export function plainOutput(raw: string): string {
  return raw
    .replace(ESC, '')
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => line.slice(line.lastIndexOf('\r') + 1))
    .join('\n');
}
