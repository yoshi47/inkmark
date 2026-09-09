import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Thrown by `register` when another live server already holds the file. */
export class AlreadyServingError extends Error {
  readonly url: string;

  constructor(file: string, url: string) {
    super(`already serving ${file} at ${url}`);
    this.name = 'AlreadyServingError';
    this.url = url;
  }
}

export interface ServerRecord {
  file: string;
  pid: number;
  port: number;
  url: string;
  startedAt: string;
}

function homeDir(): string {
  return process.env['INKMARK_HOME'] ?? join(homedir(), '.inkmark');
}

function serversDir(): string {
  return join(homeDir(), 'servers');
}

function legacyFile(): string {
  return join(homeDir(), 'server.json');
}

function recordFile(port: number): string {
  return join(serversDir(), `${String(port)}.json`);
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: unknown) {
    // EPERM means the process exists but belongs to someone else.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function parseRecord(raw: string): ServerRecord | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null) return null;
  const r = value as Partial<ServerRecord>;
  if (typeof r.file !== 'string' || typeof r.url !== 'string') return null;
  // A pid of 0 or -1 is a process *group* to POSIX kill(2), so a hand-edited or corrupt
  // record could turn `inkmark stop` into a SIGTERM aimed at every process the user owns.
  if (typeof r.pid !== 'number' || !Number.isInteger(r.pid) || r.pid <= 0) return null;
  if (typeof r.port !== 'number' || !Number.isInteger(r.port) || r.port < 1 || r.port > 65535) {
    return null;
  }
  return {
    file: r.file,
    pid: r.pid,
    port: r.port,
    url: r.url,
    startedAt: typeof r.startedAt === 'string' ? r.startedAt : '',
  };
}

async function writeRecord(rec: ServerRecord): Promise<void> {
  await mkdir(serversDir(), { recursive: true });
  await writeFile(recordFile(rec.port), JSON.stringify(rec), 'utf8');
}

/** Fold a pre-0.2 `server.json` into the per-port layout, then drop it. */
async function migrateLegacy(): Promise<ServerRecord | null> {
  let raw: string;
  try {
    raw = await readFile(legacyFile(), 'utf8');
  } catch {
    return null;
  }
  const rec = parseRecord(raw);
  if (rec === null || !isAlive(rec.pid)) {
    await rm(legacyFile(), { force: true });
    return null;
  }
  try {
    await writeRecord(rec);
  } catch (err: unknown) {
    // Best effort: a failed migration must not take `status` and `stop` down with it.
    console.error(`inkmark: could not migrate ${legacyFile()}:`, err);
    return rec;
  }
  await rm(legacyFile(), { force: true });
  return rec;
}

/**
 * Every server whose process is still alive, lowest port first. Records left behind by
 * a dead process — or that no longer parse — are deleted on the way through, so the
 * registry heals itself. Liveness here means the pid still exists, not that the port
 * still answers: a pid the OS has recycled onto another process still reads as alive.
 */
export async function list(): Promise<ServerRecord[]> {
  const migrated = await migrateLegacy();
  const found = new Map<number, ServerRecord>();
  if (migrated !== null) found.set(migrated.port, migrated);

  let names: string[];
  try {
    names = await readdir(serversDir());
  } catch (err: unknown) {
    // Not created yet is the normal first run. Anything else (EACCES, ENOTDIR) would
    // otherwise read as "no servers" and let us start a duplicate.
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    names = [];
  }

  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const path = join(serversDir(), name);
    let raw: string;
    try {
      raw = await readFile(path, 'utf8');
    } catch {
      // Unreadable right now (EACCES, EBUSY) is not the same as unusable — skip it
      // rather than deleting the registration of a server that is very much alive.
      continue;
    }
    const rec = parseRecord(raw);
    if (rec === null || !isAlive(rec.pid)) {
      await rm(path, { force: true });
      continue;
    }
    found.set(rec.port, rec);
  }

  return [...found.values()].sort((a, b) => a.port - b.port);
}

export async function findByFile(absPath: string): Promise<ServerRecord | undefined> {
  const live = await list();
  return live.find((r) => r.file === absPath);
}

/**
 * Claim a port for this process, refusing a file another live server already holds.
 * This narrows the `findByFile` -> `startServer` -> `register` window that lets two
 * concurrent `open` calls both start a server on one file; it does not close it, since
 * the check and the write are still separate steps over separate files.
 */
export async function register(rec: ServerRecord): Promise<void> {
  const taken = await findByFile(rec.file);
  if (taken !== undefined && taken.port !== rec.port) {
    throw new AlreadyServingError(rec.file, taken.url);
  }
  await writeRecord(rec);
}

export async function unregister(port: number): Promise<void> {
  await rm(recordFile(port), { force: true });
}
