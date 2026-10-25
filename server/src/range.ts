// Single-range `Range: bytes=…` header, the semantics of the prototype's serveFile.
// null = serve 200 whole (no header, multi-range, garbage); 'unsatisfiable' = 416.
export function parseRange(
  header: string | undefined,
  size: number,
): { start: number; end: number } | 'unsatisfiable' | null {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m || (!m[1] && !m[2])) return null;
  let start: number;
  let end: number;
  if (m[1]) {
    start = Number(m[1]);
    end = m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
  } else {
    start = Math.max(0, size - Number(m[2]));
    end = size - 1;
  }
  // Chrome seeking a video asks for start == size at the very end: that is 416, not a crash
  if (start >= size || start > end) return 'unsatisfiable';
  return { start, end };
}
