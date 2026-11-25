import { watch } from 'chokidar';
import { randomBytes } from 'node:crypto';
import { link, mkdir, open, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { parse, type ParsedDoc } from '../rfm/index.js';
import { readConfig, updateConfig } from '../server/config.js';
import { FileStore } from '../server/fileStore.js';
import {
  isStale,
  lockPath,
  parseLock,
  readLiveState,
  setArmed,
  writeLiveState,
} from '../server/liveState.js';
import { homeDir } from '../server/paths.js';
import { FileWatcher } from '../server/watch.js';
import { list } from './registry.js';

/**
 * Live mode: hold a process open until the human writes a comment in the viewer, then print
 * it and exit. The agent's Stop hook runs this in the background, so the wake-up costs
 * nothing while the human is reading — the alternative, a tool call that blocks, spends a
 * model turn every time it times out and cannot outlive the turn that started it.
 *
 * What counts as new is decided against the state file in `server/liveState.ts`, not against
 * "the process started a moment ago": the wait between two `wait` calls is exactly when a
 * comment is most likely to land, and a baseline taken at start would swallow it. That file
 * also records what has already woken the agent, so a reply of its own can never wake it
 * again — and it is what the viewer's per-document switch writes.
 */

/**
 * The author label a wake-up is for. The viewer writes `by: user` for everything a human
 * does, so this is an allowlist rather than "anything that is not the agent": an agent that
 * labels its reply `by: Claude` instead of `by: AI` would otherwise wake itself with its own
 * answer, forever.
 */
const DEFAULT_AUTHOR = 'user';
const ANCHOR_MAX = 120;
/** Well inside `UNTIL_GRACE_MS`, so a waiter leaves before anyone may take its lock. */
const DEADLINE_POLL_MS = 10_000;
/** How soon to look again when the lock could not be read to confirm ownership. */
const OWNERSHIP_RETRY_MS = 1000;

export interface NewComment {
  id: string;
  by: string;
  at: string;
  /** The id this entry answers; null when it is a thread root. */
  re: string | null;
  body: string | null;
  /** The text the mark sits on, whitespace-collapsed and clipped. */
  anchor: string | null;
}

export interface Batch {
  file: string;
  comments: NewComment[];
}

/** What a waiter says about itself in the lock, for the viewer to show who is listening. */
export interface Holder {
  agent?: string;
  session?: string;
  project?: string;
}

/**
 * One waiter per document.
 *
 * Nothing stops the agent's Stop hook from running twice (it fires at the end of every turn,
 * and a turn that continues without the human saying anything does not cancel the previous
 * run). Two waiters would print the same comment twice, and — worse — the second would take
 * the wake-up that the first had already reported as seen.
 */
export async function acquireLock(
  file: string,
  who: Holder = {},
  timeoutMs = 0,
): Promise<string | null> {
  const path = lockPath(file);
  await mkdir(dirname(path), { recursive: true });
  await sweepTemps(dirname(path));
  const now = Date.now();
  const record = JSON.stringify({
    pid: process.pid,
    ...who,
    since: new Date(now).toISOString(),
    ...(timeoutMs > 0 ? { until: new Date(now + timeoutMs).toISOString() } : {}),
    // Identity checks compare content, so two records from one process in the same millisecond
    // must still differ.
    nonce: nonce(),
  });
  for (let attempt = 0; attempt < 3; attempt++) {
    if (await createExclusive(path, record)) return record;
    let seen: Seen | null;
    try {
      seen = await inspect(path);
    } catch {
      // Cannot see who holds it, so cannot judge it stale either.
      return null;
    }
    if (seen === null) continue;
    const holder = parseLock(seen.raw);
    if (holder === null) {
      // An unreadable lock this young is far more likely an older inkmark between creating the
      // file and writing its pid than a crash; taking it over is how two waiters end up on one
      // document.
      if (!isOld(seen, FRESH_LOCK_MS)) return null;
    } else if (!isStale(holder)) {
      return null;
    }
    const removed = await removeIfSame(path, seen);
    // Busy guard: look again, since the guard may have been an abandoned one just cleared, or
    // the other taker may have finished and left a live lock that the next look will respect.
    if (removed === null) continue;
    // The lock changed under the guard: somebody else holds the document now.
    if (!removed) return null;
  }
  return null;
}

/** Long enough for any writer to have finished one small write, short enough to not matter. */
const FRESH_LOCK_MS = 2000;
/** A temp file outlives its create only when the process died in between. */
const STALE_TEMP_MS = 60_000;

function nonce(): string {
  return randomBytes(8).toString('hex');
}

/**
 * A clock that jumped back makes everything look younger than it is; treating a negative age
 * as old keeps such a file from being judged fresh for as long as the jump.
 */
function isOld(seen: Seen, ms: number): boolean {
  const age = Date.now() - seen.mtimeMs;
  return age < 0 || age > ms;
}

/** Temp files left by a waiter killed between writing and linking; nothing else removes them. */
async function sweepTemps(dir: string): Promise<void> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return;
  }
  for (const name of names) {
    if (!name.endsWith('.tmp')) continue;
    const temp = join(dir, name);
    try {
      const seen = await inspect(temp);
      if (seen !== null && isOld(seen, STALE_TEMP_MS)) await rm(temp, { force: true });
    } catch {
      // Best effort: a temp file that cannot be read now is retried on the next acquire.
    }
  }
}

/**
 * Create the lock with its whole record in one step.
 *
 * `writeFile` with `wx` creates the file and only then writes it, and a reader in between sees
 * an empty lock: the viewer reports nobody, and a second waiter judges it stale and takes it.
 * A hard link to a finished temp file appears complete or not at all, and still refuses to
 * replace an existing lock.
 */
async function createExclusive(path: string, record: string, retried = false): Promise<boolean> {
  const tmp = `${path}.${String(process.pid)}.${nonce()}.tmp`;
  let written = false;
  try {
    await writeFile(tmp, record, { flag: 'wx' });
    written = true;
    await link(tmp, path);
    return true;
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'EEXIST') return false;
    // The temp file vanished between write and link: another waiter's sweep took it while this
    // process was suspended past STALE_TEMP_MS. Nothing was created, so writing it again is safe.
    if (code === 'ENOENT' && written && !retried) return await createExclusive(path, record, true);
    // A filesystem without hard links: the non-atomic create beats no live mode at all.
    if (code === 'EPERM' || code === 'ENOTSUP' || code === 'ENOSYS') {
      try {
        await writeFile(path, record, { flag: 'wx' });
        return true;
      } catch (fallback: unknown) {
        if ((fallback as NodeJS.ErrnoException).code === 'EEXIST') return false;
        throw fallback;
      }
    }
    throw err;
  } finally {
    await rm(tmp, { force: true });
  }
}

export interface Seen {
  raw: string;
  ino: bigint;
  mtimeNs: bigint;
  mtimeMs: number;
}

/**
 * Content and identity from one open, so the two cannot describe different files. Null only
 * when the file is not there; any other failure is thrown, because "unreadable" must not be
 * mistaken for "gone".
 */
async function inspect(path: string): Promise<Seen | null> {
  let handle;
  try {
    handle = await open(path, 'r');
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
  try {
    const stats = await handle.stat({ bigint: true });
    const raw = await handle.readFile('utf8');
    return { raw, ino: stats.ino, mtimeNs: stats.mtimeNs, mtimeMs: Number(stats.mtimeMs) };
  } finally {
    await handle.close();
  }
}

/**
 * Whether two looks at a path saw the same file. The inode alone is not enough: ext4 and tmpfs
 * hand a freed inode straight to the next file, so a lock deleted and re-created by another
 * waiter can come back with the inode of the one that was judged stale.
 */
export function sameFile(a: Seen, b: Seen): boolean {
  return a.ino === b.ino && a.mtimeNs === b.mtimeNs && a.raw === b.raw;
}

/** Delete `path` if it is still `seen`; true when it is gone either way. */
async function removeIfUnchanged(path: string, seen: Seen): Promise<boolean> {
  const now = await inspect(path);
  if (now === null) return true;
  if (!sameFile(now, seen)) return false;
  await rm(path, { force: true });
  return true;
}

/**
 * Run `remove` while holding the document's takeover guard; null when somebody else holds it.
 *
 * Deciding a lock is stale and deleting it are two steps, and a plain `rm` in between could
 * delete the lock another waiter just created after taking over the same stale one — two
 * waiters again. Every deletion (takeover and release alike) goes through this guard, and the
 * lock is compared again under it, so the file removed is always the file judged.
 *
 * A guard holder can be suspended long enough for its guard to be judged abandoned and
 * replaced; it checks the guard is still its own before acting and before letting go, so on
 * resuming it neither deletes a lock under someone else's guard nor deletes their guard.
 *
 * Known limit: every such check is a read followed by a delete by path, and that gap cannot be
 * closed without an atomic compare-and-delete, which the filesystem does not offer. It matters
 * only when three or more waiters contend after a guard holder crashed or was suspended past
 * STALE_GUARD_MS, and one of them stalls exactly inside the gap.
 */
async function underGuard(
  path: string,
  remove: (stillMine: () => Promise<boolean>) => Promise<boolean>,
): Promise<boolean | null> {
  const guard = `${path}.takeover`;
  const token = JSON.stringify({ pid: process.pid, nonce: nonce() });
  if (!(await createExclusive(guard, token))) {
    // A guard this old belongs to a process that died mid-takeover; clear it for the next try,
    // but only the guard that was judged, not one created since.
    const seen = await inspect(guard);
    if (seen !== null && isOld(seen, STALE_GUARD_MS)) await removeIfUnchanged(guard, seen);
    return null;
  }
  // Unreadable right after creating it: act as if it were already lost, and let it go stale.
  const mine = await inspect(guard).catch(() => null);
  async function stillMine(): Promise<boolean> {
    const now = await inspect(guard);
    return mine !== null && now !== null && sameFile(now, mine);
  }
  try {
    return await remove(stillMine);
  } finally {
    if (mine !== null) await removeIfUnchanged(guard, mine);
  }
}

/** A takeover is a few file operations; anything this old was abandoned. */
const STALE_GUARD_MS = 10_000;

/**
 * Remove the lock if it is still the file that was judged (gone already counts as removed).
 * Null when the guard was busy, so the caller can tell "try again" from "not yours".
 */
async function removeIfSame(path: string, seen: Seen): Promise<boolean | null> {
  return underGuard(path, async (stillMine) => {
    if (!(await stillMine())) return false;
    return removeIfUnchanged(path, seen);
  });
}

/**
 * Whether the lock is still the one this waiter wrote: a lock past its `until` can be taken.
 * Null when that cannot be told right now (a read error other than the lock being gone), which
 * is not the same as having lost it.
 */
export async function ownsLock(file: string, record: string): Promise<boolean | null> {
  try {
    return (await readFile(lockPath(file), 'utf8')) === record;
  } catch (err: unknown) {
    return (err as NodeJS.ErrnoException).code === 'ENOENT' ? false : null;
  }
}

const RELEASE_TRIES = 10;
const RELEASE_RETRY_MS = 50;

/**
 * Only the owner removes the lock: a stale one taken over by someone else is theirs now.
 *
 * A busy guard is usually another waiter that judged this lock and found it live; it lets go
 * within a few file operations, so waiting briefly is enough. If it does not, the lock is left
 * behind and becomes stale once this pid exits or its `until` passes.
 */
export async function releaseLock(file: string, record: string): Promise<void> {
  const path = lockPath(file);
  for (let attempt = 0; attempt < RELEASE_TRIES; attempt++) {
    let seen: Seen | null;
    try {
      seen = await inspect(path);
    } catch {
      seen = null;
    }
    if (seen?.raw !== record) return;
    if ((await removeIfSame(path, seen)) !== null) return;
    await delay(RELEASE_RETRY_MS);
  }
}

/**
 * Where a comment is anchored.
 *
 * A comment's `{#id}` lands on the `{>> <<}` span, and the text it annotates is the span
 * ending exactly where that note opens — the same pairing `noteSpan` in `rfm/parse.ts`
 * relies on. A highlight carries its own id and needs no search.
 */
export function anchorFor(doc: ParsedDoc, id: string): string | null {
  const index = doc.spans.findIndex((s) => s.id === id);
  const own = doc.spans[index];
  if (own === undefined) return null;
  if (own.kind !== 'comment') return clip(own.inner);
  const before = doc.spans[index - 1];
  if (before?.end !== own.start || before.kind === 'comment') return null;
  return clip(before.inner);
}

function clip(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length === 0) return '';
  return flat.length > ANCHOR_MAX ? `${flat.slice(0, ANCHOR_MAX)}…` : flat;
}

/**
 * The entries worth waking for: not already reported, and written by the author being
 * watched (the viewer's `by: user`). Everything — roots, replies, notes on a highlight —
 * comes from the endmatter, which is the truth about who wrote what; the body only supplies
 * the anchor.
 */
export function newComments(
  doc: ParsedDoc,
  reported: ReadonlySet<string>,
  author: string = DEFAULT_AUTHOR,
): NewComment[] {
  const found: NewComment[] = [];
  for (const [id, meta] of Object.entries(doc.endmatter.comments)) {
    if (reported.has(id)) continue;
    if (meta.by !== author) continue;
    found.push({
      id,
      by: meta.by,
      at: meta.at,
      re: meta.re ?? null,
      body: meta.body ?? null,
      anchor: anchorFor(doc, id),
    });
  }
  return found.sort((a, b) => {
    const byTime = a.at.localeCompare(b.at);
    return byTime !== 0 ? byTime : a.id.localeCompare(b.id);
  });
}

export function formatBatches(batches: Batch[]): string {
  const lines: string[] = [];
  for (const batch of batches) {
    const count = batch.comments.length;
    lines.push(`inkmark: ${String(count)} new comment${count === 1 ? '' : 's'} in ${batch.file}`);
    for (const comment of batch.comments) {
      lines.push('');
      const re = comment.re === null ? '' : `  re ${comment.re}`;
      lines.push(`${comment.id}  ${comment.by}  ${comment.at}${re}`);
      if (comment.anchor !== null && comment.anchor !== '') {
        lines.push(`  on: ${comment.anchor}`);
      }
      if (comment.body !== null && comment.body !== '') {
        lines.push(`  note: ${comment.body.replace(/\s+/g, ' ')}`);
      }
    }
    lines.push('');
  }
  lines.push(
    'Reply in the same file: a `by: AI` entry under `comments:` (the inkmark skill has the rules).',
  );
  return `${lines.join('\n')}\n`;
}

export interface WaitOptions {
  /** Directories to watch inkmark-served files under; defaults to the working directory. */
  project?: string;
  /** 0 waits forever, which is what a background hook wants. */
  timeoutMs?: number;
  json?: boolean;
  /** The `by:` value that wakes the wait. Defaults to the viewer's `user`. */
  author?: string;
  /** Recorded in the lock so the viewer can say which agent is listening. */
  agent?: string;
  session?: string;
}

/** The files a wait covers: the one named, or every inkmark server's file under `project`. */
async function resolveTargets(
  fileArg: string | undefined,
  project: string | undefined,
): Promise<string[]> {
  if (fileArg !== undefined) return [resolve(process.cwd(), fileArg)];
  const base = resolve(process.cwd(), project ?? '.');
  const prefix = base.endsWith(sep) ? base : `${base}${sep}`;
  const servers = await list();
  return [...new Set(servers.map((s) => s.file))].filter(
    (file) => file === base || file.startsWith(prefix),
  );
}

async function readDoc(file: string): Promise<ParsedDoc | null> {
  try {
    return parse(await readFile(file, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Print the batches as they are found and exit 0. Exit 3 means the timeout ran out with
 * nothing to report, and anything else means there was nothing to wait for at all — the
 * hook treats all three as "do not wake the agent", so the distinction is for the human.
 */
export async function cmdWait(
  fileArg: string | undefined,
  opts: WaitOptions = {},
): Promise<number> {
  if ((await readConfig()).live === false) return 0;

  const targets = await resolveTargets(fileArg, opts.project);
  if (targets.length === 0) return 0;

  const author = opts.author ?? DEFAULT_AUTHOR;
  const timeoutMs = opts.timeoutMs ?? 0;
  /** File to the lock record written for it, which is how ownership is told apart later. */
  const held = new Map<string, string>();
  /** Ids already reported, per file, so a change that adds only someone else's entries is quiet. */
  const reported = new Map<string, Set<string>>();
  const who: Holder = {
    project: resolve(process.cwd(), opts.project ?? '.'),
    ...(opts.agent === undefined ? {} : { agent: opts.agent }),
    ...(opts.session === undefined ? {} : { session: opts.session }),
  };

  try {
    for (const file of targets) {
      const state = await readLiveState(file);
      if (state?.armed === false) continue;
      const record = await acquireLock(file, who, timeoutMs);
      if (record === null) continue;
      held.set(file, record);

      const doc = await readDoc(file);
      if (state === null) {
        // First run on this document: whatever is already there is backlog, not news.
        const ids = doc === null ? [] : Object.keys(doc.endmatter.comments);
        reported.set(file, new Set(ids));
        await writeLiveState({ file, reported: ids });
        continue;
      }
      reported.set(file, new Set(state.reported));
    }
    if (held.size === 0) return 0;

    const code = await new Promise<number>((settled) => {
      let finished = false;
      const timers: NodeJS.Timeout[] = [];
      /** At most one pending ownership retry, so repeated read errors do not pile up timers. */
      let retryTimer: NodeJS.Timeout | undefined;
      const watchers: FileWatcher[] = [];
      const signals: (() => void)[] = [];
      // The directory, not the file: `config.yml` is written by rename, which swaps the inode
      // and leaves a watcher pinned to the old one. Same reason `FileWatcher` watches its dir.
      const configWatcher = watch(homeDir(), {
        depth: 0,
        ignoreInitial: true,
        awaitWriteFinish: { stabilityThreshold: 50, pollInterval: 10 },
      });

      function stop(exitCode: number, out: string): void {
        if (finished) return;
        finished = true;
        for (const timer of timers) clearTimeout(timer);
        clearTimeout(retryTimer);
        for (const off of signals) off();
        void configWatcher.close();
        for (const watcher of watchers) void watcher.close();
        if (out !== '') process.stdout.write(out);
        void (async (): Promise<void> => {
          for (const [file, record] of held) await releaseLock(file, record);
          settled(exitCode);
        })();
      }

      async function check(): Promise<void> {
        const batches: Batch[] = [];
        for (const [file, record] of held) {
          // Another waiter may have taken the lock over after `until`, e.g. while this one slept
          // with the laptop; reporting as well would wake the agent twice.
          const owned = await ownsLock(file, record);
          if (owned === null) {
            // Cannot tell right now; keep the document and look again rather than go quiet.
            retryLater();
            continue;
          }
          if (!owned) {
            held.delete(file);
            continue;
          }
          const doc = await readDoc(file);
          if (doc === null) continue;
          const seen = reported.get(file) ?? new Set<string>();
          const fresh = newComments(doc, seen, author);
          if (fresh.length === 0) continue;
          for (const comment of fresh) seen.add(comment.id);
          reported.set(file, seen);
          const state = await readLiveState(file);
          await writeLiveState({
            file,
            reported: [...seen],
            ...(state?.armed === false ? { armed: false } : {}),
          });
          batches.push({ file, comments: fresh });
        }
        if (batches.length === 0) {
          if (held.size === 0) stop(0, '');
          return;
        }
        stop(
          0,
          opts.json === true
            ? `${JSON.stringify({ files: batches }, null, 2)}\n`
            : formatBatches(batches),
        );
      }

      // Serialised, not fire-and-forget: two changes a few milliseconds apart would both read
      // the same "reported" set, and a comment they share would be printed twice.
      let queue: Promise<void> = Promise.resolve();
      function retryLater(): void {
        if (retryTimer !== undefined || finished) return;
        retryTimer = setTimeout(() => {
          retryTimer = undefined;
          queue = queue.then(check).catch(() => undefined);
        }, OWNERSHIP_RETRY_MS);
      }
      for (const file of held.keys()) {
        const watcher = new FileWatcher(new FileStore(file));
        watcher.onChange(() => {
          queue = queue.then(check).catch(() => undefined);
        });
        watcher.start();
        watchers.push(watcher);
      }

      // Report what is already waiting before parking: a comment left while nothing was
      // listening (the previous waiter timed out, the session was between turns) is still news,
      // and no file change will follow to announce it.
      queue = queue.then(check).catch(() => undefined);

      // The switch the reader flips in the browser or with `inkmark live off` has to take
      // effect on a waiter that is already running, or the one comment after the flip still
      // wakes the agent.
      configWatcher.on('all', (_event, changed) => {
        if (!changed.endsWith('config.yml')) return;
        void readConfig().then((config) => {
          if (config.live === false) stop(0, '');
        });
      });

      if (timeoutMs > 0) {
        timers.push(
          setTimeout(() => {
            stop(3, '');
          }, timeoutMs),
        );
        // The timer above does not count time the machine spent asleep, but `until` in the lock
        // is wall-clock; without this a waiter woken from sleep outlives the lock it advertised.
        // Taken from the lock itself, so the waiter leaves by the time it told others it would.
        const deadline = Math.min(
          ...[...held.values()].map((record) => {
            const until = parseLock(record)?.until;
            return until == null ? Infinity : Date.parse(until);
          }),
        );
        timers.push(
          setInterval(() => {
            if (Date.now() >= deadline) stop(3, '');
          }, DEADLINE_POLL_MS),
        );
      }

      for (const signal of ['SIGINT', 'SIGTERM'] as const) {
        function handler(): void {
          stop(0, '');
        }
        process.once(signal, handler);
        signals.push(() => {
          process.off(signal, handler);
        });
      }
    });

    return code;
  } finally {
    for (const [file, record] of held) await releaseLock(file, record);
  }
}

/**
 * `inkmark live [on|off] [file.md]` — the switch. With a file it is that document's switch,
 * the same one the viewer's header toggles; without one it is the master switch in
 * `config.yml`, which silences every document at once.
 */
export async function cmdLive(
  mode: string | undefined,
  fileArg: string | undefined,
): Promise<number> {
  if (mode !== undefined && mode !== 'on' && mode !== 'off') {
    console.error('usage: inkmark live [on|off] [file.md]');
    return 2;
  }
  if (fileArg !== undefined) {
    const file = resolve(process.cwd(), fileArg);
    if (mode === undefined) {
      const state = await readLiveState(file);
      console.log(`live: ${state?.armed === false ? 'off' : 'on'}  ${file}`);
      return 0;
    }
    await setArmed(file, mode === 'on');
    console.log(`live ${mode}  ${file}`);
    return 0;
  }
  if (mode === undefined) {
    const config = await readConfig();
    console.log(`live: ${config.live === false ? 'off' : 'on'}`);
    return 0;
  }
  await updateConfig({ live: mode === 'on' });
  console.log(`live ${mode}`);
  return 0;
}
