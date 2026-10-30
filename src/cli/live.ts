import { watch } from 'chokidar';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import { parse, type ParsedDoc } from '../rfm/index.js';
import { readConfig, updateConfig } from '../server/config.js';
import { FileStore } from '../server/fileStore.js';
import { lockPath, readLiveState, setArmed, writeLiveState } from '../server/liveState.js';
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

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: unknown) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * One waiter per document.
 *
 * Nothing stops the agent's Stop hook from running twice (it fires at the end of every turn,
 * and a turn that continues without the human saying anything does not cancel the previous
 * run). Two waiters would print the same comment twice, and — worse — the second would take
 * the wake-up that the first had already reported as seen.
 */
export async function acquireLock(file: string): Promise<boolean> {
  const path = lockPath(file);
  await mkdir(dirname(path), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await writeFile(path, String(process.pid), { flag: 'wx' });
      return true;
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      let holder: number | null = null;
      try {
        const raw = await readFile(path, 'utf8');
        const pid = Number(raw.trim());
        holder = Number.isInteger(pid) && pid > 0 ? pid : null;
      } catch {
        holder = null;
      }
      // A holder that is gone (or a lock file with no readable pid) is stale; take it over.
      if (holder !== null && isAlive(holder)) return false;
      await rm(path, { force: true });
    }
  }
  return false;
}

/** Only the owner removes the lock: a stale one taken over by someone else is theirs now. */
export async function releaseLock(file: string): Promise<void> {
  const path = lockPath(file);
  try {
    const raw = await readFile(path, 'utf8');
    if (Number(raw.trim()) !== process.pid) return;
  } catch {
    return;
  }
  await rm(path, { force: true });
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
  const held: string[] = [];
  /** Ids already reported, per file, so a change that adds only someone else's entries is quiet. */
  const reported = new Map<string, Set<string>>();

  try {
    for (const file of targets) {
      const state = await readLiveState(file);
      if (state?.armed === false) continue;
      if (!(await acquireLock(file))) continue;
      held.push(file);

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
    if (held.length === 0) return 0;

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
          for (const file of held) await releaseLock(file);
          settled(exitCode);
        })();
      }

      async function check(): Promise<void> {
        const batches: Batch[] = [];
        for (const file of held) {
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
        if (batches.length === 0) return;
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
      for (const file of held) {
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

      const timeoutMs = opts.timeoutMs ?? 0;
      if (timeoutMs > 0) {
        timers.push(
          setTimeout(() => {
            stop(3, '');
          }, timeoutMs),
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
    for (const file of held) await releaseLock(file);
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
