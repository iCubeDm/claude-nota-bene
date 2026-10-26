import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function stateDir(): string {
  const dir = process.env.NOTA_BENE_HOME ?? path.join(os.homedir(), '.nota-bene');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function read(file: string): Record<string, string> {
  try {
    const data: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
    return data && typeof data === 'object' && !Array.isArray(data) ? (data as Record<string, string>) : {};
  } catch {
    return {};
  }
}

export function lastSession(projectDir: string): string | undefined {
  return read(path.join(stateDir(), 'sessions.json'))[projectDir];
}

export function saveSession(projectDir: string, id: string | null): void {
  const file = path.join(stateDir(), 'sessions.json');
  const data = read(file);
  if (id === null) delete data[projectDir];
  else data[projectDir] = id;
  const tmp = `${file}.tmp${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

/** Adds the entries the file does not have yet (never overwrites), in one atomic write; returns how many were added. */
export function addMissingSessions(entries: Record<string, string>): number {
  const file = path.join(stateDir(), 'sessions.json');
  const data = read(file);
  let added = 0;
  for (const [k, v] of Object.entries(entries)) {
    if (data[k] !== undefined) continue;
    data[k] = v;
    added++;
  }
  if (added === 0) return 0;
  const tmp = `${file}.tmp${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
  return added;
}
