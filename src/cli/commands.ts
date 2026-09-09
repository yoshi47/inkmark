import { spawn } from 'node:child_process';
import { type FileHandle, open as fsOpen, mkdir, stat } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import open from 'open';
import { type RunningServer, startServer } from '../server/start.js';
import { findFreePort } from './port.js';
import {
  AlreadyServingError,
  findByFile,
  homeDir,
  list,
  register,
  type ServerRecord,
  unregister,
} from './registry.js';

const DEFAULT_PORT = 4747;
const DETACH_TIMEOUT_MS = 10_000;
const DETACH_POLL_MS = 100;
const PROBE_TIMEOUT_MS = 1000;
const EXIT_TIMEOUT_MS = 2000;
const EXIT_POLL_MS = 50;
const USAGE = `usage: inkmark open <file.md> [--port <n>] [--detach]
       inkmark status
       inkmark stop [file.md|port] [--force]
       inkmark forget <file.md|port>`;

export interface OpenOptions {
  port?: number;
  detach?: boolean;
  /** Overridable so tests do not have to spawn the real CLI. */
  spawnChild?: (args: string[], logFile: string) => void | Promise<void>;
  /** Overridable so the "child never registered" test does not wait the full timeout. */
  detachTimeoutMs?: number;
  /** Overridable so tests can take the server and return instead of parking forever. */
  wait?: (server: RunningServer) => Promise<void>;
  /** Overridable so tests do not have to stand up a real server to be identified. */
  probe?: (rec: ServerRecord) => Promise<Identity>;
}

export interface StopOptions {
  /** Signal the recorded pid without asking the port who it is. */
  force?: boolean;
  /** Overridable so tests do not have to stand up a real server to be identified. */
  probe?: (rec: ServerRecord) => Promise<Identity>;
}

function park(_server: RunningServer): Promise<void> {
  return new Promise<void>(() => {
    /* run until a signal handler exits the process */
  });
}

/**
 * `findFreePort` probes and releases, so another process can take the port before we
 * bind it. Retry up the range rather than failing — a busy port is never a question to
 * put to the user.
 */
async function listenWithRetry(absPath: string, preferred: number): Promise<RunningServer> {
  let from = preferred;
  let lost: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    const port = await findFreePort(from);
    try {
      return await startServer(absPath, port);
    } catch (err: unknown) {
      // Only a lost race is worth another port. EACCES on a privileged port, or anything
      // the watcher throws, would otherwise be reported as "the ports are busy".
      if ((err as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw err;
      lost = err;
      from = port + 1;
    }
  }
  throw new Error(`could not bind a port near ${String(preferred)} after 3 attempts`, {
    cause: lost,
  });
}

/**
 * A machine with no browser to launch — a headless box, an agent sandbox — must not lose
 * the server over it. The URL is already printed; the page can be opened by hand.
 */
async function openBrowser(url: string): Promise<void> {
  try {
    await open(url);
  } catch (err: unknown) {
    console.error(`inkmark: could not open a browser for ${url}:`, err);
  }
}

async function reuse(absPath: string, url: string): Promise<void> {
  console.log(`inkmark already serving ${absPath}\n  ${url}`);
  await openBrowser(url);
}

/** `bin/inkmark` only loads dist, so a child of ours runs the CLI entry point directly. */
function cliEntry(): string {
  return fileURLToPath(new URL('./index.js', import.meta.url));
}

function detachLogPath(absPath: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return join(homeDir(), 'logs', `${basename(absPath, '.md')}-${stamp}.log`);
}

/**
 * Keep the child's stdout and stderr. Thrown away, a child that dies on startup has no
 * way left to say why, and the parent has nothing to report but a timeout. Losing the
 * log is still better than not starting: the log is a diagnostic, not the feature.
 */
async function openDetachLog(logFile: string): Promise<FileHandle | undefined> {
  try {
    await mkdir(dirname(logFile), { recursive: true });
    return await fsOpen(logFile, 'a');
  } catch (err: unknown) {
    console.error(`inkmark: could not open ${logFile}; the server's output is lost:`, err);
    return undefined;
  }
}

async function spawnDetached(args: string[], logFile: string): Promise<void> {
  const log = await openDetachLog(logFile);
  try {
    const child = spawn(process.execPath, [cliEntry(), ...args], {
      detached: true,
      stdio: log === undefined ? 'ignore' : ['ignore', log.fd, log.fd],
    });
    // A failed fork or exec (EAGAIN, EMFILE, a dist/ that is not there) arrives as an
    // event, not a throw, and an unheard 'error' on a child kills the parent with an
    // unhandled exception. Wait for one or the other before claiming we started.
    await new Promise<void>((settled, failed) => {
      child.once('spawn', () => {
        child.unref();
        settled();
      });
      child.once('error', (err: Error) => {
        failed(new Error('could not spawn the detached server', { cause: err }));
      });
    });
  } finally {
    // Safe to close here: spawn duplicates the fd into the child before it returns, so
    // the child keeps writing to the file after the parent lets go.
    await log?.close();
  }
}

/**
 * What the thing at a record's URL turned out to be.
 *
 * A boolean would be cheaper and useless: every way this can fail wants a different next
 * move from the human. A refused connection means the server is gone and the record is
 * stale; a timeout means it is up but wedged; a stranger on the port means the pid is
 * almost certainly recycled too. Collapsing them leaves one message and one suggestion,
 * and that suggestion is wrong for most of the cases that produced it.
 */
export type Identity =
  | { ok: true }
  | { ok: false; why: 'unreachable' | 'timeout' | 'not-inkmark' | 'other-file' | 'bad-url' };

/** What to tell the human, and which escape hatch actually applies. */
function identityHint(rec: ServerRecord, why: Extract<Identity, { ok: false }>['why']): string {
  const port = String(rec.port);
  const gone = `  it looks gone. to drop the record: inkmark forget ${port}`;
  switch (why) {
    case 'timeout':
      return (
        `${rec.url} (pid ${String(rec.pid)}) is not responding; it may be wedged.\n` +
        `  to signal it anyway: inkmark stop ${port} --force`
      );
    case 'unreachable':
      return `nothing is listening on ${rec.url}.\n${gone}`;
    case 'not-inkmark':
      return `something other than inkmark answers on ${rec.url}.\n${gone}`;
    case 'other-file':
      return `${rec.url} is serving a different file.\n${gone}`;
    case 'bad-url':
      return `the record's url (${rec.url}) is not a usable address.\n${gone}`;
  }
}

/**
 * Whether the thing at that URL is the inkmark serving the file this record claims.
 *
 * The registry's liveness test is `kill(pid, 0)`, and the situation where that lies — the
 * process died and the OS reused its pid — is the same situation where the port comes free
 * for something else to bind. A 200 from a stranger would let `stop` SIGTERM an unrelated
 * process, which is the accident this exists to prevent.
 *
 * `/api/whoami` and not `/api/file`: the latter reads the document, so a chmod, a rename or
 * a checkout in flight would turn a healthy server into one that cannot name itself. It
 * also keeps the document off a probe. A server older than that route falls back.
 */
async function identify(rec: ServerRecord): Promise<Identity> {
  let url: URL;
  try {
    url = new URL('/api/whoami', rec.url);
  } catch {
    return { ok: false, why: 'bad-url' };
  }
  let res: Response;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
    if (res.status === 404) {
      await res.body?.cancel();
      res = await fetch(new URL('/api/file', rec.url), {
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      });
    }
  } catch (err: unknown) {
    return { ok: false, why: (err as Error).name === 'TimeoutError' ? 'timeout' : 'unreachable' };
  }
  if (!res.ok) {
    await res.body?.cancel();
    return { ok: false, why: 'not-inkmark' };
  }
  let path: unknown;
  try {
    path = ((await res.json()) as { path?: unknown }).path;
  } catch {
    return { ok: false, why: 'not-inkmark' };
  }
  if (typeof path !== 'string') return { ok: false, why: 'not-inkmark' };
  return path === rec.file ? { ok: true } : { ok: false, why: 'other-file' };
}

/**
 * Wait for the child to register itself, then print its URL and go. Opening the browser
 * and sitting on the signal handlers are the child's job, not ours.
 */
async function openDetached(absPath: string, opts: OpenOptions): Promise<number> {
  const args = ['open', absPath];
  if (opts.port !== undefined) args.push('--port', String(opts.port));
  const logFile = detachLogPath(absPath);
  try {
    await (opts.spawnChild ?? spawnDetached)(args, logFile);
  } catch (err: unknown) {
    // An unwritable log directory must read like every other CLI failure, not like a
    // crash: the caller gets a message and an exit code, not a stack trace.
    console.error(`inkmark: could not start a detached server for ${absPath}:`, err);
    return 1;
  }

  const deadline = Date.now() + (opts.detachTimeoutMs ?? DETACH_TIMEOUT_MS);
  let unreadable: unknown;
  while (Date.now() < deadline) {
    let rec: ServerRecord | undefined;
    try {
      rec = await findByFile(absPath);
    } catch (err: unknown) {
      // The registry can be briefly unreadable while the child writes into it. Failing
      // here would report "no server" for one that is coming up right now.
      unreadable = err;
    }
    if (rec !== undefined && (await (opts.probe ?? identify)(rec)).ok) {
      console.log(`inkmark serving ${absPath}\n  ${rec.url}`);
      return 0;
    }
    await delay(DETACH_POLL_MS);
  }
  // The child may still be on its way up. Killing it would turn a slow start into a
  // failure; if it does come up, `inkmark status` finds it.
  console.error(
    `inkmark: detached server for ${absPath} did not start in time\n` +
      `  see ${logFile}, and \`inkmark status\` in case it comes up late`,
  );
  if (unreadable !== undefined) console.error('  the registry could not be read:', unreadable);
  return 1;
}

/**
 * Drop the registration first: a `close()` that stalls must not be able to leave a record
 * behind for a process that is on its way out.
 */
export async function shutdownServer(server: RunningServer): Promise<void> {
  await unregister(server.port);
  try {
    await server.close();
  } catch (err: unknown) {
    console.error(`inkmark: error while closing ${server.url}:`, err);
  }
}

export async function cmdOpen(
  fileArg: string | undefined,
  opts: OpenOptions = {},
): Promise<number> {
  if (fileArg === undefined) {
    console.error(USAGE);
    return 2;
  }
  const absPath = resolve(process.cwd(), fileArg);
  if (!absPath.endsWith('.md')) {
    console.error(`not a markdown file: ${absPath}`);
    return 2;
  }
  try {
    const stats = await stat(absPath);
    if (!stats.isFile()) {
      console.error(`not a file: ${absPath}`);
      return 2;
    }
  } catch {
    console.error(`file not found: ${absPath}`);
    return 2;
  }

  const existing = await findByFile(absPath);
  if (existing !== undefined) {
    const id = await (opts.probe ?? identify)(existing);
    if (id.ok) {
      await reuse(absPath, existing.url);
      return 0;
    }
    // Neither reused nor cleared. Dropping the record and starting a second server is the
    // tempting move, and it is how one file ends up with two watchers and two PUT paths
    // every time the probe was wrong. The hint names the way out that fits what we found.
    console.error(`inkmark: ${absPath} is registered but ${identityHint(existing, id.why)}`);
    return 1;
  }

  // After the reuse check on purpose: `--detach` must not be a second way to start a
  // second server on a file that already has one.
  if (opts.detach === true) return openDetached(absPath, opts);

  const server = await listenWithRetry(absPath, opts.port ?? DEFAULT_PORT);
  try {
    await register({
      file: absPath,
      pid: process.pid,
      port: server.port,
      url: server.url,
      startedAt: new Date().toISOString(),
    });
  } catch (err: unknown) {
    await server.close();
    if (!(err instanceof AlreadyServingError)) {
      throw new Error(`failed to register ${absPath}`, { cause: err });
    }
    await reuse(absPath, err.url);
    return 0;
  }

  console.log(`inkmark serving ${absPath}\n  ${server.url}`);
  await openBrowser(server.url);

  process.on('SIGINT', () => {
    void shutdownServer(server).finally(() => {
      process.exit(0);
    });
  });
  process.on('SIGTERM', () => {
    void shutdownServer(server).finally(() => {
      process.exit(0);
    });
  });

  await (opts.wait ?? park)(server);
  return 0;
}

export async function cmdStatus(): Promise<number> {
  const live = await list();
  if (live.length === 0) {
    console.log('not running');
    return 0;
  }
  for (const s of live) {
    console.log(`${s.url}  pid ${String(s.pid)}  ${s.file}`);
  }
  return 0;
}

/** Whether the pid is gone within a short grace period. */
async function exits(pid: number): Promise<boolean> {
  for (let waited = 0; waited < EXIT_TIMEOUT_MS; waited += EXIT_POLL_MS) {
    try {
      process.kill(pid, 0);
    } catch (err: unknown) {
      // EPERM: still there, and now owned by someone else — which is its own answer.
      return (err as NodeJS.ErrnoException).code === 'ESRCH';
    }
    await delay(EXIT_POLL_MS);
  }
  return false;
}

/** Records a target names: every one, the one on a port, or the ones serving a file. */
function select(live: ServerRecord[], target?: string): ServerRecord[] {
  if (target === undefined) return live;
  if (/^\d+$/.test(target)) return live.filter((s) => s.port === Number(target));
  const absPath = resolve(process.cwd(), target);
  return live.filter((s) => s.file === absPath);
}

export async function cmdStop(target?: string, opts: StopOptions = {}): Promise<number> {
  const live = await list();
  if (live.length === 0) {
    console.log('not running');
    return 0;
  }

  const doomed = select(live, target);
  if (doomed.length === 0) {
    console.error(`no inkmark server for ${target ?? ''}. running:`);
    for (const s of live) {
      console.error(`  ${s.url}  pid ${String(s.pid)}  ${s.file}`);
    }
    return 2;
  }

  // Probed together rather than one at a time: a wedged record costs the full timeout, and
  // `inkmark stop` with several of them would otherwise add those seconds up.
  const identities =
    opts.force === true ? [] : await Promise.all(doomed.map(opts.probe ?? identify));

  let failed = false;
  for (const [i, s] of doomed.entries()) {
    const id = identities[i];
    // Asked before the signal, because `list()` only knows the pid still exists. A pid the
    // OS recycled reads as alive, and SIGTERM to it lands on whatever took the number.
    // The record stays either way — `forget` is how a record goes, and it does not signal.
    if (id !== undefined && !id.ok) {
      console.error(`inkmark: ${identityHint(s, id.why)}`);
      failed = true;
      continue;
    }
    try {
      process.kill(s.pid, 'SIGTERM');
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'ESRCH') {
        // Gone between list() and here; its record is ours to clean up. A record we
        // cannot remove is a `stop` that did not finish the job.
        if (!(await unregister(s.port))) failed = true;
        continue;
      }
      // EPERM and friends mean it is still running and still ours to report. Dropping
      // the record here would recreate exactly the orphan this registry exists to avoid.
      console.error(`could not stop ${s.url} (pid ${String(s.pid)}):`, err);
      failed = true;
      continue;
    }
    // A wedged server is exactly what `--force` is for, and it is also the server least
    // likely to run its SIGTERM handler. Reporting "stopped" because kill(2) accepted the
    // signal would send the human back to `open`, which refuses while the record lives.
    if (!(await exits(s.pid))) {
      if (opts.force !== true) {
        console.error(`inkmark: ${s.url} (pid ${String(s.pid)}) did not exit; retry with --force`);
        failed = true;
        continue;
      }
      try {
        process.kill(s.pid, 'SIGKILL');
      } catch {
        /* it may have gone in the meantime; the check below is the answer either way */
      }
      if (!(await exits(s.pid))) {
        console.error(`inkmark: ${s.url} (pid ${String(s.pid)}) survived SIGKILL; kill it by hand`);
        failed = true;
        continue;
      }
    }
    console.log(`stopped ${s.url}  ${s.file}`);
  }
  return failed ? 1 : 0;
}

/**
 * Drop a record without signalling anything.
 *
 * The counterpart to the identity check: once `stop` refuses to signal a pid it cannot
 * identify, a stale record has no other way out, and `list()` will not prune it while
 * whatever inherited the pid keeps running. Deleting the record is the right move exactly
 * when the server is gone — which is when `--force` would be at its most dangerous.
 */
export async function cmdForget(target?: string): Promise<number> {
  const live = await list();
  const doomed = select(live, target);
  if (doomed.length === 0) {
    console.error(`no inkmark record for ${target ?? ''}`);
    return 2;
  }
  let failed = false;
  for (const s of doomed) {
    if (await unregister(s.port)) console.log(`forgot ${s.url}  ${s.file}`);
    else failed = true;
  }
  return failed ? 1 : 0;
}

export function parsePort(argv: string[]): number | undefined | 'invalid' {
  const i = argv.indexOf('--port');
  if (i === -1) return undefined;
  const raw = argv[i + 1];
  if (raw === undefined) return 'invalid';
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return 'invalid';
  return port;
}

/** Flags that take no value, and so must not be mistaken for the file argument. */
const VALUELESS_FLAGS = new Set(['--detach', '--force']);

/** `opts` is the test seam `cmdOpen` and `cmdStop` take; the CLI itself passes nothing. */
export async function main(argv: string[], opts: OpenOptions = {}): Promise<number> {
  const positional = argv.filter(
    (a, i) => a !== '--port' && argv[i - 1] !== '--port' && !VALUELESS_FLAGS.has(a),
  );
  const cmd = positional[0];
  const arg = positional[1];
  const detach = argv.includes('--detach');
  const force = argv.includes('--force');
  const port = parsePort(argv);
  if (port === 'invalid') {
    console.error(USAGE);
    return 2;
  }

  switch (cmd) {
    case undefined:
      console.error(USAGE);
      return 2;
    case 'open':
      // Same reasoning as the two below, from the other side: `--force` says something
      // about stopping a server, and `open` would only ignore it.
      if (force) {
        console.error('--force is only valid for `stop`.');
        return 2;
      }
      return cmdOpen(arg, { ...opts, ...(port === undefined ? {} : { port }), detach });
    case 'status':
    case 'stop':
    case 'forget':
      // Only `open` binds a port. Silently ignoring it here would turn
      // `inkmark stop --port 4801` into `inkmark stop`, which stops everything.
      if (port !== undefined) {
        console.error(
          `--port is only valid for \`open\`. To stop one server: inkmark stop ${String(port)}`,
        );
        return 2;
      }
      // Same reasoning: swallowed, `--detach` would read as "it ran detached" when it did
      // not run at all the way the caller meant.
      if (detach) {
        console.error('--detach is only valid for `open`.');
        return 2;
      }
      if (force && cmd !== 'stop') {
        console.error('--force is only valid for `stop`.');
        return 2;
      }
      // Aimed, never broadcast. `--force` skips the check that keeps a signal off an
      // unrelated pid, and applying that to every record at once is the one shape of this
      // command with no way to see what it is about to hit.
      if (force && arg === undefined) {
        console.error('--force needs a file or a port: inkmark stop <file.md|port> --force');
        return 2;
      }
      if (cmd === 'status') return cmdStatus();
      if (cmd === 'forget') return cmdForget(arg);
      return cmdStop(arg, { force, ...(opts.probe === undefined ? {} : { probe: opts.probe }) });
    default:
      console.error(USAGE);
      return 2;
  }
}
