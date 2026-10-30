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
