import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { homeDir } from './paths.js';

/**
 * Per-document live-mode bookkeeping, kept under `~/.inkmark/live/` and keyed by path.
 *
 * Two callers share it and must see the same truth: the browser toggles `armed` through
 * `/api/live`, and `inkmark wait` reads it to decide whether this document wakes an agent at
 * all. `reported` is the other half — every comment id that has already woken somebody — so a
 * comment left unhandled while a waiter timed out is not reported twice.
 *
 * Lives in `server/` rather than `cli/` because both sides need it now. The CLI is the one
 * that watches and prints; the server only records the reader's choice.
 */
export interface LiveState {
  file: string;
  reported: string[];
  /** false when live mode is off for this one document. Absent means on. */
  armed?: boolean;
}

function digest(file: string): string {
  return createHash('sha1').update(file).digest('hex').slice(0, 16);
}

export function liveDir(): string {
  return join(homeDir(), 'live');
}

export function statePath(file: string): string {
  return join(liveDir(), `${digest(file)}.json`);
}

/** One waiter per document; the lock is what keeps a second Stop hook from double-reporting. */
export function lockPath(file: string): string {
  return join(liveDir(), `${digest(file)}.lock`);
}

/**
 * Who holds a document's lock, i.e. which agent a comment would wake right now.
 *
 * The lock doubles as the answer because it is the one thing that exists exactly while a waiter
 * does: the per-document `armed` switch says a comment *may* wake an agent, and says nothing
 * about whether any agent is listening — which is what the viewer has to show.
 */
export interface Watcher {
  pid: number;
  /** The hook's name for the agent (`claude`, `codex`); null for a hand-run `inkmark wait`. */
  agent: string | null;
  /** The agent's session id, so the reader can tell two sessions in one project apart. */
  session: string | null;
  /** The directory the waiter was started for. */
  project: string | null;
  since: string | null;
}

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: unknown) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

/**
 * The lock's contents, alive or not. A bare pid is still accepted: waiters started by an older
 * inkmark keep running through an upgrade and write nothing else.
 */
export function parseLock(raw: string): Watcher | null {
  const text = raw.trim();
  if (/^\d+$/.test(text)) {
    const pid = Number(text);
    return pid > 0 ? { pid, agent: null, session: null, project: null, since: null } : null;
  }
  try {
    const value: unknown = JSON.parse(text);
    if (typeof value !== 'object' || value === null) return null;
    const rec = value as Record<string, unknown>;
    const pid = rec['pid'];
    if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return null;
    return {
      pid,
      agent: stringOrNull(rec['agent']),
      session: stringOrNull(rec['session']),
      project: stringOrNull(rec['project']),
      since: stringOrNull(rec['since']),
    };
  } catch {
    return null;
  }
}

/** The waiter holding this document, or null when nobody is listening (a stale lock included). */
export async function readWatcher(file: string): Promise<Watcher | null> {
  let raw: string;
  try {
    raw = await readFile(lockPath(file), 'utf8');
  } catch {
    return null;
  }
  const watcher = parseLock(raw);
  return watcher !== null && isAlive(watcher.pid) ? watcher : null;
}

/** A corrupt or half-written state is treated as "nothing reported yet", never as a crash. */
export async function readLiveState(file: string): Promise<LiveState | null> {
  let raw: string;
  try {
    raw = await readFile(statePath(file), 'utf8');
  } catch {
    return null;
  }
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value !== 'object' || value === null) return null;
    const rec = value as Partial<LiveState>;
    const reported = Array.isArray(rec.reported)
      ? rec.reported.filter((id): id is string => typeof id === 'string')
      : [];
    const state: LiveState = { file, reported };
    if (rec.armed === false) state.armed = false;
    return state;
  } catch {
    return null;
  }
}

export async function writeLiveState(state: LiveState): Promise<void> {
  const path = statePath(state.file);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(state)}\n`, 'utf8');
}

/**
 * Flip this document's switch and keep whatever `reported` says.
 *
 * Read-modify-write over one file, with the same lost-update window `updateConfig` accepts:
 * a waiter adding an id at the same instant as a toggle could drop that id, and the cost is
 * one comment reported twice, not a broken file.
 */
export async function setArmed(file: string, armed: boolean): Promise<LiveState> {
  const current = await readLiveState(file);
  const next: LiveState = { file, reported: current?.reported ?? [], armed };
  await writeLiveState(next);
  return next;
}
