import { watch } from 'chokidar';
import { randomBytes } from 'node:crypto';
import { link, mkdir, open, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
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
  const now = Date.now();
  const record = JSON.stringify({
    pid: process.pid,
    ...who,
    since: new Date(now).toISOString(),
    ...(timeoutMs > 0 ? { until: new Date(now + timeoutMs).toISOString() } : {}),
  });
  for (let attempt = 0; attempt < 3; attempt++) {
    if (await createExclusive(path, record)) return record;
    const seen = await inspect(path);
    if (seen === null) continue;
    const holder = parseLock(seen.raw);
    if (holder === null) {
      // An unreadable lock this young is far more likely an older inkmark between creating the
      // file and writing its pid than a crash; taking it over is how two waiters end up on one
      // document.
      if (now - seen.mtimeMs < FRESH_LOCK_MS) return null;
    } else if (!isStale(holder)) {
      return null;
    }
    if (!(await removeIfSame(path, seen.ino))) return null;
  }
  return null;
}

/** Long enough for any writer to have finished one small write, short enough to not matter. */
const FRESH_LOCK_MS = 2000;

/**
 * Create the lock with its whole record in one step.
 *
 * `writeFile` with `wx` creates the file and only then writes it, and a reader in between sees
 * an empty lock: the viewer reports nobody, and a second waiter judges it stale and takes it.
 * A hard link to a finished temp file appears complete or not at all, and still refuses to
 * replace an existing lock.
 */
async function createExclusive(path: string, record: string): Promise<boolean> {
  const tmp = `${path}.${String(process.pid)}.${randomBytes(6).toString('hex')}.tmp`;
  await writeFile(tmp, record, { flag: 'wx' });
  try {
    await link(tmp, path);
    return true;
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'EEXIST') return false;
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

interface Seen {
  raw: string;
  ino: bigint;
  mtimeMs: number;
}

/** Content and identity from one open, so the two cannot describe different files. */
async function inspect(path: string): Promise<Seen | null> {
  let handle;
  try {
    handle = await open(path, 'r');
  } catch {
    return null;
  }
  try {
    const stats = await handle.stat({ bigint: true });
    const raw = await handle.readFile('utf8');
    return { raw, ino: stats.ino, mtimeMs: Number(stats.mtimeMs) };
  } catch {
    return null;
  } finally {
    await handle.close();
  }
}

/**
 * Run `remove` while holding the document's takeover guard; false when somebody else holds it.
 *
 * Deciding a lock is stale and deleting it are two steps, and a plain `rm` in between could
 * delete the lock another waiter just created after taking over the same stale one — two
 * waiters again. Every deletion (takeover and release alike) goes through this guard, and the
 * lock's inode is checked again under it, so the file removed is always the file judged.
 */
async function underGuard(path: string, remove: () => Promise<boolean>): Promise<boolean> {
  const guard = `${path}.takeover`;
  if (!(await createExclusive(guard, String(process.pid)))) {
    // A guard this old belongs to a process that died mid-takeover; clear it for the next try.
    const seen = await inspect(guard);
    if (seen !== null && Date.now() - seen.mtimeMs > STALE_GUARD_MS) {
      await rm(guard, { force: true });
    }
    return false;
  }
  try {
    return await remove();
  } finally {
    await rm(guard, { force: true });
  }
}

/** A takeover is a few file operations; anything this old was abandoned. */
const STALE_GUARD_MS = 10_000;

/** Remove the lock if it is still the file that was judged (gone already counts as removed). */
async function removeIfSame(path: string, ino: bigint): Promise<boolean> {
  return underGuard(path, async () => {
    const now = await inspect(path);
    if (now === null) return true;
    if (now.ino !== ino) return false;
    await rm(path, { force: true });
    return true;
  });
}

/** Whether the lock is still the one this waiter wrote: a lock past its `until` can be taken. */
export async function ownsLock(file: string, record: string): Promise<boolean> {
  try {
    return (await readFile(lockPath(file), 'utf8')) === record;
  } catch {
    return false;
  }
}

/**
 * Only the owner removes the lock: a stale one taken over by someone else is theirs now. A busy
 * guard means somebody is already taking this lock over, and will remove it themselves.
 */
export async function releaseLock(file: string, record: string): Promise<void> {
  const path = lockPath(file);
  const seen = await inspect(path);
  if (seen?.raw !== record) return;
  await removeIfSame(path, seen.ino);
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
          if (!(await ownsLock(file, record))) {
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
        const deadline = Date.now() + timeoutMs;
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
