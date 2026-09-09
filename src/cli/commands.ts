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
const USAGE = `usage: inkmark open <file.md> [--port <n>] [--detach]
       inkmark status
       inkmark stop [file.md|port]`;

export interface OpenOptions {
  port?: number;
  detach?: boolean;
  /** Overridable so tests do not have to spawn the real CLI. */
  spawnChild?: (args: string[], logFile: string) => void | Promise<void>;
  /** Overridable so the "child never registered" test does not wait the full timeout. */
  detachTimeoutMs?: number;
  /** Overridable so tests can take the server and return instead of parking forever. */
  wait?: (server: RunningServer) => Promise<void>;
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
 * A registry record only says a pid is alive, so a child that registered and then died
 * would hand the human a URL that refuses connections. Ask the port itself.
 */
async function answers(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
    await res.body?.cancel();
    return res.ok;
  } catch {
    return false;
  }
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
    if (rec !== undefined && (await answers(rec.url))) {
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
    await reuse(absPath, existing.url);
    return 0;
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

export async function cmdStop(target?: string): Promise<number> {
  const live = await list();
  if (live.length === 0) {
    console.log('not running');
    return 0;
  }

  let doomed: typeof live;
  if (target === undefined) {
    doomed = live;
  } else if (/^\d+$/.test(target)) {
    const port = Number(target);
    doomed = live.filter((s) => s.port === port);
  } else {
    const absPath = resolve(process.cwd(), target);
    doomed = live.filter((s) => s.file === absPath);
  }

  if (doomed.length === 0) {
    console.error(`no inkmark server for ${target ?? ''}. running:`);
    for (const s of live) {
      console.error(`  ${s.url}  pid ${String(s.pid)}  ${s.file}`);
    }
    return 2;
  }

  let failed = false;
  for (const s of doomed) {
    try {
      process.kill(s.pid, 'SIGTERM');
      console.log(`stopped ${s.url}  ${s.file}`);
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
    }
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
const VALUELESS_FLAGS = new Set(['--detach']);

/** `opts` is the same test seam `cmdOpen` takes; the CLI itself passes nothing. */
export async function main(argv: string[], opts: OpenOptions = {}): Promise<number> {
  const positional = argv.filter(
    (a, i) => a !== '--port' && argv[i - 1] !== '--port' && !VALUELESS_FLAGS.has(a),
  );
  const cmd = positional[0];
  const arg = positional[1];
  const detach = argv.includes('--detach');
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
      return cmdOpen(arg, { ...opts, ...(port === undefined ? {} : { port }), detach });
    case 'status':
    case 'stop':
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
      return cmd === 'status' ? cmdStatus() : cmdStop(arg);
    default:
      console.error(USAGE);
      return 2;
  }
}
