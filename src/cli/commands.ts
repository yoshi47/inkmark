import { stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import open from 'open';
import { type RunningServer, startServer } from '../server/start.js';
import { findFreePort } from './port.js';
import { AlreadyServingError, findByFile, list, register, unregister } from './registry.js';

const DEFAULT_PORT = 4747;
const USAGE = `usage: inkmark open <file.md> [--port <n>]
       inkmark status
       inkmark stop [file.md|port]`;

export interface OpenOptions {
  port?: number;
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

function reuse(absPath: string, url: string): Promise<unknown> {
  console.log(`inkmark already serving ${absPath}\n  ${url}`);
  return open(url);
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
  await open(server.url);

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
        // Gone between list() and here; its record is ours to clean up.
        await unregister(s.port);
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

export async function main(argv: string[]): Promise<number> {
  const positional = argv.filter((a, i) => a !== '--port' && argv[i - 1] !== '--port');
  const cmd = positional[0];
  const arg = positional[1];
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
      return cmdOpen(arg, port === undefined ? {} : { port });
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
      return cmd === 'status' ? cmdStatus() : cmdStop(arg);
    default:
      console.error(USAGE);
      return 2;
  }
}
